import assert from "node:assert/strict";
import test from "node:test";
import { autoRigProject } from "../core/auto-rigger";
import { generateBatch8SymbolPack } from "../core/batch-symbols";
import { applyVoiceLipSyncToClip, compute25DParallaxBoneOffsets } from "../core/parallax-and-lipsync";
import { runFullAutoModePipeline } from "../core/physics-and-principles";
import { BUILTIN_PRESETS } from "../core/presets";
import { validateProject } from "../core/schema";
import { evaluateElementalVfx, generateUnity2DColliders, profileProjectForUnityMobile } from "../core/vfx-colliders-profiler";
import { paintFfdLiquifyStroke } from "../core/weights";
import { buildCompleteUnityExportBundle } from "./node-bundle-builder";
import type { Spine42Json } from "./spine42-exporter";
import type { UnitySpriteSheetManifest } from "./spritesheet-exporter";
import type { UnitySfRigDocument } from "./unity-custom-exporter";

test("Triple Export Engine produces valid Spine 4.2 JSON+Atlas, Unity .sfrig.json, and Baked Sprite Sheet", async () => {
  const project = BUILTIN_PRESETS["astral-forge"]!();
  const bundle = await buildCompleteUnityExportBundle(project, {
    sheetCellHeight: 128,
    sheetFps: 6,
  });

  // 1. Verify Atlas PNG
  assert.ok(bundle.atlasPng.byteLength > 1000, "Atlas PNG should be non-empty");
  assert.ok(bundle.spineAtlasTxt.includes("astral-forge.png"), "Spine .atlas.txt should reference page");
  assert.ok(bundle.spineAtlasTxt.includes("hammer"), "Spine .atlas.txt should include hammer region");

  // 2. Verify Spine 4.2 JSON structure and weighted vertex invariants
  const spine = JSON.parse(bundle.spineJson) as Spine42Json;
  assert.equal(spine.skeleton.spine, "4.2.0");
  assert.equal(spine.bones[0]?.name, "root");
  assert.equal(spine.bones.length, project.bones.length);
  assert.equal(spine.slots.length, project.parts.length);

  const bodyAttachment = spine.skins[0]?.attachments["body"]?.["body"];
  assert.ok(bodyAttachment, "Spine default skin must contain weighted body mesh attachment");
  assert.equal(bodyAttachment.type, "mesh");
  assert.ok(bodyAttachment.hull >= 4, "Hull count must be >= 4");
  assert.ok(bodyAttachment.triangles.length > 0 && bodyAttachment.triangles.length % 3 === 0);

  // Verify weighted vertex array parses cleanly: [boneCount, b0, x0, y0, w0, ...]
  const verts = bodyAttachment.vertices;
  const expectedVertexCount = bodyAttachment.uvs.length / 2;
  let cursor = 0;
  let parsedVerts = 0;
  while (cursor < verts.length) {
    const boneCount = verts[cursor++]!;
    assert.ok(boneCount >= 1 && boneCount <= 4, `Invalid boneCount ${boneCount}`);
    let weightSum = 0;
    for (let k = 0; k < boneCount; k++) {
      const bIdx = verts[cursor++]!;
      const lx = verts[cursor++]!;
      const ly = verts[cursor++]!;
      const w = verts[cursor++]!;
      assert.ok(bIdx >= 0 && bIdx < spine.bones.length);
      assert.ok(Number.isFinite(lx) && Number.isFinite(ly));
      weightSum += w;
    }
    assert.ok(Math.abs(weightSum - 1) < 1e-2, `Spine vertex weight sum ${weightSum} != 1`);
    parsedVerts++;
  }
  assert.equal(parsedVerts, expectedVertexCount, "Spine weighted vertex stream must match UV vertex count");

  // 3. Verify Unity Custom .sfrig.json
  const sfrig = JSON.parse(bundle.unitySfRigJson) as UnitySfRigDocument;
  assert.equal(sfrig.format, "SpineForgeUnityRig");
  assert.equal(sfrig.bones.length, project.bones.length);
  assert.equal(sfrig.submeshes.length, project.parts.length);
  assert.equal(sfrig.animations.length, 14);

  for (const sub of sfrig.submeshes) {
    const vCount = sub.vertices.length / 2;
    assert.equal(sub.uvs.length, vCount * 2);
    assert.equal(sub.boneIndices.length, vCount * 4);
    assert.equal(sub.boneWeights.length, vCount * 4);
    for (const uv of sub.uvs) {
      assert.ok(uv >= 0 && uv <= 1, `Atlas UV ${uv} out of [0, 1] bounds`);
    }
  }

  // 4. Verify Baked Flipbook Sprite Sheet
  assert.ok(bundle.spriteSheetPng.byteLength > 1000, "Sprite sheet PNG should be non-empty");
  const sheetMeta = JSON.parse(bundle.spriteSheetJson) as UnitySpriteSheetManifest;
  assert.equal(sheetMeta.format, "SpineForgeSpriteSheet");
  assert.equal(sheetMeta.clips.length, 14);
  assert.ok(sheetMeta.frames.length >= 24);
  assert.ok(bundle.zipBuffer.byteLength > 2000, "ZIP bundle should be generated");

  // 5. Verify Multi-Skin Wardrobe & AnimationEvent triggers in Spine 4.2 and Unity .sfrig.json
  assert.equal(spine.skins[0]?.name, "default", "Spine setup attachments must live in the default skin");
  assert.equal(spine.skins.length, 1 + project.skins!.filter((s) => s.name !== "default").length, "Spine 4.2 should export each skin tier");
  assert.equal(sfrig.skins.length, 3, "Unity .sfrig.json should export all 3 skin tiers");
  assert.ok(spine.events && "OnHit" in spine.events, "Spine 4.2 should export OnHit event catalog");
  const strikeClipUnity = sfrig.animations.find((a) => a.name === "strike");
  assert.ok(strikeClipUnity && strikeClipUnity.events.length >= 2, "Unity strike clip should include AnimationEvents");
});

