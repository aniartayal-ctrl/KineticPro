/**
 * Keyframe Timeline Evaluator, Procedural Clip Synthesizer & Spring Baker (`src/core/animator.ts`)
 *
 * Capabilities:
 * 1. Evaluates multi-track `AnimationClip` keyframes at any timestamp `t` (Linear, Stepped, Cubic Bezier)
 * 2. Generates editable keyframe clips for all 6 slot hero poses (`idle`, `cheer`, `strike`, `power`, `triumph`, `bow`)
 *    plus `anticipation` and `symbol-win`, porting and generalizing `SlotSpy/src/lib/simulator/rig-anim.ts` into
 *    explicit editable keyframe tracks!
 * 3. Bakes real-time spring physics (`bone.spring`) and `follow` constraints into explicit keyframe tracks
 *    so exported Spine 4.2 JSON and Unity AnimationClips play identically with zero runtime drift.
 */

import type {
  AnimationClip,
  CurveType,
  DeformKey,
  FxKey,
  IkMixKey,
  RigPart,
  SpineForgeProject,
  TransformKey,
} from "./schema";
import {
  buildSkeleton,
  evaluateDrawOrder,
  restPose,
  solveSkeleton,
  stepSpringBones,
  type Affine2D,
  type BonePose,
  type BuiltSkeleton,
  type SpringState,
} from "./solver";

/** Evaluates a 1D Cubic Bezier curve [cx1, cy1, cx2, cy2] at normalized time u in [0..1]. */
export function evaluateCurve(u: number, curve?: CurveType): number {
  const t = Math.max(0, Math.min(1, u));
  if (!curve || curve === "linear") return t;
  if (curve === "stepped") return 0;

  const [x1, y1, x2, y2] = curve;
  // Newton-Raphson solve for parameter s where BezierX(s) = t
  let s = t;
  for (let i = 0; i < 6; i++) {
    const inv = 1 - s;
    const bx = 3 * inv * inv * s * x1 + 3 * inv * s * s * x2 + s * s * s - t;
    if (Math.abs(bx) < 1e-5) break;
    const dbx = 3 * inv * inv * x1 + 6 * inv * s * (x2 - x1) + 3 * s * s * (1 - x2);
    if (Math.abs(dbx) < 1e-6) break;
    s = Math.max(0, Math.min(1, s - bx / dbx));
  }
  const inv = 1 - s;
  return 3 * inv * inv * s * y1 + 3 * inv * s * s * y2 + s * s * s;
}

export const EASE_SINE_IN_OUT: [number, number, number, number] = [0.37, 0, 0.63, 1];
export const EASE_POWER2_IN: [number, number, number, number] = [0.55, 0.085, 0.68, 0.53];
export const EASE_POWER2_OUT: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94];
export const EASE_POWER2_IN_OUT: [number, number, number, number] = [0.455, 0.03, 0.515, 0.955];
export const EASE_BACK_OUT: [number, number, number, number] = [0.175, 0.885, 0.32, 1.275];

/** Interpolates a bone's `TransformKey[]` track at timestamp `time`. */
export function sampleTransformTrack(track: TransformKey[] | undefined, time: number): BonePose {
  const pose = restPose();
  if (!track || track.length === 0) return pose;
  if (time <= track[0]!.time) {
    const k = track[0]!;
    return {
      r: k.r ?? 0,
      x: k.x ?? 0,
      y: k.y ?? 0,
      sx: k.sx ?? 1,
      sy: k.sy ?? 1,
    };
  }
  if (time >= track[track.length - 1]!.time) {
    const k = track[track.length - 1]!;
    return {
      r: k.r ?? 0,
      x: k.x ?? 0,
      y: k.y ?? 0,
      sx: k.sx ?? 1,
      sy: k.sy ?? 1,
    };
  }

  let idx = 0;
  for (let i = 0; i < track.length - 1; i++) {
    if (time >= track[i]!.time && time <= track[i + 1]!.time) {
      idx = i;
      break;
    }
  }
  const k0 = track[idx]!;
  const k1 = track[idx + 1]!;
  const span = Math.max(1e-6, k1.time - k0.time);
  const alpha = evaluateCurve((time - k0.time) / span, k0.curve);

  const lerp = (a: number, b: number) => a + (b - a) * alpha;
  return {
    r: lerp(k0.r ?? 0, k1.r ?? 0),
    x: lerp(k0.x ?? 0, k1.x ?? 0),
    y: lerp(k0.y ?? 0, k1.y ?? 0),
    sx: lerp(k0.sx ?? 1, k1.sx ?? 1),
    sy: lerp(k0.sy ?? 1, k1.sy ?? 1),
  };
}

export function sampleFxTrack(
  track: FxKey[] | undefined,
  time: number,
): { flash: number; shake: number; keyPose: number } {
  if (!track || track.length === 0) return { flash: 0, shake: 0, keyPose: 0 };
  if (time <= track[0]!.time) {
    const k = track[0]!;
    return { flash: k.flash ?? 0, shake: k.shake ?? 0, keyPose: k.keyPose ?? 0 };
  }
  if (time >= track[track.length - 1]!.time) {
    const k = track[track.length - 1]!;
    return { flash: k.flash ?? 0, shake: k.shake ?? 0, keyPose: k.keyPose ?? 0 };
  }
  let idx = 0;
  for (let i = 0; i < track.length - 1; i++) {
    if (time >= track[i]!.time && time <= track[i + 1]!.time) {
      idx = i;
      break;
    }
  }
  const k0 = track[idx]!;
  const k1 = track[idx + 1]!;
  const span = Math.max(1e-6, k1.time - k0.time);
  const alpha = evaluateCurve((time - k0.time) / span, k0.curve);
  const lerp = (a: number, b: number) => a + (b - a) * alpha;
  return {
    flash: lerp(k0.flash ?? 0, k1.flash ?? 0),
    shake: lerp(k0.shake ?? 0, k1.shake ?? 0),
    keyPose: (k0.keyPose ?? 0) >= 0.5 ? 1 : 0,
  };
}

