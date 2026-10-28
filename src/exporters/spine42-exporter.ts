/**
 * Spine 4.2 JSON Exporter (`src/exporters/spine42-exporter.ts`)
 *
 * Converts a `SpineForgeProject` into a Spine 4.2 `.json` skeleton.
 *
 * Two physics modes:
 * - `"native"` (default): authored keyframes are exported with their easing curves, spring bones become
 *   Spine 4.2 **physics constraints**, `follow` bones become relative/local **transform constraints**,
 *   and IK mix keys become IK timelines. The result stays fully editable in Spine and is small.
 * - `"bake"`: every bone is sampled at `sampleRateHz` with springs, follow and IK solved into plain keys.
 *   Use this for runtimes older than Spine 4.2 (no physics support). IK constraints are kept at mix 0
 *   so the baked IK result is not applied twice.
 *
 * Coordinate conversion: studio space is top-left, Y-down pixels; Spine is Y-up with the root bone at 0,0.
 */

import { bakeClipConstraintsToKeyframes, SpineForgeAnimator } from "../core/animator";
import type { AnimationClip, CurveType, RigSpringConfig, SpineForgeProject, TransformKey } from "../core/schema";
import { buildPartMesh } from "../core/weights";

export type SpineCurveJson = "stepped" | number[];

export type Spine42BoneJson = {
  name: string;
  parent?: string;
  length?: number;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  color?: string;
};

export type Spine42SlotJson = {
  name: string;
  bone: string;
  /** Omitted for alternate layers that start hidden. */
  attachment?: string;
  blend?: "normal" | "additive" | "multiply" | "screen";
};

export type Spine42MeshAttachmentJson = {
  type: "mesh";
  name: string;
  path: string;
  uvs: number[];
  triangles: number[];
  vertices: number[];
  hull: number;
  width: number;
  height: number;
};

export type Spine42IkJson = {
  name: string;
  order: number;
  bones: string[];
  target: string;
  bendPositive: boolean;
  mix: number;
};

export type Spine42TransformJson = {
  name: string;
  order: number;
  bones: string[];
  target: string;
  local: true;
  relative: true;
  mixRotate: number;
  mixX: 0;
  mixY: 0;
  mixScaleX: 0;
  mixScaleY: 0;
  mixShearY: 0;
};

export type Spine42PhysicsJson = {
  name: string;
  order: number;
  bone: string;
  rotate: number;
  inertia: number;
  strength: number;
  damping: number;
  mass: number;
  wind: number;
  gravity: number;
  mix: number;
  limit: number;
  fps: number;
};

type ValueKey = { time: number; value?: number; curve?: SpineCurveJson };
type XYKey = { time: number; x?: number; y?: number; curve?: SpineCurveJson };

export type Spine42Json = {
  skeleton: {
    hash: string;
    spine: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fps: number;
    images: string;
  };
  bones: Spine42BoneJson[];
  slots: Spine42SlotJson[];
  ik?: Spine42IkJson[];
  transform?: Spine42TransformJson[];
  physics?: Spine42PhysicsJson[];
  skins: {
    name: string;
    attachments: Record<string, Record<string, Spine42MeshAttachmentJson>>;
  }[];
  events?: Record<string, { int?: number; float?: number; string?: string }>;
  animations: Record<
    string,
    {
      bones?: Record<string, { rotate?: ValueKey[]; translate?: XYKey[]; scale?: XYKey[] }>;
      ik?: Record<string, { time: number; mix: number; bendPositive: boolean; curve?: SpineCurveJson }[]>;
      slots?: Record<string, { attachment: { time: number; name: string | null }[] }>;
      deform?: Record<string, Record<string, Record<string, { time: number; vertices: number[]; curve?: SpineCurveJson }[]>>>;
      drawOrder?: { time: number; offsets?: { slot: string; offset: number }[] }[];
      events?: { time: number; name: string; int?: number; float?: number; string?: string }[];
    }
  >;
};

export type SpinePhysicsMode = "native" | "bake";

