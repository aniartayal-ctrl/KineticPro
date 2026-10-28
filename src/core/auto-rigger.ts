/**
 * 1-Click AI Auto-Rigger (`src/core/auto-rigger.ts`)
 *
 * Automatically constructs or refines a complete parent-first skeleton, capsule weight envelopes,
 * 2-bone analytical IK, spring cloth/hair physics, part-to-bone/skin bindings, Delaunay meshes,
 * and 6 procedural animations + Unity AnimationEvent triggers from part bounding boxes and optional
 * Apple Vision (`VNDetectHumanBodyPoseRequest`) pose landmarks.
 */

import { EASE_SINE_IN_OUT, generateProceduralClips } from "./animator";
import {
  RIG_BONE_PALETTE,
  type AnimationClip,
  type RigBone,
  type RigIkConstraint,
  type RigPart,
  type SpineForgeProject,
  type TransformKey,
} from "./schema";
import { buildPartMesh } from "./weights";

export type PoseLandmarkMap = Partial<
  Record<
    "root" | "hips" | "chest" | "head" | "leftShoulder" | "rightShoulder" | "rightElbow" | "rightWrist",
    [number, number]
  >
>;

function partCenter(p: RigPart): [number, number] {
  return [Number((p.x + p.w * 0.5).toFixed(4)), Number((p.y + p.h * 0.5).toFixed(4))];
}

/**
 * Automatically rigs a `SpineForgeProject` in one click:
 * - Places anatomical pivots (`root`, `hips`, `chest`, `head`, `arm-back`, `arm`, `forearm`, `weapon`,
 *   plus secondary spring bones `cape` / `hair` / `hem` and 2-bone IK `ik-weapon-hand`)
 * - Assigns capsule envelopes and feather radii
 * - Binds rigid vs. skinned parts and draw-order swaps
 * - Solves Delaunay meshes + 4-bone normalized weights and generates all 6 procedural clips.
 */
