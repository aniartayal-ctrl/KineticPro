/**
 * Zero-Dependency In-Browser Unity & Spine 4.2 Bundle Builder (`src/exporters/browser-bundle-builder.ts`)
 *
 * Allows the WebGL2 Studio to build the complete 3-Way Unity + Spine 4.2 + Flipbook Sprite Sheet + .ZIP
 * bundle 100% client-side in the browser (using HTML5 Canvas + JSZip + MaxRectsPacker) whenever no
 * Node.js backend server is running (e.g., when opened from a static GitHub download).
 */

import JSZip from "jszip";
import type { SpineForgeProject } from "@/core/schema";
import { computeAtlasLayout, type AtlasInputRegion } from "./atlas-packer";
import { exportSpine42Json } from "./spine42-exporter";
import { buildSpriteSheetManifest } from "./spritesheet-exporter";
import { exportUnityCustomRig } from "./unity-custom-exporter";
import type { ExportBundlePreviewData } from "@/components/LeftToolOptionsPane";

async function loadImageElement(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function buildBrowserUnityExportBundle(
  project: SpineForgeProject,
): Promise<ExportBundlePreviewData> {
  const loadedImages = new Map<string, HTMLImageElement>();
  const atlasInputs: AtlasInputRegion[] = [];

  for (const part of project.parts) {
    const img = await loadImageElement(part.src);
    const w = img ? img.naturalWidth || img.width : Math.max(16, Math.round(part.w * project.width));
    const h = img ? img.naturalHeight || img.height : Math.max(16, Math.round(part.h * project.height));
    if (img) loadedImages.set(part.name, img);
    atlasInputs.push({ name: part.name, width: w, height: h });
  }

  // 1. Pack texture atlas on HTML5 Canvas
  const atlasPageName = `${project.id}.png`;
  const atlasLayout = computeAtlasLayout(atlasPageName, atlasInputs, 4);

  const atlasCanvas = document.createElement("canvas");
  atlasCanvas.width = atlasLayout.width;
  atlasCanvas.height = atlasLayout.height;
  const actx = atlasCanvas.getContext("2d")!;
  for (const part of project.parts) {
    const reg = atlasLayout.regions[part.name];
    const img = loadedImages.get(part.name);
    if (reg && img) {
      actx.drawImage(img, reg.x, reg.y, reg.width, reg.height);
    }
  }
  const atlasDataUrl = atlasCanvas.toDataURL("image/png");

  // 2. Build Spine 4.2 JSON & Unity .sfrig.json
  const spineJson = JSON.stringify(exportSpine42Json(project, { physics: "native", sampleRateHz: 24 }), null, 2);
  const spineAtlasTxt = atlasLayout.spineAtlasText;
  const unitySfRigJson = JSON.stringify(
    exportUnityCustomRig(project, atlasLayout, { pixelsPerUnit: 100, sampleRateHz: 24 }),
    null,
    2,
  );

  // 3. Build Flipbook Sprite Sheet Manifest & Canvas
  const sheetManifest = buildSpriteSheetManifest(project, {
    cellHeight: 192,
    columns: 8,
    fps: 8,
  });
  const spriteSheetJson = JSON.stringify(sheetManifest, null, 2);

  const sheetCanvas = document.createElement("canvas");
  sheetCanvas.width = Math.min(2048, sheetManifest.sheetWidth);
  sheetCanvas.height = Math.min(2048, sheetManifest.sheetHeight);
  const sctx = sheetCanvas.getContext("2d")!;
  const liveGlCanvas = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (liveGlCanvas) {
    for (let i = 0; i < Math.min(16, sheetManifest.frames.length); i++) {
      const f = sheetManifest.frames[i]!;
      if (f.x + f.w <= sheetCanvas.width && f.y + f.h <= sheetCanvas.height) {
        sctx.drawImage(liveGlCanvas, f.x, f.y, f.w, f.h);
      }
    }
  }
  const spriteSheetDataUrl = sheetCanvas.toDataURL("image/png");

  // 4. Package ZIP in-memory
  const zip = new JSZip();
  const atlasBytes = dataUrlToUint8Array(atlasDataUrl);
  const sheetBytes = dataUrlToUint8Array(spriteSheetDataUrl);

  const spineFolder = zip.folder("spine-4.2")!;
  spineFolder.file(`${project.id}.json`, spineJson);
  spineFolder.file(`${project.id}.atlas.txt`, spineAtlasTxt);
  spineFolder.file(`${project.id}.png`, atlasBytes);

  const unityFolder = zip.folder("unity-spineforge-runtime")!;
  unityFolder.file(`${project.id}.sfrig.json`, unitySfRigJson);
  unityFolder.file(`${project.id}.png`, atlasBytes);

  const sheetFolder = zip.folder("unity-spritesheet")!;
  sheetFolder.file(`${project.id}-sheet.png`, sheetBytes);
  sheetFolder.file(`${project.id}.sprites.json`, spriteSheetJson);

  zip.file(`${project.id}.project.json`, JSON.stringify(project, null, 2));
  const zipBase64 = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });

  return {
    id: project.id,
    atlasDataUrl,
    spriteSheetDataUrl,
    spineJson,
    spineAtlasTxt,
    unitySfRigJson,
    spriteSheetJson,
    zipBase64,
  };
}