export type Spine42ExportOptions = {
  /** `"native"` (default) keeps curves + Spine 4.2 physics; `"bake"` samples everything into keys. */
  physics?: SpinePhysicsMode;
  /** @deprecated use `physics: "bake"`. `true` maps to `"bake"`. */
  bakeSprings?: boolean;
  /** Sample rate for baked tracks (bake mode, root shake, draw-order detection). */
  sampleRateHz?: number;
};

export type Spine42ExportResult = { json: Spine42Json; warnings: string[] };

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Studio pixel point (Y-down, top-left origin) to Spine world space (Y-up, root bone at 0,0). */
function studioToSpineWorld(px: number, py: number, rootPx: number, rootPy: number): [number, number] {
  return [px - rootPx, rootPy - py];
}

/**
 * Converts a normalized studio bezier (CSS-style `[x1, y1, x2, y2]` over 0..1) into Spine 4.x's
 * absolute curve format: per value channel `[cx1, cy1, cx2, cy2]` in seconds and value units.
 * Returns `undefined` for linear segments (Spine's default).
 */
export function toSpineCurve(
  curve: CurveType | undefined,
  t0: number,
  t1: number,
  from: number[],
  to: number[],
): SpineCurveJson | undefined {
  if (!curve || curve === "linear") return undefined;
  if (curve === "stepped") return "stepped";
  const [x1, y1, x2, y2] = curve;
  const dt = t1 - t0;
  const out: number[] = [];
  for (let c = 0; c < from.length; c++) {
    const v0 = from[c]!;
    const dv = to[c]! - v0;
    out.push(round4(t0 + x1 * dt), round4(v0 + y1 * dv), round4(t0 + x2 * dt), round4(v0 + y2 * dv));
  }
  return out;
}

/** Builds one Spine timeline from sorted keys, attaching curves converted to Spine's absolute form. */
function buildTimeline<T extends { time: number }>(
  keys: TransformKey[],
  values: (k: TransformKey) => number[],
  write: (k: TransformKey, v: number[]) => T,
): (T & { curve?: SpineCurveJson })[] {
  return keys.map((k, i) => {
    const v = values(k).map(round4);
    const entry: T & { curve?: SpineCurveJson } = write(k, v);
    const next = keys[i + 1];
    if (next) {
      const curve = toSpineCurve(k.curve, k.time, next.time, v, values(next).map(round4));
      if (curve) entry.curve = curve;
    }
    return entry;
  });
}

/**
 * Maps the studio spring model (`θ'' = k(target − θ) − c·θ'`, lag driven by pivot acceleration)
 * onto Spine 4.2 physics constraint parameters.
 * - strength ≈ stiffness (both act as the restoring spring constant)
 * - damping: Spine multiplies velocity by `damping^(60·step)`; matching `e^(−c·t)` gives `e^(−c/60)`
 * - inertia: how much of the parent's motion the bone resists; derived from acceleration gain
 * - wind: studio wind is an oscillating sway, Spine wind is a constant force, so only a small
 *   constant lean is exported (sway must be re-added with Spine's wind timeline if wanted)
 */
export function springToSpinePhysics(spring: RigSpringConfig): Omit<Spine42PhysicsJson, "name" | "order" | "bone"> {
  const gain = Math.hypot(spring.gain[0], spring.gain[1]);
  return {
    rotate: 1,
    inertia: round4(clamp(gain / 10, 0.2, 1)),
    strength: round4(clamp(spring.stiffness, 1, 1000)),
    damping: round4(clamp(Math.exp(-spring.damping / 60), 0, 1)),
    mass: 1,
    wind: 0,
    gravity: 0,
    mix: 1,
    limit: 5000,
    fps: 60,
  };
}

function trackHasMotion(keys: TransformKey[]): boolean {
  return keys.some(
    (k) =>
      Math.abs(k.r ?? 0) > 1e-3 ||
      Math.abs(k.x ?? 0) > 1e-3 ||
      Math.abs(k.y ?? 0) > 1e-3 ||
      Math.abs((k.sx ?? 1) - 1) > 1e-4 ||
      Math.abs((k.sy ?? 1) - 1) > 1e-4,
  );
}