test("1-Click AI Auto-Rigger and Liquify FFD Warp Brush produce valid rigs and vertex offsets", () => {
  const base = BUILTIN_PRESETS["sands-of-solara"]!();
  const rigged = autoRigProject(base, undefined, { meshDensity: "high", weightMode: "hybrid" });
  assert.deepEqual(validateProject(rigged), []);
  assert.ok(rigged.bones.length >= 10);

  const bodyPart = rigged.parts.find((p) => p.name === "body")!;
  assert.ok(bodyPart.mesh);
  const offsets = paintFfdLiquifyStroke(bodyPart.mesh, undefined, {
    x: 0.35 * rigged.width,
    y: 0.45 * rigged.height,
    dx: 18,
    dy: -12,
    radius: 90,
    strength: 0.65,
    mode: "push",
  });
  assert.equal(offsets.length, bodyPart.mesh.positions.length);
  assert.ok(offsets.some((val) => Math.abs(val) > 0.5), "Liquify push stroke must displace vertices inside radius");

  // Verify Visual Physics Inference & 1-Click Auto Mode Pipeline
  const { project: autoShipped, physicsReport } = runFullAutoModePipeline(base, {
    archetype: "auto_detect",
    principles: {
      squashAndStretch: 1.2,
      anticipation: 1.15,
      followThroughOverlap: 1.1,
      arcsAndEasing: 1.0,
      secondaryAndAppeal: 1.0,
      exaggeration: 1.15,
    },
  });
  assert.equal(physicsReport.inferredArchetype, "olympus_caster");
  assert.ok(physicsReport.springBonesConfigured.length >= 2);
  assert.equal(Object.keys(autoShipped.animations).length, 14);
  assert.ok(autoShipped.animations["zeus-bolt"]);
  assert.ok(autoShipped.animations["symbol-win"]);
  assert.ok(autoShipped.animations["chest-open"]);

  // Verify 2.5D Parallax, Voice Lip-Sync, Elemental VFX, Unity Colliders, Mobile VRAM Profiler & Batch 8-Symbols
  const parallaxOffsets = compute25DParallaxBoneOffsets(autoShipped, {
    enabled: true,
    lookX: 0.75,
    lookY: -0.35,
    depthIntensity: 1.0,
    autoOrbit: false,
  }, 0.5);
  assert.ok((parallaxOffsets["head"]?.x ?? 0) > 0, "Head shifts right when looking right");
  assert.ok((parallaxOffsets["arm-back"]?.x ?? 0) < 0, "Back arm shifts in inverse parallax");

  const lipSynced = applyVoiceLipSyncToClip(autoShipped, autoShipped.animations.strike!, "battle_cry");
  assert.ok((lipSynced.boneTracks["head"]?.length ?? 0) >= 12);

  const vfxPrims = evaluateElementalVfx(autoShipped, "lightning_bolts", 0.5, [300, 400], [320, 1000]);
  assert.equal(vfxPrims.length, 3);

  const colliders = generateUnity2DColliders(autoShipped, 100);
  assert.equal(colliders.length, autoShipped.parts.length);
  assert.ok(colliders.some((c) => c.role === "hitbox_weapon"));

  const vramReport = profileProjectForUnityMobile(autoShipped, 0.5);
  assert.equal(vramReport.batchedDrawCalls, 1);
  assert.ok(vramReport.astcCompressedVramMB < vramReport.uncompressedVramMB);

  const symbolPack = generateBatch8SymbolPack("astral-forge");
  assert.equal(symbolPack.length, 8);
  assert.deepEqual(validateProject(symbolPack[0]!), []);
});