export function autoRigProject(
  project: SpineForgeProject,
  landmarks?: PoseLandmarkMap,
  options: { meshDensity?: "low" | "medium" | "high"; weightMode?: "hybrid" | "heat" | "capsule" } = {},
): SpineForgeProject {
  if (isCreatureProject(project)) return autoRigCreature(project, options);
  const byName = new Map<string, RigPart>(project.parts.map((p) => [p.name.toLowerCase(), p]));

  const findPart = (...keywords: string[]): RigPart | undefined => {
    for (const kw of keywords) {
      const exact = byName.get(kw);
      if (exact) return exact;
      const partial = project.parts.find((p) => p.name.toLowerCase().includes(kw));
      if (partial) return partial;
    }
    return undefined;
  };

  const headPart = findPart("head", "face", "helmet", "crown");
  const bodyPart = findPart("body", "torso", "dress", "armor", "pelvis");
  const armBackPart = findPart("arm-upper-r", "arm-back", "back-arm", "right-arm");
  const armUpperPart = findPart("arm-upper-l", "arm-upper", "upper-arm", "arm-front", "left-arm");
  const forearmPart = findPart("arm-lower-l", "forearm", "gauntlet", "hand-l", "hand");
  const weaponPart = findPart("hammer", "staff", "weapon", "sword", "axe", "spear");
  const pauldronPart = findPart("pauldron", "shoulder");
  const hairPart = findPart("hair-bangs", "hair-back", "hair", "mane", "braid");

  const headPivot: [number, number] = landmarks?.head ??
    (headPart ? [Number((headPart.x + headPart.w * 0.5).toFixed(4)), Number((headPart.y + headPart.h * 0.82).toFixed(4))] : [0.5, 0.16]);

  const chestPivot: [number, number] = landmarks?.chest ?? [
    Number((headPivot[0] * 0.5 + 0.25).toFixed(4)),
    Number(Math.min(0.45, headPivot[1] + 0.22).toFixed(4)),
  ];

  const hipsPivot: [number, number] = landmarks?.hips ?? [0.5, Number(Math.min(0.65, chestPivot[1] + 0.18).toFixed(4))];

  const armBackPivot: [number, number] = landmarks?.leftShoulder ??
    (armBackPart ? [Number((armBackPart.x + armBackPart.w * 0.55).toFixed(4)), Number((armBackPart.y + armBackPart.h * 0.12).toFixed(4))] : [0.33, 0.255]);

  const armPivot: [number, number] = landmarks?.rightShoulder ??
    (armUpperPart ? [Number((armUpperPart.x + armUpperPart.w * 0.45).toFixed(4)), Number((armUpperPart.y + armUpperPart.h * 0.15).toFixed(4))] : [0.72, 0.22]);

  const forearmPivot: [number, number] = landmarks?.rightElbow ??
    (forearmPart ? [Number((forearmPart.x + forearmPart.w * 0.25).toFixed(4)), Number((forearmPart.y + forearmPart.h * 0.25).toFixed(4))] : [0.78, 0.34]);

  const weaponPivot: [number, number] = landmarks?.rightWrist ??
    (weaponPart ? [Number((weaponPart.x + weaponPart.w * 0.55).toFixed(4)), Number((weaponPart.y + weaponPart.h * 0.35).toFixed(4))] : [0.85, 0.42]);

  const bones: RigBone[] = [
    { name: "root", x: 0.5, y: 0.975, color: RIG_BONE_PALETTE[0] },
    {
      name: "hips",
      parent: "root",
      x: hipsPivot[0],
      y: hipsPivot[1],
      regions: [[hipsPivot[0] - 0.02, hipsPivot[1] - 0.14, hipsPivot[0], hipsPivot[1] - 0.02, 0.11]],
      feather: 0.07,
      color: RIG_BONE_PALETTE[1],
    },
    {
      name: "chest",
      parent: "hips",
      x: chestPivot[0],
      y: chestPivot[1],
      regions: [
        [chestPivot[0] - 0.04, chestPivot[1] - 0.12, chestPivot[0] + 0.02, chestPivot[1] - 0.04, 0.1],
        [0.36, chestPivot[1] - 0.14, 0.65, chestPivot[1] - 0.14, 0.05],
      ],
      feather: 0.05,
      color: RIG_BONE_PALETTE[2],
    },
    {
      name: "head",
      parent: "chest",
      x: headPivot[0],
      y: headPivot[1],
      color: RIG_BONE_PALETTE[3],
    },
  ];

  const bodySkin = ["root", "hips", "chest"];

  // Add secondary spring bones for cape / hair / dress hem
  if (hairPart) {
    const [hx, hy] = partCenter(hairPart);
    bones.push(
      {
        name: "hair-left",
        parent: "head",
        x: Number(Math.max(0.1, hx - 0.08).toFixed(4)),
        y: Number(hy.toFixed(4)),
        regions: [[hx - 0.1, hy, hx - 0.14, hy + 0.18, 0.04]],
        feather: 0.03,
        spring: { stiffness: 55, damping: 6, gain: [8, 3], wind: 1.5 },
        color: RIG_BONE_PALETTE[4],
      },
      {
        name: "hair-right",
        parent: "head",
        x: Number(Math.min(0.9, hx + 0.1).toFixed(4)),
        y: Number(hy.toFixed(4)),
        regions: [[hx + 0.1, hy + 0.04, hx + 0.13, hy + 0.18, 0.03]],
        feather: 0.03,
        spring: { stiffness: 55, damping: 6, gain: [8, 3], wind: 1.5 },
        color: RIG_BONE_PALETTE[5],
      },
    );
    bones.push({
      name: "hem",
      parent: "hips",
      x: 0.3,
      y: 0.62,
      regions: [[0.18, 0.82, 0.06, 0.94, 0.05]],
      feather: 0.05,
      spring: { stiffness: 50, damping: 6, gain: [7, 5], wind: 1.6 },
      color: RIG_BONE_PALETTE[6],
    });
    bodySkin.push("hem");
  } else {
    bones.push(
      {
        name: "cape",
        parent: "chest",
        x: 0.33,
        y: 0.18,
        regions: [[0.2, 0.3, 0.13, 0.55, 0.06]],
        feather: 0.06,
        spring: { stiffness: 70, damping: 8, gain: [6, 3], wind: 1.2 },
        color: RIG_BONE_PALETTE[4],
      },
      {
        name: "cape-tail",
        parent: "cape",
        x: 0.15,
        y: 0.55,
        regions: [[0.12, 0.62, 0.07, 0.8, 0.06]],
        feather: 0.05,
        spring: { stiffness: 45, damping: 5, gain: [9, 4], wind: 2.0 },
        color: RIG_BONE_PALETTE[5],
      },
    );
    bodySkin.push("cape", "cape-tail");
  }

  bones.push({
    name: "arm-back",
    parent: "chest",
    x: armBackPivot[0],
    y: armBackPivot[1],
    color: RIG_BONE_PALETTE[6],
  });

  if (pauldronPart) {
    bones.push({
      name: "pauldron",
      parent: "chest",
      x: Number((pauldronPart.x + pauldronPart.w * 0.5).toFixed(4)),
      y: Number((pauldronPart.y + pauldronPart.h * 0.6).toFixed(4)),
      follow: { bone: "arm", ratio: 0.3 },
      color: RIG_BONE_PALETTE[7],
    });
  }

  bones.push(
    {
      name: "arm",
      parent: "chest",
      x: armPivot[0],
      y: armPivot[1],
      color: RIG_BONE_PALETTE[8],
    },
    {
      name: "forearm",
      parent: "arm",
      x: forearmPivot[0],
      y: forearmPivot[1],
      color: RIG_BONE_PALETTE[9],
    },
    {
      name: "weapon",
      parent: "forearm",
      x: weaponPivot[0],
      y: weaponPivot[1],
      color: RIG_BONE_PALETTE[10],
    },
    {
      name: "ik-weapon-hand",
      parent: "root",
      x: weaponPivot[0],
      y: weaponPivot[1],
      color: "#ffffff",
    },
  );

  const ikConstraints: RigIkConstraint[] = [
    {
      name: "weapon-limb-ik",
      bones: ["arm", "forearm"],
      target: "ik-weapon-hand",
      bendPositive: project.action !== "raise",
      mix: 0,
    },
  ];

  const density = options.meshDensity ?? "high";
  const weightMode = options.weightMode ?? "hybrid";

  const updatedParts: RigPart[] = project.parts.map((part) => {
    const low = part.name.toLowerCase();
    let nextPart: RigPart = { ...part, meshDensity: density, mesh: undefined };

    if (part === bodyPart || low.includes("body") || low.includes("torso")) {
      nextPart = { ...nextPart, bone: undefined, skin: bodySkin };
    } else if (part === hairPart || low.includes("hair")) {
      nextPart = { ...nextPart, bone: undefined, skin: ["head", "hair-left", "hair-right"] };
    } else if (part === headPart || low.includes("head")) {
      nextPart = { ...nextPart, bone: "head", skin: undefined };
    } else if (part === armBackPart || low.includes("arm-back") || low.includes("arm-upper-r") || low === "arm-lower-r" || low === "hand-r") {
      nextPart = {
        ...nextPart,
        bone: "arm-back",
        skin: undefined,
        swap: bodyPart ? { before: bodyPart.name, bone: "arm-back", beyond: 75 } : part.swap,
      };
    } else if (part === pauldronPart || low.includes("pauldron")) {
      nextPart = { ...nextPart, bone: "pauldron", skin: undefined };
    } else if (part === armUpperPart || low.includes("arm-upper-l") || low.includes("arm-upper") || low.includes("arm-front")) {
      nextPart = { ...nextPart, bone: "arm", skin: undefined };
    } else if (part === forearmPart || low.includes("arm-lower-l") || low.includes("forearm") || low === "hand-l") {
      nextPart = { ...nextPart, bone: "forearm", skin: undefined };
    } else if (part === weaponPart || low.includes("hammer") || low.includes("staff") || low.includes("weapon")) {
      nextPart = { ...nextPart, bone: "weapon", skin: undefined };
    } else {
      nextPart = { ...nextPart, bone: "chest", skin: undefined };
    }

    return nextPart;
  });

  const nextProject: SpineForgeProject = {
    ...project,
    bones,
    ikConstraints,
    parts: updatedParts,
  };

  for (const part of nextProject.parts) {
    part.mesh = buildPartMesh(nextProject, part, { weightMode });
  }
  nextProject.animations = generateProceduralClips(nextProject);
  return nextProject;
}