/** Samples the root bone (index 0) with fx-track camera shake applied, for native-mode export. */
function sampleRootWithShake(project: SpineForgeProject, clip: AnimationClip, sampleRateHz: number): TransformKey[] {
  const anim = new SpineForgeAnimator(project, clip.name);
  const steps = Math.max(2, Math.round(clip.duration * sampleRateHz));
  const dt = clip.duration / steps;
  const keys: TransformKey[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const p = anim.evaluateAt(t, dt).poses[0]!;
    keys.push({ time: round4(t), r: p.r, x: p.x, y: p.y, sx: p.sx, sy: p.sy });
  }
  return keys;
}

export function exportSpine42(project: SpineForgeProject, options: Spine42ExportOptions = {}): Spine42ExportResult {
  const mode: SpinePhysicsMode = options.physics ?? (options.bakeSprings ? "bake" : "native");
  const sampleRateHz = options.sampleRateHz ?? 24;
  const warnings: string[] = [];

  const rootBone = project.bones[0] ?? { name: "root", x: 0.5, y: 0.975 };
  const rootPx = rootBone.x * project.width;
  const rootPy = rootBone.y * project.height;

  const boneIndex: Record<string, number> = {};
  project.bones.forEach((b, i) => {
    boneIndex[b.name] = i;
  });

  // Bind rotation is 0 for every bone, so bone-local axes equal world axes at bind time.
  const boneSpineWorld: [number, number][] = project.bones.map((b) =>
    studioToSpineWorld(b.x * project.width, b.y * project.height, rootPx, rootPy),
  );

  const spineBones: Spine42BoneJson[] = project.bones.map((b, i) => {
    const [wx, wy] = boneSpineWorld[i]!;
    const pIdx = b.parent ? (boneIndex[b.parent] ?? -1) : -1;
    const [pwx, pwy] = pIdx >= 0 ? boneSpineWorld[pIdx]! : [0, 0];
    return {
      name: b.name,
      ...(b.parent ? { parent: b.parent } : {}),
      length: round4((b.length ?? 0.08) * project.height),
      x: round4(wx - pwx),
      y: round4(wy - pwy),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      ...(b.color ? { color: b.color.replace("#", "") + "ff" } : {}),
    };
  });

  const spineSlots: Spine42SlotJson[] = project.parts.map((part) => ({
    name: part.name,
    bone: part.bone ?? part.skin?.[0] ?? rootBone.name,
    ...(part.hidden ? {} : { attachment: part.name }),
    ...(part.blendMode && part.blendMode !== "normal" ? { blend: part.blendMode } : {}),
  }));

  // ── Mesh attachments ────────────────────────────────────────────────────────────────────────────
  const attachments: Record<string, Record<string, Spine42MeshAttachmentJson>> = {};
  /** Per weighted part: bone-influence count per vertex (needed to expand deform keys). */
  const influenceCounts: Record<string, number[]> = {};

  for (const part of project.parts) {
    const mesh = part.mesh ?? buildPartMesh(project, part);
    const vCount = mesh.positions.length / 2;
    const isWeighted = Boolean(part.skin && part.skin.length > 1);
    const singleBoneIdx = part.bone ? (boneIndex[part.bone] ?? 0) : (boneIndex[part.skin?.[0] ?? "root"] ?? 0);
    const counts: number[] = [];

    const spineVertices: number[] = [];
    for (let v = 0; v < vCount; v++) {
      const [wx, wy] = studioToSpineWorld(mesh.positions[v * 2]!, mesh.positions[v * 2 + 1]!, rootPx, rootPy);

      if (!isWeighted) {
        const [bx, by] = boneSpineWorld[singleBoneIdx]!;
        spineVertices.push(round4(wx - bx), round4(wy - by));
        continue;
      }

      // Weighted format: [boneCount, boneIdx, bindLocalX, bindLocalY, weight, ...]
      const active: { b: number; lx: number; ly: number; w: number }[] = [];
      for (let k = 0; k < 4; k++) {
        const b = mesh.joints[v * 4 + k]!;
        const w = mesh.weights[v * 4 + k]!;
        if (w > 1e-5) {
          const [bx, by] = boneSpineWorld[b] ?? [0, 0];
          active.push({ b, lx: round4(wx - bx), ly: round4(wy - by), w });
        }
      }
      if (active.length === 0) {
        const [bx, by] = boneSpineWorld[0]!;
        active.push({ b: 0, lx: round4(wx - bx), ly: round4(wy - by), w: 1 });
      }
      // Renormalize after dropping tiny weights so Spine's sum-to-1 assumption holds exactly.
      const sum = active.reduce((s, a) => s + a.w, 0);
      spineVertices.push(active.length);
      for (const inf of active) spineVertices.push(inf.b, inf.lx, inf.ly, round4(inf.w / sum));
      counts.push(active.length);
    }
    if (isWeighted) influenceCounts[part.name] = counts;

    attachments[part.name] = {
      [part.name]: {
        type: "mesh",
        name: part.name,
        path: part.name,
        uvs: mesh.uvs.map(round4),
        triangles: mesh.indices.slice(),
        vertices: spineVertices,
        hull: mesh.hullCount,
        width: Math.round(part.w * project.width),
        height: Math.round(part.h * project.height),
      },
    };
  }

  // ── Constraints ─────────────────────────────────────────────────────────────────────────────────
  let order = 0;
  const ik: Spine42IkJson[] = (project.ikConstraints ?? []).map((c) => ({
    name: c.name,
    order: order++,
    bones: [...c.bones],
    target: c.target,
    bendPositive: !c.bendPositive, // Y-up flips bend direction
    // In bake mode the IK solution is already in the keys; applying it again would double it.
    mix: mode === "bake" ? 0 : c.mix,
  }));

  const transform: Spine42TransformJson[] = [];
  const physics: Spine42PhysicsJson[] = [];
  if (mode === "native") {
    for (const b of project.bones) {
      if (!b.follow) continue;
      if (b.follow.ratio < 0) {
        warnings.push(`Bone "${b.name}" follows "${b.follow.bone}" with a negative ratio; Spine mixes are exported as 0..1.`);
      }
      transform.push({
        name: `follow-${b.name}`,
        order: order++,
        bones: [b.name],
        target: b.follow.bone,
        local: true,
        relative: true,
        mixRotate: round4(clamp(b.follow.ratio, 0, 1)),
        mixX: 0,
        mixY: 0,
        mixScaleX: 0,
        mixScaleY: 0,
        mixShearY: 0,
      });
    }
    for (const b of project.bones) {
      if (!b.spring) continue;
      physics.push({ name: `spring-${b.name}`, order: order++, bone: b.name, ...springToSpinePhysics(b.spring) });
      if ((b.spring.wind ?? 0) > 0) {
        warnings.push(`Bone "${b.name}": ambient wind sway is not exported natively; add a Spine wind timeline if needed.`);
      }
    }
  }

  // ── Animations ──────────────────────────────────────────────────────────────────────────────────
  const animationsJson: Spine42Json["animations"] = {};
  const baseOrder = project.parts.map((p) => p.name);

  for (const [clipName, rawClip] of Object.entries(project.animations)) {
    const clip: AnimationClip = mode === "bake" ? bakeClipConstraintsToKeyframes(project, rawClip, sampleRateHz) : rawClip;
    const hasShake = mode === "native" && (rawClip.fxTrack ?? []).some((k) => (k.shake ?? 0) > 0);

    const bonesAnim: NonNullable<Spine42Json["animations"][string]["bones"]> = {};
    for (const [boneName, rawKeys] of Object.entries(clip.boneTracks)) {
      let keys = rawKeys;
      if (hasShake && boneName === rootBone.name) keys = sampleRootWithShake(project, rawClip, Math.max(sampleRateHz, 30));
      if (!keys || keys.length === 0 || !trackHasMotion(keys)) continue;
      const sorted = [...keys].sort((a, b) => a.time - b.time);

      // Studio rotation is clockwise (Y-down); Spine is counter-clockwise (Y-up): negate r and y.
      bonesAnim[boneName] = {
        rotate: buildTimeline<ValueKey>(sorted, (k) => [-(k.r ?? 0)], (k, v) => ({ time: round4(k.time), value: v[0] })),
        translate: buildTimeline<XYKey>(sorted, (k) => [k.x ?? 0, -(k.y ?? 0)], (k, v) => ({
          time: round4(k.time),
          x: v[0],
          y: v[1],
        })),
        scale: buildTimeline<XYKey>(sorted, (k) => [k.sx ?? 1, k.sy ?? 1], (k, v) => ({
          time: round4(k.time),
          x: v[0],
          y: v[1],
        })),
      };
    }

    // Track bones referenced by the root-shake sampler even if the clip had no root keys.
    if (hasShake && !clip.boneTracks[rootBone.name]) {
      const keys = sampleRootWithShake(project, rawClip, Math.max(sampleRateHz, 30));
      if (trackHasMotion(keys)) {
        bonesAnim[rootBone.name] = {
          rotate: keys.map((k) => ({ time: k.time, value: round4(-(k.r ?? 0)) })),
          translate: keys.map((k) => ({ time: k.time, x: round4(k.x ?? 0), y: round4(-(k.y ?? 0)) })),
          scale: keys.map((k) => ({ time: k.time, x: round4(k.sx ?? 1), y: round4(k.sy ?? 1) })),
        };
      }
    }

    // IK mix timelines (native only; bake mode keeps IK at mix 0).
    let ikJson: Spine42Json["animations"][string]["ik"];
    if (mode === "native" && rawClip.ikTracks) {
      for (const [ikName, ikKeys] of Object.entries(rawClip.ikTracks)) {
        const def = project.ikConstraints?.find((c) => c.name === ikName);
        if (!def || !ikKeys?.length) continue;
        const sorted = [...ikKeys].sort((a, b) => a.time - b.time);
        ikJson ??= {};
        ikJson[ikName] = sorted.map((k, i) => {
          const next = sorted[i + 1];
          // Spine IK timelines carry two channels (mix, softness); softness stays 0.
          const curve = next ? toSpineCurve(k.curve, k.time, next.time, [k.mix, 0], [next.mix, 0]) : undefined;
          return {
            time: round4(k.time),
            mix: round4(k.mix),
            bendPositive: !(k.bendPositive ?? def.bendPositive),
            ...(curve ? { curve } : {}),
          };
        });
      }
    }

    // Draw-order swaps, detected by sampling the evaluated order.
    const drawOrderTimeline: NonNullable<Spine42Json["animations"][string]["drawOrder"]> = [];
    const animEvaluator = new SpineForgeAnimator(project, clipName);
    const totalSteps = Math.max(2, Math.round(clip.duration * sampleRateHz));
    let lastOrderSig = "";
    for (let s = 0; s <= totalSteps; s++) {
      const t = round4((s / totalSteps) * clip.duration);
      const frame = animEvaluator.evaluateAt(t, clip.duration / totalSteps);
      const sig = frame.slotOrder.join(",");
      if (sig === lastOrderSig) continue;
      lastOrderSig = sig;
      const offsets: { slot: string; offset: number }[] = [];
      frame.slotOrder.forEach((slotName, newIdx) => {
        const origIdx = baseOrder.indexOf(slotName);
        if (origIdx >= 0 && newIdx !== origIdx) offsets.push({ slot: slotName, offset: newIdx - origIdx });
      });
      // Spine requires offsets in setup-pose slot order, otherwise its reader walks past the slot list.
      offsets.sort((a, b) => baseOrder.indexOf(a.slot) - baseOrder.indexOf(b.slot));
      drawOrderTimeline.push({ time: t, ...(offsets.length > 0 ? { offsets } : {}) });
    }

    // FFD deform timelines. Weighted meshes need one offset pair per bone influence, not per vertex:
    // giving every influence the vertex's offset makes the weighted sum equal that offset.
    let deformJson: Spine42Json["animations"][string]["deform"];
    if (clip.deformTracks && Object.keys(clip.deformTracks).length > 0) {
      const slots: Record<string, Record<string, { time: number; vertices: number[]; curve?: SpineCurveJson }[]>> = {};
      for (const [partName, dKeys] of Object.entries(clip.deformTracks)) {
        if (!dKeys?.length || !attachments[partName]) continue;
        const counts = influenceCounts[partName];
        const expand = (offsets: number[]): number[] => {
          const spineSpace = offsets.map((val, idx) => round4(idx % 2 === 1 ? -val : val));
          if (!counts) return spineSpace;
          const out: number[] = [];
          counts.forEach((n, v) => {
            for (let k = 0; k < n; k++) out.push(spineSpace[v * 2] ?? 0, spineSpace[v * 2 + 1] ?? 0);
          });
          return out;
        };
        const sorted = [...dKeys].sort((a, b) => a.time - b.time);
        slots[partName] = {
          [partName]: sorted.map((dk, i) => {
            const next = sorted[i + 1];
            // Deform curves are a single 0..1 percentage channel in Spine.
            const curve = next ? toSpineCurve(dk.curve, dk.time, next.time, [0], [1]) : undefined;
            return { time: round4(dk.time), vertices: expand(dk.offsets), ...(curve ? { curve } : {}) };
          }),
        };
      }
      if (Object.keys(slots).length > 0) deformJson = { default: slots };
    }

    // Show/hide keys become attachment timelines: the slot's own attachment, or none.
    let slotsJson: Spine42Json["animations"][string]["slots"];
    for (const [partName, keys] of Object.entries(rawClip.visibilityTracks ?? {})) {
      if (!keys?.length || !attachments[partName]) continue;
      slotsJson ??= {};
      slotsJson[partName] = {
        attachment: [...keys]
          .sort((a, b) => a.time - b.time)
          .map((k) => ({ time: round4(k.time), name: k.visible ? partName : null })),
      };
    }

    animationsJson[clipName] = {
      bones: bonesAnim,
      ...(slotsJson ? { slots: slotsJson } : {}),
      ...(ikJson ? { ik: ikJson } : {}),
      ...(deformJson ? { deform: deformJson } : {}),
      ...(drawOrderTimeline.length > 1 ? { drawOrder: drawOrderTimeline } : {}),
      ...(rawClip.events && rawClip.events.length > 0
        ? {
            events: rawClip.events.map((ev) => ({
              time: round4(ev.time),
              name: ev.name,
              ...(ev.intParam !== undefined ? { int: ev.intParam } : {}),
              ...(ev.floatParam !== undefined ? { float: round4(ev.floatParam) } : {}),
              ...(ev.stringParam !== undefined ? { string: ev.stringParam } : {}),
            })),
          }
        : {}),
    };
  }

  const eventsCatalog: Record<string, { int?: number; float?: number; string?: string }> = {};
  for (const clip of Object.values(project.animations)) {
    for (const ev of clip.events ?? []) {
      eventsCatalog[ev.name] ??= {
        ...(ev.intParam !== undefined ? { int: ev.intParam } : {}),
        ...(ev.floatParam !== undefined ? { float: ev.floatParam } : {}),
        ...(ev.stringParam !== undefined ? { string: ev.stringParam } : {}),
      };
    }
  }

  // Studio skin variants are colour tints, not attachment swaps. Attachments live once in the
  // "default" skin (Spine falls back to it), and each tier is exported as a named, empty skin so
  // game code can still call setSkin("<tier>") without tripling the file size.
  const tierSkins = (project.skins ?? []).filter((s) => s.name !== "default").map((s) => ({ name: s.name, attachments: {} }));
  if (tierSkins.length > 0) {
    warnings.push("Skin tiers are colour tints; apply the tint at runtime or with slot colour timelines.");
  }

  const json: Spine42Json = {
    skeleton: {
      hash: `sf-${project.id}`,
      spine: "4.2.0",
      x: round4(-rootPx),
      y: round4(-(project.height - rootPy)),
      width: project.width,
      height: project.height,
      fps: 24,
      images: "./",
    },
    bones: spineBones,
    slots: spineSlots,
    ...(ik.length > 0 ? { ik } : {}),
    ...(transform.length > 0 ? { transform } : {}),
    ...(physics.length > 0 ? { physics } : {}),
    skins: [{ name: "default", attachments }, ...tierSkins],
    ...(Object.keys(eventsCatalog).length > 0 ? { events: eventsCatalog } : {}),
    animations: animationsJson,
  };

  return { json, warnings };
}

/** Backwards-compatible wrapper returning only the JSON document. */
export function exportSpine42Json(project: SpineForgeProject, options: Spine42ExportOptions = {}): Spine42Json {
  return exportSpine42(project, options).json;
}
