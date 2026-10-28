/**
 * Node/Server Bundle Builder (`src/exporters/node-bundle-builder.ts`)
 *
 * Uses `sharp` + CPU triangle scanline rasterizer to generate:
 * 1. Real alpha-contour Delaunay meshes from part PNG/WebP files
 * 2. Packed `<id>.png` / `<id>.atlas.png` texture atlas
 * 3. Spine 4.2 `<id>.spine.json` + `<id>.atlas.txt`
 * 4. Zero-dependency Unity `<id>.sfrig.json`
 * 5. Baked Flipbook Sprite Sheet `<id>-sheet.png` + `<id>.sprites.json`
 * 6. Complete `.zip` archive for 1-click download in the Studio UI
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolveInside } from "../server/safe-paths";
import path from "node:path";
import JSZip from "jszip";
import sharp, { type OverlayOptions } from "sharp";
import { SpineForgeAnimator } from "../core/animator";
import type { PartMeshData, SpineForgeProject } from "../core/schema";
import { deformMeshVerticesCPU } from "../core/solver";
import { buildPartMesh } from "../core/weights";
import { computeAtlasLayout, type AtlasInputRegion } from "./atlas-packer";
import { exportSpine42Json } from "./spine42-exporter";
import { buildSpriteSheetManifest } from "./spritesheet-exporter";
import { exportUnityCustomRig } from "./unity-custom-exporter";

type DecodedPartImage = {
  name: string;
  width: number;
  height: number;
  rgba: Uint8Array;
  pngBuffer: Buffer;
};

/**
 * Software barycentric triangle rasterizer that renders a deformed `PartMeshData` onto an RGBA target buffer.
 * Enables 100% deterministic headless sprite-sheet baking in Node.js without requiring a GPU window.
 */
function rasterizeDeformedMeshToBuffer(
  targetRgba: Uint8Array,
  targetW: number,
  targetH: number,
  mesh: PartMeshData,
  deformedPositions: Float32Array,
  srcRgba: Uint8Array,
  srcW: number,
  srcH: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  flash: number,
): void {
  const indices = mesh.indices;
  const uvs = mesh.uvs;

  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t]!;
    const i1 = indices[t + 1]!;
    const i2 = indices[t + 2]!;

    const x0 = deformedPositions[i0 * 2]! * scale + offsetX;
    const y0 = deformedPositions[i0 * 2 + 1]! * scale + offsetY;
    const x1 = deformedPositions[i1 * 2]! * scale + offsetX;
    const y1 = deformedPositions[i1 * 2 + 1]! * scale + offsetY;
    const x2 = deformedPositions[i2 * 2]! * scale + offsetX;
    const y2 = deformedPositions[i2 * 2 + 1]! * scale + offsetY;

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(targetW - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(targetH - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) continue;

    const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(denom) < 1e-6) continue;
    const invDenom = 1 / denom;

    const u0 = uvs[i0 * 2]!;
    const v0 = uvs[i0 * 2 + 1]!;
    const u1 = uvs[i1 * 2]!;
    const v1 = uvs[i1 * 2 + 1]!;
    const u2 = uvs[i2 * 2]!;
    const v2 = uvs[i2 * 2 + 1]!;

    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const w0 = ((y1 - y2) * (cx - x2) + (x2 - x1) * (cy - y2)) * invDenom;
        if (w0 < -1e-4) continue;
        const w1 = ((y2 - y0) * (cx - x2) + (x0 - x2) * (cy - y2)) * invDenom;
        if (w1 < -1e-4) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < -1e-4) continue;

        const u = Math.max(0, Math.min(1, w0 * u0 + w1 * u1 + w2 * u2));
        const v = Math.max(0, Math.min(1, w0 * v0 + w1 * v1 + w2 * v2));
        const tx = Math.min(srcW - 1, Math.round(u * (srcW - 1)));
        const ty = Math.min(srcH - 1, Math.round(v * (srcH - 1)));
        const srcIdx = (ty * srcW + tx) * 4;

        const sa = srcRgba[srcIdx + 3]!;
        if (sa < 2) continue;

        const alphaNorm = sa / 255;
        const flashBoost = 1 + flash * 0.35;
        const sr = Math.min(255, srcRgba[srcIdx]! * flashBoost);
        const sg = Math.min(255, srcRgba[srcIdx + 1]! * flashBoost);
        const sb = Math.min(255, srcRgba[srcIdx + 2]! * flashBoost);

        const dstIdx = (py * targetW + px) * 4;
        const da = targetRgba[dstIdx + 3]! / 255;
        const outA = alphaNorm + da * (1 - alphaNorm);
        if (outA > 1e-5) {
          targetRgba[dstIdx] = Math.round((sr * alphaNorm + targetRgba[dstIdx]! * da * (1 - alphaNorm)) / outA);
          targetRgba[dstIdx + 1] = Math.round(
            (sg * alphaNorm + targetRgba[dstIdx + 1]! * da * (1 - alphaNorm)) / outA,
          );
          targetRgba[dstIdx + 2] = Math.round(
            (sb * alphaNorm + targetRgba[dstIdx + 2]! * da * (1 - alphaNorm)) / outA,
          );
          targetRgba[dstIdx + 3] = Math.round(outA * 255);
        }
      }
    }
  }
}