export function sampleDeformTrack(track: DeformKey[] | undefined, time: number, vertexCount: number): number[] | undefined {
  if (!track || track.length === 0) return undefined;
  const len = vertexCount * 2;
  if (time <= track[0]!.time) return track[0]!.offsets.slice(0, len);
  if (time >= track[track.length - 1]!.time) return track[track.length - 1]!.offsets.slice(0, len);

  let idx = 0;
  for (let i = 0; i < track.length - 1; i++) {
    if (time >= track[i]!.time && time <= track[i + 1]!.time) {
      idx = i;
      break;
    }
  }
  const k0 = track[idx]!;
  const k1 = track[idx + 1]!;
  const span = Math.max(1e-6, k1.time - k0.time);
  const alpha = evaluateCurve((time - k0.time) / span, k0.curve);
  const out = new Array<number>(len).fill(0);
  for (let i = 0; i < len; i++) {
    const a = k0.offsets[i] ?? 0;
    const b = k1.offsets[i] ?? 0;
    out[i] = a + (b - a) * alpha;
  }
  return out;
}

export function sampleIkTrack(
  track: IkMixKey[] | undefined,
  time: number,
  defaultMix: number,
  defaultBend: boolean,
): { mix: number; bendPositive: boolean } {
  if (!track || track.length === 0) return { mix: defaultMix, bendPositive: defaultBend };
  if (time <= track[0]!.time) {
    return { mix: track[0]!.mix, bendPositive: track[0]!.bendPositive ?? defaultBend };
  }
  if (time >= track[track.length - 1]!.time) {
    const last = track[track.length - 1]!;
    return { mix: last.mix, bendPositive: last.bendPositive ?? defaultBend };
  }
  let idx = 0;
  for (let i = 0; i < track.length - 1; i++) {
    if (time >= track[i]!.time && time <= track[i + 1]!.time) {
      idx = i;
      break;
    }
  }
  const k0 = track[idx]!;
  const k1 = track[idx + 1]!;
  const span = Math.max(1e-6, k1.time - k0.time);
  const alpha = evaluateCurve((time - k0.time) / span, k0.curve);
  return {
    mix: k0.mix + (k1.mix - k0.mix) * alpha,
    bendPositive: k0.bendPositive ?? defaultBend,
  };
}

/** Whether `part` is shown at time `t`: the last visibility key at or before `t`, else its setup flag. */
export function isPartVisible(part: Pick<RigPart, "name" | "hidden">, clip: Pick<AnimationClip, "visibilityTracks"> | undefined, t: number): boolean {
  let visible = !part.hidden;
  let at = -Infinity;
  for (const key of clip?.visibilityTracks?.[part.name] ?? []) {
    if (key.time <= t + 1e-6 && key.time >= at) {
      at = key.time;
      visible = key.visible;
    }
  }
  return visible;
}

export type EvaluatedFrame = {
  time: number;
  poses: BonePose[];
  world: Affine2D[];
  skin: Float32Array;
  /** Parts to draw this frame, back to front (hidden parts left out). */
  order: string[];
  /** Every part in draw order, shown or not: what Spine slot offsets are measured against. */
  slotOrder: string[];
  deforms: Record<string, number[] | undefined>;
  fx: { flash: number; shake: number; keyPose: number };
};

export class SpineForgeAnimator {
  readonly skeleton: BuiltSkeleton;
  readonly skin = new Float32Array(64 * 4);
  readonly world: Affine2D[];
  readonly springs: SpringState[];
  private currentClipName: string;

  constructor(project: SpineForgeProject, initialClip = "idle") {
    this.skeleton = buildSkeleton(project);
    this.world = project.bones.map(() => [1, 0, 0, 1, 0, 0]);
    this.springs = project.bones.map(() => ({ angle: 0, velocity: 0 }));
    this.currentClipName = initialClip;
  }

  setClip(name: string): void {
    if (this.currentClipName !== name) {
      this.currentClipName = name;
      for (const s of this.springs) {
        s.angle = 0;
        s.velocity = 0;
        s.lastPos = undefined;
        s.lastVel = undefined;
      }
    }
  }