const SIDE = /(?:^|[-_ ])(l|r|left|right)$/i;

/** "wing_L" -> "l", "arm-right" -> "r", "tail" -> undefined. */
function partSide(name: string): "l" | "r" | undefined {
  const m = SIDE.exec(name);
  if (!m) return undefined;
  return m[1]!.toLowerCase().startsWith("l") ? "l" : "r";
}

const r4 = (v: number) => Number(v.toFixed(4));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Point of the part's box nearest to `[x, y]`: where a limb meets the body. */
function attachPoint(p: RigPart, [x, y]: [number, number]): [number, number] {
  return [r4(clamp(x, p.x, p.x + p.w)), r4(clamp(y, p.y, p.y + p.h))];
}

/** Box corner farthest from `from`: the free end of a wing or tail. */
function farCorner(p: RigPart, [x, y]: [number, number]): [number, number] {
  const corners: [number, number][] = [
    [p.x, p.y],
    [p.x + p.w, p.y],
    [p.x, p.y + p.h],
    [p.x + p.w, p.y + p.h],
  ];
  return corners.reduce((best, c) => (Math.hypot(c[0] - x, c[1] - y) > Math.hypot(best[0] - x, best[1] - y) ? c : best));
}

const lerp2 = (a: [number, number], b: [number, number], t: number): [number, number] => [r4(a[0] + (b[0] - a[0]) * t), r4(a[1] + (b[1] - a[1]) * t)];