export type ExportBundleResult = {
  id: string;
  outDir?: string;
  atlasPng: Buffer;
  spineJson: string;
  spineAtlasTxt: string;
  unitySfRigJson: string;
  spriteSheetPng: Buffer;
  spriteSheetJson: string;
  zipBuffer: Buffer;
};

export async function buildCompleteUnityExportBundle(
  project: SpineForgeProject,
  options: {
    publicRoot?: string;
    outDir?: string;
    sheetCellHeight?: number;
    sheetFps?: number;
    useAlphaContourMeshes?: boolean;
  } = {},
): Promise<ExportBundleResult> {
  const publicRoot = options.publicRoot ?? path.join(process.cwd(), "public");
  const decodedParts = new Map<string, DecodedPartImage>();
  const atlasInputs: AtlasInputRegion[] = [];

  for (const part of project.parts) {
    // Part images must live inside public/; a crafted `src` like "../../x" is rejected.
    const filePath = resolveInside(publicRoot, part.src);
    let rgba: Uint8Array;
    let width = Math.max(16, Math.round(part.w * project.width));
    let height = Math.max(16, Math.round(part.h * project.height));
    let pngBuffer: Buffer;

    if (existsSync(filePath)) {
      const img = sharp(filePath).ensureAlpha();
      const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
      width = info.width;
      height = info.height;
      rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      pngBuffer = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
    } else {
      // Synthesize a clean opaque test part if running with synthetic paths
      rgba = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = 90;
        rgba[i * 4 + 1] = 175;
        rgba[i * 4 + 2] = 245;
        rgba[i * 4 + 3] = 255;
      }
      pngBuffer = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer();
    }

    if (options.useAlphaContourMeshes !== false && !part.mesh) {
      const alphaChannel = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) {
        alphaChannel[i] = rgba[i * 4 + 3]!;
      }
      part.mesh = buildPartMesh(project, part, {
        alphaMask: { data: alphaChannel, width, height, threshold: 10, dilatePx: 4 },
        columns: 28,
        weightMode: "hybrid",
      });
    } else if (!part.mesh) {
      part.mesh = buildPartMesh(project, part, { columns: 28, weightMode: "hybrid" });
    }

    decodedParts.set(part.name, { name: part.name, width, height, rgba, pngBuffer });
    atlasInputs.push({ name: part.name, width, height, buffer: pngBuffer });
  }

  // 1. Pack texture atlas
  const atlasPageName = `${project.id}.png`;
  const atlasLayout = computeAtlasLayout(atlasPageName, atlasInputs, 4);

  const composites: OverlayOptions[] = [];
  for (const item of atlasInputs) {
    const reg = atlasLayout.regions[item.name];
    if (reg && item.buffer) {
      composites.push({
        input: item.buffer,
        left: reg.x,
        top: reg.y,
      });
    }
  }

  const atlasPng = await sharp({
    create: {
      width: atlasLayout.width,
      height: atlasLayout.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  // 2. Generate Spine 4.2 JSON and Unity Custom .sfrig.json
  const spineDoc = exportSpine42Json(project, { physics: "native", sampleRateHz: 24 });
  const spineJson = JSON.stringify(spineDoc, null, 2);
  const spineAtlasTxt = atlasLayout.spineAtlasText;

  const unitySfRigDoc = exportUnityCustomRig(project, atlasLayout, { pixelsPerUnit: 100, sampleRateHz: 24 });
  const unitySfRigJson = JSON.stringify(unitySfRigDoc, null, 2);

  // 3. Bake Flipbook Sprite Sheet (Accelerate via Apple Metal GPU CLI when available on macOS, fallback to software rasterizer)
  const sheetManifest = buildSpriteSheetManifest(project, {
    cellHeight: options.sheetCellHeight ?? 192,
    columns: 8,
    fps: options.sheetFps ?? 8,
  });

  const metalCliCandidates = [
    path.join(process.cwd(), "SpineForge.app/Contents/MacOS/spineforge-metal-cli"),
    path.join(process.cwd(), "macos-metal/.build/release/spineforge-metal-cli"),
  ];
  const metalCli = metalCliCandidates.find((p) => existsSync(p));
  let spriteSheetPng: Buffer | null = null;

  if (metalCli) {
    try {
      const tmpDir = options.outDir ?? path.join(process.cwd(), "exports", project.id);
      mkdirSync(tmpDir, { recursive: true });
      const tmpProjPath = path.join(tmpDir, `${project.id}.project.json`);
      const tmpSheetPath = path.join(tmpDir, `${project.id}-sheet.png`);
      writeFileSync(tmpProjPath, JSON.stringify(project, null, 2));
      execFileSync(
        metalCli,
        [
          "bake-sheet",
          tmpProjPath,
          publicRoot,
          tmpSheetPath,
          String(options.sheetCellHeight ?? 192),
          String(options.sheetFps ?? 8),
        ],
        { stdio: "pipe" },
      );
      if (existsSync(tmpSheetPath)) {
        spriteSheetPng = readFileSync(tmpSheetPath);
      }
    } catch {
      spriteSheetPng = null;
    }
  }

  if (!spriteSheetPng) {
    const sheetRgba = new Uint8Array(sheetManifest.sheetWidth * sheetManifest.sheetHeight * 4);
    const animator = new SpineForgeAnimator(project, "idle");

    const spanW = project.width * (1 + (project.frame.left ?? 0.25) + (project.frame.right ?? 0.25));
    const spanH = project.height * (1 + (project.frame.top ?? 0.2) + (project.frame.bottom ?? 0.05));
    const scale = Math.min(sheetManifest.cellWidth / spanW, sheetManifest.cellHeight / spanH);
    const localOriginX =
      (sheetManifest.cellWidth - spanW * scale) / 2 + (project.frame.left ?? 0.25) * project.width * scale;
    const localOriginY =
      (sheetManifest.cellHeight - spanH * scale) / 2 + (project.frame.top ?? 0.2) * project.height * scale;

    for (const frameMeta of sheetManifest.frames) {
      animator.setClip(frameMeta.clip);
      const evaluated = animator.evaluateAt(frameMeta.time, 1 / 24);
      for (const partName of evaluated.order) {
        const part = project.parts.find((p) => p.name === partName);
        const decoded = decodedParts.get(partName);
        if (!part || !part.mesh || !decoded) continue;
        const deformed = deformMeshVerticesCPU(part.mesh, evaluated.skin, evaluated.deforms[partName]);
        rasterizeDeformedMeshToBuffer(
          sheetRgba,
          sheetManifest.sheetWidth,
          sheetManifest.sheetHeight,
          part.mesh,
          deformed,
          decoded.rgba,
          decoded.width,
          decoded.height,
          scale,
          frameMeta.x + localOriginX,
          frameMeta.y + localOriginY,
          evaluated.fx.flash,
        );
      }
    }

    spriteSheetPng = await sharp(Buffer.from(sheetRgba), {
      raw: {
        width: sheetManifest.sheetWidth,
        height: sheetManifest.sheetHeight,
        channels: 4,
      },
    })
      .png()
      .toBuffer();
  }

  const spriteSheetJson = JSON.stringify(sheetManifest, null, 2);

  // 4. Write to disk if outDir is provided
  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(path.join(options.outDir, `${project.id}.png`), atlasPng);
    writeFileSync(path.join(options.outDir, `${project.id}.atlas.txt`), spineAtlasTxt);
    writeFileSync(path.join(options.outDir, `${project.id}.spine.json`), spineJson);
    writeFileSync(path.join(options.outDir, `${project.id}.sfrig.json`), unitySfRigJson);
    writeFileSync(path.join(options.outDir, `${project.id}-sheet.png`), spriteSheetPng);
    writeFileSync(path.join(options.outDir, `${project.id}.sprites.json`), spriteSheetJson);
    writeFileSync(path.join(options.outDir, `${project.id}.project.json`), JSON.stringify(project, null, 2));
  }

  // 5. Build complete ZIP archive
  const zip = new JSZip();
  const spineFolder = zip.folder("spine-4.2")!;
  spineFolder.file(`${project.id}.json`, spineJson);
  spineFolder.file(`${project.id}.atlas.txt`, spineAtlasTxt);
  spineFolder.file(`${project.id}.png`, atlasPng);

  const unityFolder = zip.folder("unity-spineforge-runtime")!;
  unityFolder.file(`${project.id}.sfrig.json`, unitySfRigJson);
  unityFolder.file(`${project.id}.png`, atlasPng);

  const sheetFolder = zip.folder("unity-spritesheet")!;
  sheetFolder.file(`${project.id}-sheet.png`, spriteSheetPng);
  sheetFolder.file(`${project.id}.sprites.json`, spriteSheetJson);

  zip.file(`${project.id}.project.json`, JSON.stringify(project, null, 2));
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return {
    id: project.id,
    outDir: options.outDir,
    atlasPng,
    spineJson,
    spineAtlasTxt,
    unitySfRigJson,
    spriteSheetPng,
    spriteSheetJson,
    zipBuffer,
  };
}
