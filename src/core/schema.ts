/**
 * SpineForge Canonical Project Schema
 * Supports:
 * 1. Layered Cut-Out Parts & Contour Delaunay Meshes
 * 2. 4-Bone Linear Blend Skinning (LBS) + Capsule Envelopes + Geodesic Heat Weights + Brush Overrides
 * 3. Forward Kinematics (FK) + 2-Bone Analytical IK + Follow Constraints + Live/Baked Spring Physics
 * 4. Multi-Track Keyframe Animations (Bezier/Linear/Stepped) + Free-Form Deformation (FFD) + Draw Order Swaps
 * 5. Triple Unity Export (Spine 4.2 JSON+Atlas, Zero-Dependency Unity C# .sfrig.json, Baked Flipbook Sprite Sheets)
 */

/** Capsule envelope [ax, ay, bx, by, radius] in normalized rig coordinates (x in widths, y & radius in heights). */
export type RigCapsuleRegion = [number, number, number, number, number];

export type RigSpringConfig = {
  /** Angular stiffness of the secondary-motion spring (typical: 35..90). */
  stiffness: number;
  /** Angular damping (typical: 4..12). */
  damping: number;
  /** Degrees of lag per 1000 px/s^2 of pivot acceleration [gainX, gainY]. */
  gain: [number, number];
  /** Optional ambient wind sway amplitude in degrees. */
  wind?: number;
};

export type RigFollowConstraint = {
  /** Target bone name whose local rotation is partially inherited. */
  bone: string;
  /** Share of rotation inherited (-1..1, e.g. 0.3 for a pauldron riding an arm). */
  ratio: number;
};

export type RigBone = {
  name: string;
  parent?: string;
  /** Bind pivot X in normalized character width [0..1]. */
  x: number;
  /** Bind pivot Y in normalized character height [0..1] (0 = top, 1 = bottom in studio space). */
  y: number;
  /** Visual bone length in normalized character height (default: 0.08). */
  length?: number;
  /** Optional bind rotation in degrees (clockwise in studio Y-down space). */
  bindRotation?: number;
  /** Capsule regions for envelope auto-weighting. */
  regions?: RigCapsuleRegion[];
  /** Feather falloff distance in normalized height (default: 0.05). */
  feather?: number;
  /** Real-time or bakeable spring physics parameters. */
  spring?: RigSpringConfig;
  /** Partial rotation constraint from another bone. */
  follow?: RigFollowConstraint;
  /** Display color in the studio viewport (#rrggbb). */
  color?: string;
};

export type RigIkConstraint = {
  name: string;
  /** 1 or 2 bone names [parentBone, childBone]. */
  bones: [string] | [string, string];
  /** Target bone name (usually a root-parented IK handle). */
  target: string;
  /** Bend direction (+1 for clockwise knee/elbow, -1 for counter-clockwise). */
  bendPositive: boolean;
  /** Blend between FK (0) and IK (1). */
  mix: number;
  /** Optional softness near full extension (in normalized units). */
  softness?: number;
};

export type PartMeshData = {
  /** Vertex positions in rig pixel space [x0, y0, x1, y1, ...]. */
  positions: number[];
  /** Normalized texture UVs within the part image [u0, v0, u1, v1, ...]. */
  uvs: number[];
  /** 4 bone indices per vertex [j0, j1, j2, j3, ...] indexing into project.bones. */
  joints: number[];
  /** 4 bone weights per vertex [w0, w1, w2, w3, ...] summing to 1.0. */
  weights: number[];
  /** Triangle indices (3 per triangle). */
  indices: number[];
  /** Number of boundary hull vertices at the start of `positions` (required by Spine 4.2 mesh format). */
  hullCount: number;
};

export type DrawOrderSwapRule = {
  /** Move this part right before `before` part in the draw order... */
  before: string;
  /** ...whenever `bone` local rotation exceeds `beyond` degrees (sign indicates direction). */
  bone: string;
  beyond: number;
};