test("Spine 4.2 native export keeps easing curves, physics and transform constraints", async () => {
  const { exportSpine42, toSpineCurve, springToSpinePhysics } = await import("./spine42-exporter");
  const project = BUILTIN_PRESETS["astral-forge"]!();

  // Curve conversion: normalized bezier → absolute Spine time/value handles per channel
  assert.equal(toSpineCurve("linear", 0, 1, [0], [10]), undefined);
  assert.equal(toSpineCurve("stepped", 0, 1, [0], [10]), "stepped");
  assert.deepEqual(toSpineCurve([0.25, 0, 0.75, 1], 1, 3, [0, 100], [10, 0]), [1.5, 0, 2.5, 10, 1.5, 100, 2.5, 0]);

  const { json, warnings } = exportSpine42(project, { physics: "native" });
  const springBones = project.bones.filter((b) => b.spring);
  const followBones = project.bones.filter((b) => b.follow);
  assert.equal(json.physics?.length ?? 0, springBones.length, "every spring bone becomes a physics constraint");
  assert.equal(json.transform?.length ?? 0, followBones.length, "every follow bone becomes a transform constraint");
  for (const p of json.physics ?? []) {
    assert.ok(p.damping > 0 && p.damping <= 1 && p.inertia > 0 && p.inertia <= 1 && p.strength > 0);
  }
  const orders = [...(json.ik ?? []), ...(json.transform ?? []), ...(json.physics ?? [])].map((c) => c.order);
  assert.equal(new Set(orders).size, orders.length, "constraint orders must be unique");
  assert.ok(Array.isArray(warnings));

  // Authored eased keys must survive as Spine curves somewhere in the idle clip
  const idle = json.animations["idle"]!;
  const anyCurve = Object.values(idle.bones ?? {}).some((t) => t.rotate?.some((k) => Array.isArray(k.curve)));
  assert.ok(anyCurve, "eased idle keys should export Spine bezier curves");

  // Native export is much smaller than per-frame baking
  const baked = exportSpine42(project, { physics: "bake" }).json;
  assert.ok(JSON.stringify(json).length < JSON.stringify(baked).length, "native export should be lighter than baked");
  assert.ok((baked.ik ?? []).every((c) => c.mix === 0), "bake mode must not apply IK twice");
  assert.equal(baked.physics, undefined);

  const phys = springToSpinePhysics({ stiffness: 60, damping: 6, gain: [6, 8] });
  assert.equal(phys.inertia, 1);
  assert.ok(Math.abs(phys.damping - Math.exp(-0.1)) < 1e-3);
});

test("Spine weighted-mesh deform keys expand to one offset per bone influence", async () => {
  const { exportSpine42 } = await import("./spine42-exporter");
  const project = BUILTIN_PRESETS["astral-forge"]!();
  const part = project.parts.find((p) => (p.skin?.length ?? 0) > 1)!;
  const { json: before } = exportSpine42(project);
  const att = before.skins[0]!.attachments[part.name]![part.name]!;
  let influences = 0;
  for (let c = 0; c < att.vertices.length; ) {
    const n = att.vertices[c]!;
    influences += n;
    c += 1 + n * 4;
  }
  const vCount = att.uvs.length / 2;
  const clip = project.animations["idle"]!;
  clip.deformTracks = { [part.name]: [{ time: 0, offsets: new Array(vCount * 2).fill(1) }] };
  const { json } = exportSpine42(project);
  const verts = json.animations["idle"]!.deform!["default"]![part.name]![part.name]![0]!.vertices;
  assert.equal(verts.length, influences * 2);
});