/** Wings or a tail mean a creature (dragon, bird, beast), not a humanoid hero. */
export function isCreatureProject(project: Pick<SpineForgeProject, "parts">): boolean {
  return project.parts.some((p) => /wing|tail/i.test(p.name) && !/cape-tail|ponytail/i.test(p.name));
}

/**
 * Creature rig: body splits into `hips` / `chest`, `head` sits at the neck, and wings, tail, mane and
 * fins get spring chains anchored where each part meets the body. Front limbs reuse the humanoid
 * `arm` / `arm-back` names so the standard clips move them too.
 */
function autoRigCreature(
  project: SpineForgeProject,
  options: { meshDensity?: "low" | "medium" | "high"; weightMode?: "hybrid" | "heat" | "capsule" },
): SpineForgeProject {
  const parts = project.parts;
  const find = (re: RegExp, side?: "l" | "r") => parts.find((p) => re.test(p.name) && (side === undefined || partSide(p.name) === side));
  const body = find(/body|torso|chest/) ?? parts.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const head = find(/head|face/);

  const bodyCenter = partCenter(body);
  const chestPivot: [number, number] = [bodyCenter[0], r4(body.y + body.h * 0.3)];
  const hipsPivot: [number, number] = [bodyCenter[0], r4(body.y + body.h * 0.68)];
  const bottom = Math.max(...parts.map((p) => p.y + p.h));

  const bones: RigBone[] = [
    { name: "root", x: bodyCenter[0], y: r4(Math.min(0.99, bottom)), color: RIG_BONE_PALETTE[0] },
    { name: "hips", parent: "root", x: hipsPivot[0], y: hipsPivot[1], color: RIG_BONE_PALETTE[1] },
    { name: "chest", parent: "hips", x: chestPivot[0], y: chestPivot[1], color: RIG_BONE_PALETTE[2] },
  ];
  let paletteIndex = 3;
  const add = (bone: Omit<RigBone, "color">) => {
    bones.push({ ...bone, color: RIG_BONE_PALETTE[paletteIndex++ % RIG_BONE_PALETTE.length] });
    return bone.name;
  };
  const binding = new Map<RigPart, Pick<RigPart, "bone" | "skin">>();

  if (head) {
    const neck = attachPoint(head, chestPivot);
    add({ name: "head", parent: "chest", x: neck[0], y: neck[1] });
    binding.set(head, { bone: "head" });
  }
  const headBone = head ? "head" : "chest";
  const headCenter = head ? partCenter(head) : chestPivot;

  /** Two- or three-bone spring chain from where `part` meets `anchor` out to its far corner. */
  const chain = (part: RigPart, name: string, parent: string, anchor: [number, number], links: number, spring: RigBone["spring"]) => {
    const base = attachPoint(part, anchor);
    const tip = farCorner(part, base);
    const names: string[] = [];
    for (let i = 0; i < links; i++) {
      const at = lerp2(base, tip, i / links);
      const length = r4(Math.hypot(tip[0] - base[0], tip[1] - base[1]) / links);
      names.push(add({ name: i === 0 ? name : `${name}-${i + 1}`, parent: i === 0 ? parent : names[i - 1], x: at[0], y: at[1], length, spring: i === 0 ? undefined : spring }));
    }
    binding.set(part, { skin: names });
  };

  for (const side of ["l", "r"] as const) {
    const wing = find(/wing/, side);
    if (wing) chain(wing, `wing-${side}`, "chest", chestPivot, 2, { stiffness: 60, damping: 7, gain: [6, 4], wind: 1.4 });
  }
  const tail = find(/tail/);
  if (tail) chain(tail, "tail", "hips", hipsPivot, 3, { stiffness: 46, damping: 5, gain: [9, 4], wind: 2.1 });
  const mane = find(/mane|hair/);
  if (mane) chain(mane, "mane", headBone, headCenter, 2, { stiffness: 54, damping: 5, gain: [7, 3], wind: 1.8 });
  const spines = find(/spine|fin-back|crest/);
  if (spines) {
    const at = attachPoint(spines, chestPivot);
    binding.set(spines, { bone: add({ name: "spines", parent: "chest", x: at[0], y: at[1], spring: { stiffness: 70, damping: 8, gain: [4, 2], wind: 1.0 } }) });
  }
  const mouth = find(/mouth|jaw/);
  if (mouth) binding.set(mouth, { bone: add({ name: "jaw", parent: headBone, x: r4(mouth.x + mouth.w * 0.5), y: r4(mouth.y + mouth.h * 0.2) }) });

  for (const side of ["l", "r"] as const) {
    const fin = find(/ear|fin(?!-back)/, side);
    if (fin && fin !== spines) {
      const at = attachPoint(fin, headCenter);
      binding.set(fin, { bone: add({ name: `earfin-${side}`, parent: headBone, x: at[0], y: at[1], spring: { stiffness: 64, damping: 6, gain: [6, 3], wind: 1.5 } }) });
    }
    // The character's left limb is the far one in a three-quarter view, like `arm-back` on a hero.
    const arm = find(/arm|claw|hand/, side);
    if (arm) binding.set(arm, { bone: add({ name: side === "l" ? "arm" : "arm-back", parent: "chest", x: r4(arm.x + arm.w * 0.5), y: r4(arm.y + arm.h * 0.12) }) });
    const leg = find(/leg|foot/, side);
    if (leg) binding.set(leg, { bone: add({ name: `leg-${side}`, parent: "hips", x: r4(leg.x + leg.w * 0.5), y: r4(leg.y + leg.h * 0.18) }) });
  }

  const density = options.meshDensity ?? "high";
  const updatedParts: RigPart[] = parts.map((part) => {
    const bound = part === body ? { skin: ["hips", "chest"] } : (binding.get(part) ?? { bone: /eye|horn|brow|lid/i.test(part.name) ? headBone : "chest" });
    return { ...part, meshDensity: density, mesh: undefined, bone: bound.bone, skin: bound.skin };
  });

  const nextProject: SpineForgeProject = { ...project, bones, ikConstraints: [], parts: updatedParts };
  for (const part of nextProject.parts) {
    part.mesh = buildPartMesh(nextProject, part, { weightMode: options.weightMode ?? "hybrid" });
  }
  nextProject.animations = addCreatureTracks(generateProceduralClips(nextProject), nextProject);
  return nextProject;
}