  evaluateAt(timestamp: number, dt = 1 / 60, extraBoneOffsets?: Record<string, BonePose>): EvaluatedFrame {
    const { project, bones } = this.skeleton;
    const clip = project.animations[this.currentClipName];
    const duration = clip?.duration ?? 2.4;
    const t = clip?.loop ? ((timestamp % duration) + duration) % duration : Math.max(0, Math.min(duration, timestamp));

    const fx = sampleFxTrack(clip?.fxTrack, t);
    const unit = project.height / 1000;
    const shakePx = fx.shake * 5 * unit;

    const basePoses = bones.map((bone, i) => {
      const p = sampleTransformTrack(clip?.boneTracks[bone.name], t);
      const extra = extraBoneOffsets?.[bone.name];
      if (extra) {
        p.r += extra.r;
        p.x += extra.x;
        p.y += extra.y;
        p.sx *= extra.sx;
        p.sy *= extra.sy;
      }
      if (i === 0 && shakePx > 0) {
        p.x += Math.sin(t * 95) * shakePx;
        p.y += Math.cos(t * 77) * shakePx * 0.6;
      }
      return p;
    });

    const ikOverrides: Record<string, { mix: number; bendPositive?: boolean }> = {};
    for (const ik of project.ikConstraints ?? []) {
      ikOverrides[ik.name] = sampleIkTrack(clip?.ikTracks?.[ik.name], t, ik.mix, ik.bendPositive);
    }

    const effectivePoses = solveSkeleton(
      this.skeleton,
      basePoses,
      this.world,
      this.skin,
      this.springs,
      ikOverrides,
    );

    if (dt > 0) {
      stepSpringBones(this.skeleton, this.world, this.springs, t, dt);
    }

    // Determine draw order (explicit keyframe or dynamic swap)
    let explicitOrder: string[] | undefined;
    if (clip?.drawOrderTrack && clip.drawOrderTrack.length > 0) {
      for (const dk of clip.drawOrderTrack) {
        if (t >= dk.time) explicitOrder = dk.order;
      }
    }
    const slotOrder = evaluateDrawOrder(this.skeleton, effectivePoses, explicitOrder);
    const hiddenParts = new Set(project.parts.filter((p) => !isPartVisible(p, clip, t)).map((p) => p.name));
    const order = hiddenParts.size > 0 ? slotOrder.filter((name) => !hiddenParts.has(name)) : slotOrder;

    const deforms: Record<string, number[] | undefined> = {};
    for (const part of project.parts) {
      const vCount = part.mesh ? part.mesh.positions.length / 2 : 0;
      if (vCount > 0 && clip?.deformTracks?.[part.name]) {
        deforms[part.name] = sampleDeformTrack(clip.deformTracks[part.name], t, vCount);
      }
    }

    return {
      time: t,
      poses: effectivePoses,
      world: this.world,
      skin: this.skin,
      order,
      slotOrder,
      deforms,
      fx,
    };
  }
}

/**
 * Generates the complete standard set of 6 procedural slot character clips (`idle`, `cheer`, `strike`, `power`, `triumph`, `bow`)
 * as explicit editable keyframe timelines (`Record<string, AnimationClip>`).
 */
