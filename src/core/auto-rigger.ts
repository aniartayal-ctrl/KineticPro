/**
 * 1-Click AI Auto-Rigger (`src/core/auto-rigger.ts`)
 *
 * Automatically constructs or refines a complete parent-first skeleton, capsule weight envelopes,
 * 2-bone analytical IK, spring cloth/hair physics, part-to-bone/skin bindings, Delaunay meshes,
 * and 6 procedural animations + Unity AnimationEvent triggers from part bounding boxes and optional
 * Apple Vision (`VNDetectHumanBodyPoseRequest`) pose landmarks.
 */

import { generateProceduralClips } from "./animator";
import { RIG_BONE_PALETTE, type RigBone, type RigIkConstraint, type RigPart, type SpineForgeProject } from "./schema";
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