export type RigPart = {
  name: string;
  /** Relative URL or path to the trimmed part PNG/WebP. */
  src: string;
  /** Normalized top-left X in character width [0..1]. */
  x: number;
  /** Normalized top-left Y in character height [0..1]. */
  y: number;
  /** Normalized width in character width [0..1]. */
  w: number;
  /** Normalized height in character height [0..1]. */
  h: number;
  /** Single bone name if this part is rigid (100% bound to one bone). */
  bone?: string;
  /** List of bone names that influence this part's mesh (first bone receives unallocated remainder weight). */
  skin?: string[];
  /** Automatic dynamic draw-order swap rule based on bone angle. */
  swap?: DrawOrderSwapRule;
  /** Mesh generation density preset or custom triangulated mesh data. */
  meshDensity?: "low" | "medium" | "high";
  /** Explicit contour/Steiner mesh and custom painted weights. Recomputed if omitted. */
  mesh?: PartMeshData;
  /** Optional tint hex (#ffffff). */
  tint?: string;
  /** Blend mode for rendering in WebGL2 / Unity / Spine. */
  blendMode?: "normal" | "additive" | "multiply" | "screen";
  /** Alternate layer (closed eyelid, shut mouth) that is off until a visibility key shows it. */
  hidden?: boolean;
};

export type CurveType = "linear" | "stepped" | [number, number, number, number];

export type TransformKey = {
  time: number;
  /** Rotation delta in degrees from bind pose. */
  r?: number;
  /** Translation delta X in rig pixels. */
  x?: number;
  /** Translation delta Y in rig pixels. */
  y?: number;
  /** Scale X multiplier (default 1). */
  sx?: number;
  /** Scale Y multiplier (default 1). */
  sy?: number;
  curve?: CurveType;
};

export type IkMixKey = {
  time: number;
  mix: number;
  bendPositive?: boolean;
  curve?: CurveType;
};

export type DeformKey = {
  time: number;
  /** Per-vertex [dx0, dy0, dx1, dy1, ...] offset in rig pixel space (Free-Form Deformation). */
  offsets: number[];
  curve?: CurveType;
};

export type DrawOrderKey = {
  time: number;
  /** Explicit back-to-front part order at this keyframe. */
  order: string[];
};

export type VisibilityKey = {
  time: number;
  /** Stepped: the part stays shown or hidden until the next key. */
  visible: boolean;
};

export type FxKey = {
  time: number;
  /** Rim/power flash intensity [0..1]. */
  flash?: number;
  /** Camera/root screen shake amplitude [0..1]. */
  shake?: number;
  /** Key pose replacement toggle (0 = live rig, 1 = painted keyPose). */
  keyPose?: number;
  curve?: CurveType;
};

export type AnimationEventKey = {
  time: number;
  /** Unity AnimationEvent / Spine event name (e.g. "OnHit", "SpawnVFX", "PlaySFX", "CameraShake"). */
  name: string;
  /** Optional string payload (e.g. "fx_star_slam"). */
  stringParam?: string;
  /** Optional float payload (e.g. shake intensity 0.85). */
  floatParam?: number;
  /** Optional int payload (e.g. tier index 2). */
  intParam?: number;
};

export type RigSkinVariant = {
  name: string;
  label: string;
  /** Primary color tint (#rrggbb). */
  tint: string;
  /** Rim light color override (#rrggbb). */
  rimColor: string;
  /** Power flash color override (#rrggbb). */
  flashColor: string;
  /** Optional weapon/part scale multiplier for evolving symbols/tiers. */
  weaponScale?: number;
};

export type AnimationClip = {
  name: string;
  /** Clip duration in seconds. */
  duration: number;
  /** Playback/bake frame rate (default 24 or 30). */
  fps: number;
  /** Whether the clip loops seamlessly. */
  loop: boolean;
  /** Per-bone transform keyframes. */
  boneTracks: Record<string, TransformKey[]>;
  /** Optional IK constraint keyframes. */
  ikTracks?: Record<string, IkMixKey[]>;
  /** Optional per-part Free-Form Deformation (FFD) vertex offset keyframes. */
  deformTracks?: Record<string, DeformKey[]>;
  /** Optional explicit draw-order timeline keys. */
  drawOrderTrack?: DrawOrderKey[];
  /** Optional per-part show/hide keys (blinks, mouth shapes). Parts without keys keep their `hidden` flag. */
  visibilityTracks?: Record<string, VisibilityKey[]>;
  /** Optional shader flash / shake / keyPose swap track. */
  fxTrack?: FxKey[];
  /** Optional Unity AnimationEvent & Spine Event triggers along the timeline. */
  events?: AnimationEventKey[];
};