export function generateProceduralClips(
  project: Pick<SpineForgeProject, "height" | "action" | "bones" | "keyPose">,
): Record<string, AnimationClip> {
  const u = project.height / 1000;
  const raised = project.action === "raise";

  // 1. IDLE (4.8s seamless breathing + weight shift loop)
  const idleBones: Record<string, TransformKey[]> = {
    hips: [
      { time: 0, x: -3 * u, r: -0.4, curve: EASE_SINE_IN_OUT },
      { time: 2.4, x: 3 * u, r: 0.4, curve: EASE_SINE_IN_OUT },
      { time: 4.8, x: -3 * u, r: -0.4 },
    ],
    chest: [
      { time: 0, sy: 0.992, sx: 1.004, r: 0.6, curve: EASE_SINE_IN_OUT },
      { time: 1.2, sy: 1.014, sx: 0.993, r: 0.0, curve: EASE_SINE_IN_OUT },
      { time: 2.4, sy: 0.992, sx: 1.004, r: -0.6, curve: EASE_SINE_IN_OUT },
      { time: 3.6, sy: 1.014, sx: 0.993, r: 0.0, curve: EASE_SINE_IN_OUT },
      { time: 4.8, sy: 0.992, sx: 1.004, r: 0.6 },
    ],
    head: [
      { time: 0, r: -1.6, y: 1.5 * u, curve: EASE_SINE_IN_OUT },
      { time: 2.4, r: 1.6, y: -1.5 * u, curve: EASE_SINE_IN_OUT },
      { time: 4.8, r: -1.6, y: 1.5 * u },
    ],
    "arm-back": [
      { time: 0, r: -2.2, curve: EASE_SINE_IN_OUT },
      { time: 2.4, r: 2.2, curve: EASE_SINE_IN_OUT },
      { time: 4.8, r: -2.2 },
    ],
    arm: raised
      ? [
          { time: 0, r: 1.2, curve: EASE_SINE_IN_OUT },
          { time: 1.2, r: -1.2, curve: EASE_SINE_IN_OUT },
          { time: 2.4, r: 1.2, curve: EASE_SINE_IN_OUT },
          { time: 3.6, r: -1.2, curve: EASE_SINE_IN_OUT },
          { time: 4.8, r: 1.2 },
        ]
      : [
          { time: 0, r: 0.5, curve: EASE_SINE_IN_OUT },
          { time: 2.4, r: -0.5, curve: EASE_SINE_IN_OUT },
          { time: 4.8, r: 0.5 },
        ],
    forearm: raised
      ? [
          { time: 0, r: -1.5, curve: EASE_SINE_IN_OUT },
          { time: 2.4, r: 1.5, curve: EASE_SINE_IN_OUT },
          { time: 4.8, r: -1.5 },
        ]
      : [
          { time: 0, r: 0.4, curve: EASE_SINE_IN_OUT },
          { time: 2.4, r: -0.4, curve: EASE_SINE_IN_OUT },
          { time: 4.8, r: 0.4 },
        ],
    weapon: raised
      ? [
          { time: 0, r: 0.4, curve: EASE_SINE_IN_OUT },
          { time: 2.4, r: -0.4, curve: EASE_SINE_IN_OUT },
          { time: 4.8, r: 0.4 },
        ]
      : [
          { time: 0, r: -0.9, curve: EASE_SINE_IN_OUT },
          { time: 2.4, r: 0.9, curve: EASE_SINE_IN_OUT },
          { time: 4.8, r: -0.9 },
        ],
  };

  // 2. CHEER (2.0s fist-pump / wave celebration)
  const cheerBones: Record<string, TransformKey[]> = {
    root: [
      { time: 0, sy: 1, sx: 1, y: 0, curve: EASE_POWER2_IN },
      { time: 0.16, sy: 0.952, sx: 1.024, y: 0, curve: EASE_BACK_OUT },
      { time: 0.42, sy: 1.04, sx: 0.98, y: -11 * u, curve: EASE_POWER2_IN_OUT },
      { time: 0.64, sy: 0.99, sx: 1.005, y: -2 * u, curve: EASE_BACK_OUT },
      { time: 0.82, sy: 1.03, sx: 0.985, y: -8 * u, curve: EASE_SINE_IN_OUT },
      { time: 1.4, sy: 1.01, sx: 0.995, y: -3 * u, curve: EASE_POWER2_IN_OUT },
      { time: 2.0, sy: 1, sx: 1, y: 0 },
    ],
    hips: [
      { time: 0, y: 0, curve: EASE_POWER2_IN },
      { time: 0.16, y: 6.4 * u, curve: EASE_BACK_OUT },
      { time: 0.42, y: -2.4 * u, curve: EASE_POWER2_IN_OUT },
      { time: 1.4, y: -1 * u, curve: EASE_POWER2_IN_OUT },
      { time: 2.0, y: 0 },
    ],
    chest: [
      { time: 0, r: 0, sy: 1, curve: EASE_POWER2_IN },
      { time: 0.16, r: 3.2, sy: 1, curve: EASE_BACK_OUT },
      { time: 0.42, r: -4, sy: 1.024, curve: EASE_SINE_IN_OUT },
      { time: 1.4, r: -3, sy: 1.01, curve: EASE_POWER2_IN_OUT },
      { time: 2.0, r: 0, sy: 1 },
    ],
    head: [
      { time: 0, r: 0, y: 0, curve: EASE_POWER2_IN },
      { time: 0.21, r: 3.2, y: 3.2 * u, curve: EASE_BACK_OUT },
      { time: 0.47, r: -6.4, y: -3.2 * u, curve: EASE_SINE_IN_OUT },
      { time: 1.48, r: -3, y: -1.5 * u, curve: EASE_BACK_OUT },
      { time: 2.0, r: 0, y: 0 },
    ],
    "arm-back": raised
      ? [
          { time: 0, r: 0, curve: EASE_POWER2_IN },
          { time: 0.14, r: -15, curve: EASE_BACK_OUT },
          { time: 0.4, r: 105, curve: EASE_SINE_IN_OUT },
          { time: 0.56, r: 128, curve: EASE_SINE_IN_OUT },
          { time: 0.72, r: 100, curve: EASE_SINE_IN_OUT },
          { time: 0.88, r: 124, curve: EASE_SINE_IN_OUT },
          { time: 1.34, r: 110, curve: EASE_POWER2_IN_OUT },
          { time: 2.0, r: 0 },
        ]
      : [
          { time: 0, r: 0, curve: EASE_POWER2_IN },
          { time: 0.16, r: -18, curve: EASE_BACK_OUT },
          { time: 0.42, r: 158, curve: EASE_POWER2_IN_OUT },
          { time: 0.64, r: 128, curve: EASE_BACK_OUT },
          { time: 0.82, r: 162, curve: EASE_SINE_IN_OUT },
          { time: 1.4, r: 150, curve: EASE_POWER2_IN_OUT },
          { time: 2.0, r: 0 },
        ],
    arm: [
      { time: 0, r: 0, curve: EASE_BACK_OUT },
      { time: 0.42, r: raised ? -4 : -6, curve: EASE_POWER2_IN_OUT },
      { time: 1.4, r: -3, curve: EASE_POWER2_IN_OUT },
      { time: 2.0, r: 0 },
    ],
    forearm: [
      { time: 0, r: 0, curve: EASE_BACK_OUT },
      { time: 0.42, r: raised ? -22 : -18, curve: EASE_POWER2_IN_OUT },
      { time: 1.4, r: -10, curve: EASE_POWER2_IN_OUT },
      { time: 2.0, r: 0 },
    ],
    weapon: [
      { time: 0, r: 0, curve: EASE_BACK_OUT },
      { time: 0.42, r: 22, curve: EASE_POWER2_IN_OUT },
      { time: 1.4, r: 12, curve: EASE_POWER2_IN_OUT },
      { time: 2.0, r: 0 },
    ],
  };

  // 3. STRIKE (2.0s signature weapon slam or staff raise)
  const strikeBones: Record<string, TransformKey[]> = {
    root: [
      { time: 0, sy: 1, sx: 1, y: 0, curve: EASE_POWER2_IN_OUT },
      { time: 0.28, sy: 0.94, sx: 1.03, y: 0, curve: EASE_POWER2_OUT },
      { time: 0.58, sy: 1.05, sx: 0.975, y: -14 * u, curve: EASE_POWER2_IN },
      { time: 0.88, sy: raised ? 1.03 : 0.93, sx: raised ? 0.985 : 1.035, y: raised ? -10 * u : 0, curve: EASE_BACK_OUT },
      { time: 1.68, sy: 1, sx: 1, y: 0 },
      { time: 2.0, sy: 1, sx: 1, y: 0 },
    ],
    hips: [
      { time: 0, y: 0, curve: EASE_POWER2_IN_OUT },
      { time: 0.28, y: 8 * u, curve: EASE_POWER2_OUT },
      { time: 0.58, y: -3 * u, curve: EASE_POWER2_IN },
      { time: 0.88, y: raised ? -2 * u : 8 * u, curve: EASE_BACK_OUT },
      { time: 1.68, y: 0 },
      { time: 2.0, y: 0 },
    ],
    chest: [
      { time: 0, r: 0, sy: 1, curve: EASE_POWER2_IN_OUT },
      { time: 0.28, r: 4, sy: 1, curve: EASE_POWER2_OUT },
      { time: 0.58, r: -6.5, sy: 1.03, curve: EASE_POWER2_IN },
      { time: 0.88, r: raised ? -4 : 5, sy: raised ? 1.02 : 0.98, curve: EASE_BACK_OUT },
      { time: 1.68, r: 0, sy: 1 },
      { time: 2.0, r: 0, sy: 1 },
    ],
    head: [
      { time: 0, r: 0, y: 0, curve: EASE_POWER2_IN_OUT },
      { time: 0.33, r: 4, y: 4 * u, curve: EASE_POWER2_OUT },
      { time: 0.63, r: -8, y: -4 * u, curve: EASE_POWER2_IN },
      { time: 0.93, r: raised ? -5 : 4, y: raised ? -2 * u : 3 * u, curve: EASE_BACK_OUT },
      { time: 1.75, r: 0, y: 0 },
      { time: 2.0, r: 0, y: 0 },
    ],
    "arm-back": [
      { time: 0, r: 0, curve: EASE_POWER2_IN_OUT },
      { time: 0.28, r: -20, curve: EASE_POWER2_OUT },
      { time: 0.58, r: raised ? 25 : 40, curve: EASE_POWER2_IN },
      { time: 0.88, r: raised ? 20 : -10, curve: EASE_BACK_OUT },
      { time: 1.68, r: 0 },
      { time: 2.0, r: 0 },
    ],
    arm: raised
      ? [
          { time: 0, r: 0, curve: EASE_POWER2_IN_OUT },
          { time: 0.3, r: 8, curve: EASE_BACK_OUT },
          { time: 0.62, r: -140, curve: EASE_SINE_IN_OUT },
          { time: 1.32, r: -144, curve: EASE_POWER2_IN_OUT },
          { time: 2.0, r: 0 },
        ]
      : [
          { time: 0, r: 0, curve: EASE_POWER2_IN_OUT },
          { time: 0.28, r: 6, curve: EASE_POWER2_OUT },
          { time: 0.58, r: -14, curve: EASE_POWER2_IN },
          { time: 0.88, r: 4, curve: EASE_BACK_OUT },
          { time: 1.68, r: 0 },
          { time: 2.0, r: 0 },
        ],
    forearm: raised
      ? [
          { time: 0, r: 0, curve: EASE_POWER2_IN_OUT },
          { time: 0.3, r: 6, curve: EASE_BACK_OUT },
          { time: 0.62, r: 85, curve: EASE_SINE_IN_OUT },
          { time: 1.32, r: 88, curve: EASE_POWER2_IN_OUT },
          { time: 2.0, r: 0 },
        ]
      : [
          { time: 0, r: 0, curve: EASE_POWER2_IN_OUT },
          { time: 0.28, r: 6, curve: EASE_POWER2_OUT },
          { time: 0.58, r: -63, curve: EASE_POWER2_IN },
          { time: 0.88, r: 4, curve: EASE_BACK_OUT },
          { time: 1.68, r: 0 },
          { time: 2.0, r: 0 },
        ],
    weapon: raised
      ? [
          { time: 0, r: 0, curve: EASE_POWER2_IN_OUT },
          { time: 0.3, r: -14, curve: EASE_BACK_OUT },
          { time: 0.62, r: 55, curve: EASE_SINE_IN_OUT },
          { time: 1.32, r: 56, curve: EASE_POWER2_IN_OUT },
          { time: 2.0, r: 0 },
        ]
      : [
          { time: 0, r: 0, curve: EASE_POWER2_IN_OUT },
          { time: 0.28, r: 0, curve: EASE_POWER2_OUT },
          { time: 0.58, r: 71, curve: EASE_POWER2_IN },
          { time: 0.88, r: -4, curve: EASE_BACK_OUT },
          { time: 1.68, r: 0 },
          { time: 2.0, r: 0 },
        ],
  };

  // 4. POWER (2.5s double-hit + cross-body charge)
  const powerBones: Record<string, TransformKey[]> = {
    root: [
      { time: 0, sy: 1, sx: 1, y: 0, curve: EASE_POWER2_IN },
      { time: 0.72, sy: 0.93, sx: 1.035, y: 0, curve: EASE_BACK_OUT },
      { time: 1.06, sy: 1.055, sx: 0.97, y: -16 * u, curve: EASE_SINE_IN_OUT },
      { time: 1.88, sy: 1.045, sx: 0.98, y: -12 * u, curve: EASE_POWER2_IN_OUT },
      { time: 2.5, sy: 1, sx: 1, y: 0 },
    ],
    hips: [
      { time: 0, y: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.72, y: 9 * u, r: 0, curve: EASE_BACK_OUT },
      { time: 1.06, y: -4 * u, r: 1.5, curve: EASE_POWER2_IN_OUT },
      { time: 1.88, y: -3 * u, r: 1, curve: EASE_POWER2_IN_OUT },
      { time: 2.5, y: 0, r: 0 },
    ],
    chest: [
      { time: 0, r: 0, sy: 1, curve: EASE_POWER2_IN },
      { time: 0.72, r: 4.5, sy: 0.98, curve: EASE_BACK_OUT },
      { time: 1.06, r: -5.5, sy: 1.03, curve: EASE_SINE_IN_OUT },
      { time: 1.88, r: -4.5, sy: 1.02, curve: EASE_POWER2_IN_OUT },
      { time: 2.5, r: 0, sy: 1 },
    ],
    head: [
      { time: 0, r: 0, y: 0, curve: EASE_POWER2_IN },
      { time: 0.76, r: 4.5, y: 4 * u, curve: EASE_BACK_OUT },
      { time: 1.12, r: -8, y: -4 * u, curve: EASE_SINE_IN_OUT },
      { time: 1.94, r: -5, y: -2 * u, curve: EASE_BACK_OUT },
      { time: 2.5, r: 0, y: 0 },
    ],
    "arm-back": [
      { time: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.72, r: -25, curve: EASE_BACK_OUT },
      { time: 1.06, r: raised ? 120 : 152, curve: EASE_SINE_IN_OUT },
      { time: 1.88, r: raised ? 118 : 145, curve: EASE_POWER2_IN_OUT },
      { time: 2.5, r: 0 },
    ],
    arm: [
      { time: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.72, r: 8, curve: EASE_BACK_OUT },
      { time: 1.06, r: raised ? -148 : 15, curve: EASE_SINE_IN_OUT },
      { time: 1.88, r: raised ? -144 : 12, curve: EASE_POWER2_IN_OUT },
      { time: 2.5, r: 0 },
    ],
    forearm: [
      { time: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.72, r: 0, curve: EASE_BACK_OUT },
      { time: 1.06, r: raised ? 90 : -120, curve: EASE_SINE_IN_OUT },
      { time: 1.88, r: raised ? 86 : -116, curve: EASE_POWER2_IN_OUT },
      { time: 2.5, r: 0 },
    ],
    weapon: [
      { time: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.72, r: 0, curve: EASE_BACK_OUT },
      { time: 1.06, r: raised ? 58 : 130, curve: EASE_SINE_IN_OUT },
      { time: 1.88, r: raised ? 55 : 126, curve: EASE_POWER2_IN_OUT },
      { time: 2.5, r: 0 },
    ],
  };

  // 5. TRIUMPH (2.7s sensational victory burst with optional keyPose swap)
  const triumphBones: Record<string, TransformKey[]> = {
    root: [
      { time: 0, sy: 1, sx: 1, y: 0, curve: EASE_POWER2_IN },
      { time: 0.26, sy: 0.91, sx: 1.045, y: 0, curve: EASE_BACK_OUT },
      { time: 0.62, sy: 1.07, sx: 0.965, y: -19 * u, curve: EASE_SINE_IN_OUT },
      { time: 1.11, sy: 1.04, sx: 0.98, y: -14 * u, curve: EASE_SINE_IN_OUT },
      { time: 1.56, sy: 1.07, sx: 0.965, y: -20 * u, curve: EASE_SINE_IN_OUT },
      { time: 1.96, sy: 1.05, sx: 0.975, y: -16 * u, curve: EASE_POWER2_IN_OUT },
      { time: 2.7, sy: 1, sx: 1, y: 0 },
    ],
    hips: [
      { time: 0, y: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.26, y: 11 * u, r: 0, curve: EASE_BACK_OUT },
      { time: 0.62, y: -4 * u, r: 2, curve: EASE_SINE_IN_OUT },
      { time: 1.96, y: -3 * u, r: 1.5, curve: EASE_POWER2_IN_OUT },
      { time: 2.7, y: 0, r: 0 },
    ],
    chest: [
      { time: 0, r: 0, sy: 1, curve: EASE_POWER2_IN },
      { time: 0.26, r: 6, sy: 0.98, curve: EASE_BACK_OUT },
      { time: 0.62, r: -7, sy: 1.04, curve: EASE_SINE_IN_OUT },
      { time: 1.11, r: -5, sy: 1.03, curve: EASE_SINE_IN_OUT },
      { time: 1.56, r: -7, sy: 1.04, curve: EASE_SINE_IN_OUT },
      { time: 1.96, r: -6, sy: 1.03, curve: EASE_POWER2_IN_OUT },
      { time: 2.7, r: 0, sy: 1 },
    ],
    head: [
      { time: 0, r: 0, y: 0, curve: EASE_POWER2_IN },
      { time: 0.31, r: 6, y: 5 * u, curve: EASE_BACK_OUT },
      { time: 0.67, r: -10, y: -5 * u, curve: EASE_SINE_IN_OUT },
      { time: 1.96, r: -8, y: -4 * u, curve: EASE_BACK_OUT },
      { time: 2.7, r: 0, y: 0 },
    ],
    "arm-back": [
      { time: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.26, r: -25, curve: EASE_BACK_OUT },
      { time: 0.62, r: 158, curve: EASE_SINE_IN_OUT },
      { time: 1.11, r: 140, curve: EASE_SINE_IN_OUT },
      { time: 1.56, r: 162, curve: EASE_SINE_IN_OUT },
      { time: 1.96, r: 148, curve: EASE_POWER2_IN_OUT },
      { time: 2.7, r: 0 },
    ],
    arm: [
      { time: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.26, r: 10, curve: EASE_BACK_OUT },
      { time: 0.62, r: raised ? -140 : 15, curve: EASE_SINE_IN_OUT },
      { time: 1.96, r: raised ? -144 : 15, curve: EASE_POWER2_IN_OUT },
      { time: 2.7, r: 0 },
    ],
    forearm: [
      { time: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.26, r: 10, curve: EASE_BACK_OUT },
      { time: 0.62, r: raised ? 85 : -120, curve: EASE_SINE_IN_OUT },
      { time: 1.96, r: raised ? 85 : -120, curve: EASE_POWER2_IN_OUT },
      { time: 2.7, r: 0 },
    ],
    weapon: [
      { time: 0, r: 0, curve: EASE_POWER2_IN },
      { time: 0.26, r: 0, curve: EASE_BACK_OUT },
      { time: 0.62, r: raised ? 55 : 130, curve: EASE_SINE_IN_OUT },
      { time: 1.11, r: raised ? 52 : 124, curve: EASE_SINE_IN_OUT },
      { time: 1.56, r: raised ? 58 : 132, curve: EASE_SINE_IN_OUT },
      { time: 1.96, r: raised ? 55 : 128, curve: EASE_POWER2_IN_OUT },
      { time: 2.7, r: 0 },
    ],
  };

  // 6. BOW (1.6s total-win bow with hand to chest)
  const bowBones: Record<string, TransformKey[]> = {
    root: [
      { time: 0, sy: 1, sx: 1, curve: EASE_POWER2_OUT },
      { time: 0.2, sy: 1.02, sx: 0.99, curve: EASE_POWER2_IN_OUT },
      { time: 0.6, sy: 0.96, sx: 1.02, curve: EASE_POWER2_IN_OUT },
      { time: 0.95, sy: 0.96, sx: 1.02, curve: EASE_POWER2_IN_OUT },
      { time: 1.6, sy: 1, sx: 1 },
    ],
    hips: [
      { time: 0, y: 0, curve: EASE_POWER2_IN_OUT },
      { time: 0.2, y: 0, curve: EASE_POWER2_IN_OUT },
      { time: 0.6, y: 6 * u, curve: EASE_POWER2_IN_OUT },
      { time: 0.95, y: 6 * u, curve: EASE_POWER2_IN_OUT },
      { time: 1.6, y: 0 },
    ],
    chest: [
      { time: 0, r: 0, curve: EASE_POWER2_OUT },
      { time: 0.2, r: -3, curve: EASE_POWER2_IN_OUT },
      { time: 0.6, r: 9, curve: EASE_POWER2_IN_OUT },
      { time: 0.95, r: 9, curve: EASE_POWER2_IN_OUT },
      { time: 1.6, r: 0 },
    ],
    head: [
      { time: 0, r: 0, y: 0, curve: EASE_POWER2_OUT },
      { time: 0.25, r: -4, y: 0, curve: EASE_POWER2_OUT },
      { time: 0.74, r: 10, y: 5 * u, curve: EASE_POWER2_IN_OUT },
      { time: 1.03, r: 10, y: 5 * u, curve: EASE_BACK_OUT },
      { time: 1.6, r: 0, y: 0 },
    ],
    "arm-back": [
      { time: 0, r: 0, curve: EASE_POWER2_OUT },
      { time: 0.2, r: 12, curve: EASE_POWER2_IN_OUT },
      { time: 0.6, r: -38, curve: EASE_POWER2_IN_OUT },
      { time: 0.95, r: -38, curve: EASE_POWER2_IN_OUT },
      { time: 1.6, r: 0 },
    ],
    forearm: [
      { time: 0, r: 0, curve: EASE_POWER2_IN_OUT },
      { time: 0.6, r: raised ? 0 : -10, curve: EASE_POWER2_IN_OUT },
      { time: 0.95, r: raised ? 0 : -10, curve: EASE_POWER2_IN_OUT },
      { time: 1.6, r: 0 },
    ],
    weapon: [
      { time: 0, r: 0, curve: EASE_POWER2_IN_OUT },
      { time: 0.6, r: raised ? -6 : 10, curve: EASE_POWER2_IN_OUT },
      { time: 0.95, r: raised ? -6 : 10, curve: EASE_POWER2_IN_OUT },
      { time: 1.6, r: 0 },
    ],
  };

  return {
    idle: {
      name: "idle",
      duration: 4.8,
      fps: 24,
      loop: true,
      boneTracks: idleBones,
      fxTrack: [{ time: 0, flash: 0, shake: 0, keyPose: 0 }],
    },
    cheer: {
      name: "cheer",
      duration: 2.0,
      fps: 24,
      loop: true,
      boneTracks: cheerBones,
      fxTrack: [
        { time: 0, flash: 0, shake: 0, keyPose: 0 },
        { time: 0.3, flash: 0.6, shake: 0, keyPose: 0 },
        { time: 0.72, flash: 0.45, shake: 0, keyPose: 0 },
        { time: 1.5, flash: 0, shake: 0, keyPose: 0 },
      ],
      events: [
        { time: 0.3, name: "PlaySFX", stringParam: "sfx_cheer_whoosh", floatParam: 0.8 },
        { time: 0.42, name: "SpawnVFX", stringParam: "vfx_gold_sparks", floatParam: 1.0 },
      ],
    },
    strike: {
      name: "strike",
      duration: 2.0,
      fps: 24,
      loop: true,
      boneTracks: strikeBones,
      fxTrack: [
        { time: 0, flash: 0, shake: 0, keyPose: 0 },
        { time: 0.85, flash: 1.0, shake: 1.0, keyPose: 0 },
        { time: 1.4, flash: 0, shake: 0, keyPose: 0 },
      ],
      events: [
        { time: 0.28, name: "PlaySFX", stringParam: "sfx_weapon_windup", floatParam: 0.7 },
        { time: 0.85, name: "OnHit", stringParam: "impact_heavy_slam", floatParam: 1.0, intParam: 1 },
        { time: 0.88, name: "CameraShake", stringParam: "heavy", floatParam: 0.9 },
      ],
    },
    power: {
      name: "power",
      duration: 2.5,
      fps: 24,
      loop: true,
      boneTracks: powerBones,
      fxTrack: [
        { time: 0, flash: 0, shake: 0, keyPose: 0 },
        { time: 0.48, flash: 0.65, shake: 0.6, keyPose: 0 },
        { time: 1.08, flash: 1.0, shake: 0.4, keyPose: 0 },
        { time: 1.9, flash: 0, shake: 0, keyPose: 0 },
      ],
      events: [
        { time: 0.48, name: "OnHit", stringParam: "impact_first_wave", floatParam: 0.75, intParam: 1 },
        { time: 1.06, name: "SpawnVFX", stringParam: "vfx_super_aura_burst", floatParam: 1.0, intParam: 2 },
      ],
    },
    triumph: {
      name: "triumph",
      duration: 2.7,
      fps: 24,
      loop: true,
      boneTracks: triumphBones,
      fxTrack: [
        { time: 0, flash: 0, shake: 0, keyPose: 0 },
        { time: 0.42, flash: 1.0, shake: 0.7, keyPose: 0 },
        { time: 0.47, flash: 0.85, shake: 0, keyPose: project.keyPose ? 1 : 0 },
        { time: 1.9, flash: 1.0, shake: 0, keyPose: 0 },
        { time: 2.5, flash: 0, shake: 0, keyPose: 0 },
      ],
      events: [
        { time: 0.42, name: "SpawnVFX", stringParam: "vfx_sensational_supernova", floatParam: 1.0, intParam: 3 },
        { time: 0.47, name: "CameraShake", stringParam: "mega_burst", floatParam: 1.0 },
      ],
    },
    bow: {
      name: "bow",
      duration: 1.6,
      fps: 24,
      loop: true,
      boneTracks: bowBones,
      fxTrack: [
        { time: 0, flash: 0, shake: 0, keyPose: 0 },
        { time: 0.5, flash: 0.3, shake: 0, keyPose: 0 },
        { time: 1.1, flash: 0, shake: 0, keyPose: 0 },
      ],
      events: [{ time: 0.5, name: "PlaySFX", stringParam: "sfx_armor_bow", floatParam: 0.6 }],
    },
  };
}