/**
 * Adapts humanoid clips to a creature rig: drops tracks for bones the creature lacks and layers a
 * wing flap, tail sway and jaw open over each clip, scaled by how energetic the clip is.
 */
export function addCreatureTracks(
  clips: Record<string, AnimationClip>,
  project: Pick<SpineForgeProject, "bones">,
): Record<string, AnimationClip> {
  const have = new Set(project.bones.map((b) => b.name));
  const out: Record<string, AnimationClip> = {};
  for (const [id, clip] of Object.entries(clips)) {
    const calm = /idle|bow|anticipation|tease/i.test(id);
    const boneTracks: Record<string, TransformKey[]> = {};
    for (const [bone, keys] of Object.entries(clip.boneTracks)) if (have.has(bone)) boneTracks[bone] = keys;

    const d = clip.duration;
    // Whole beats per clip keep the loop seamless.
    const beats = Math.max(1, Math.round(d / (calm ? 2.4 : 0.6)));
    const wave = (amp: number, phase = 0): TransformKey[] => {
      const keys: TransformKey[] = [];
      for (let i = 0; i <= beats * 2; i++) {
        keys.push({ time: i === beats * 2 ? d : Number(((d * i) / (beats * 2)).toFixed(3)), r: (i + phase) % 2 === 0 ? -amp : amp, curve: i < beats * 2 ? EASE_SINE_IN_OUT : undefined });
      }
      return keys;
    };
    const flap = calm ? 6 : 22;
    if (have.has("wing-l")) boneTracks["wing-l"] = wave(flap);
    if (have.has("wing-r")) boneTracks["wing-r"] = wave(-flap);
    if (have.has("tail")) boneTracks["tail"] = wave(calm ? 4 : 9, 1);
    if (have.has("jaw") && !calm) {
      boneTracks["jaw"] = [
        { time: 0, r: 0, curve: EASE_SINE_IN_OUT },
        { time: Number((d * 0.3).toFixed(3)), r: -12, curve: EASE_SINE_IN_OUT },
        { time: Number((d * 0.6).toFixed(3)), r: 0 },
        { time: d, r: 0 },
      ];
    }
    out[id] = { ...clip, boneTracks };
  }
  return out;
}