export type SpineForgeProject = {
  version: "1.0.0";
  id: string;
  title: string;
  /** Reference full-character image path/URL. */
  src: string;
  /** Character design width in pixels. */
  width: number;
  /** Character design height in pixels. */
  height: number;
  /** Primary weapon/prop action style for procedural clip synthesis. */
  action: "slam" | "raise";
  /** Extra stage overhang around the character for raised weapons/effects (fractions of width/height). */
  frame: {
    left: number;
    top: number;
    right: number;
    bottom?: number;
  };
  /** Rim & flash shader colors. */
  palette: {
    rim: string;
    flash: string;
  };
  /** Parent-first bone hierarchy. */
  bones: RigBone[];
  /** Analytical 2-bone IK constraints. */
  ikConstraints: RigIkConstraint[];
  /** Back-to-front cut-out parts. */
  parts: RigPart[];
  /** Optional multi-skin / evolving tier wardrobe (Tier 1 Base, Tier 2 Awakened, Tier 3 Ascended). */
  skins?: RigSkinVariant[];
  /** Optional painted victory key pose swapped at peak flash. */
  keyPose?: {
    src: string;
    x: number;
    y: number;
    w: number;
    h: number;
  };
  /** Authored + procedural animation clips keyed by clip name. */
  animations: Record<string, AnimationClip>;
};

export const RIG_BONE_PALETTE = [
  "#64748b",
  "#ef4444",
  "#22c55e",
  "#3b82f6",
  "#eab308",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#a855f7",
  "#84cc16",
  "#14b8a6",
  "#f43f5e",
] as const;

export function validateProject(project: SpineForgeProject): string[] {
  const errors: string[] = [];
  if (!project.id || !/^[a-z0-9-_]+$/i.test(project.id)) {
    errors.push(`Invalid project id "${project.id}"`);
  }
  if (!(project.width > 0 && project.height > 0)) {
    errors.push("Project width and height must be positive");
  }
  if (project.bones.length === 0) {
    errors.push("Project must have at least one root bone");
  }
  const seenBones = new Set<string>();
  for (const bone of project.bones) {
    if (seenBones.has(bone.name)) {
      errors.push(`Duplicate bone name "${bone.name}"`);
    }
    if (bone.parent && !seenBones.has(bone.parent)) {
      errors.push(`Bone "${bone.name}" appears before its parent "${bone.parent}"`);
    }
    if (!bone.parent && seenBones.size > 0 && bone.name !== "root") {
      errors.push(`Bone "${bone.name}" has no parent`);
    }
    seenBones.add(bone.name);
  }
  for (const bone of project.bones) {
    if (bone.follow && !seenBones.has(bone.follow.bone)) {
      errors.push(`Bone "${bone.name}" follows unknown bone "${bone.follow.bone}"`);
    }
  }
  for (const ik of project.ikConstraints ?? []) {
    if (!seenBones.has(ik.target)) {
      errors.push(`IK "${ik.name}" targets unknown bone "${ik.target}"`);
    }
    for (const b of ik.bones) {
      if (!seenBones.has(b)) {
        errors.push(`IK "${ik.name}" references unknown bone "${b}"`);
      }
    }
  }
  const partNames = new Set(project.parts.map((p) => p.name));
  for (const part of project.parts) {
    if (!(part.w > 0 && part.h > 0)) {
      errors.push(`Part "${part.name}" must have positive w and h`);
    }
    const bones = part.skin && part.skin.length > 0 ? part.skin : part.bone ? [part.bone] : [];
    if (bones.length === 0) {
      errors.push(`Part "${part.name}" must specify either bone or skin`);
    }
    for (const b of bones) {
      if (!seenBones.has(b)) {
        errors.push(`Part "${part.name}" references unknown bone "${b}"`);
      }
    }
    if (part.swap) {
      if (!seenBones.has(part.swap.bone)) {
        errors.push(`Part "${part.name}" swap references unknown bone "${part.swap.bone}"`);
      }
      if (!partNames.has(part.swap.before)) {
        errors.push(`Part "${part.name}" swap references unknown part "${part.swap.before}"`);
      }
    }
  }
  for (const [clipName, clip] of Object.entries(project.animations ?? {})) {
    for (const partName of Object.keys(clip.visibilityTracks ?? {})) {
      if (!partNames.has(partName)) {
        errors.push(`Clip "${clipName}" shows or hides unknown part "${partName}"`);
      }
    }
  }
  return errors;
}