/**
 * Bakes all spring bones, follow constraints, and IK constraints of an `AnimationClip` into explicit
 * `boneTracks` keyframes at `sampleRateHz` (default 24Hz) so Spine 4.2 and Unity AnimationClips
 * reproduce secondary physics and constraints 100% deterministically.
 */
export function bakeClipConstraintsToKeyframes(
  project: SpineForgeProject,
  clip: AnimationClip,
  sampleRateHz = 24,
): AnimationClip {
  const anim = new SpineForgeAnimator(project, clip.name);
  const steps = Math.max(2, Math.round(clip.duration * sampleRateHz));
  const dt = clip.duration / steps;

  // Warm up spring state for looping clips so start and end frames stitch seamlessly
  if (clip.loop) {
    for (let i = 0; i <= steps; i++) {
      anim.evaluateAt(i * dt, dt);
    }
  }

  const bakedBoneTracks: Record<string, TransformKey[]> = {};
  for (const bone of project.bones) {
    bakedBoneTracks[bone.name] = [];
  }

  for (let i = 0; i <= steps; i++) {
    const t = Number((i * dt).toFixed(4));
    const frame = anim.evaluateAt(t, dt);
    project.bones.forEach((bone, bIdx) => {
      const p = frame.poses[bIdx]!;
      bakedBoneTracks[bone.name]!.push({
        time: t,
        r: Number(p.r.toFixed(3)),
        x: Number(p.x.toFixed(3)),
        y: Number(p.y.toFixed(3)),
        sx: Number(p.sx.toFixed(4)),
        sy: Number(p.sy.toFixed(4)),
        curve: "linear",
      });
    });
  }

  return {
    ...clip,
    boneTracks: bakedBoneTracks,
  };
}
