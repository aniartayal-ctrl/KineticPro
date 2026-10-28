/**
 * Shared character import: upload a PSD/PNG/WebP to `/api/cut-parts` and build a project.
 * Used by the Import pane, window drag-drop, and the native Mac shell open/drop path.
 */

import { projectFromCut, type CutResult } from "./import-project";
import type { SpineForgeProject } from "./schema";

export const IMPORT_IMAGE_ACCEPT = ".png,.webp,.psd,.jpg,.jpeg";

const IMPORT_EXT = /\.(png|webp|psd|jpe?g)$/i;

export function isImportableImageName(name: string): boolean {
  return IMPORT_EXT.test(name);
}

/** Normalized landmark map passed through to the Python amodal cutter. */
export type CutPoseLandmarks = Partial<
  Record<
    | "hips"
    | "chest"
    | "head"
    | "leftShoulder"
    | "rightShoulder"
    | "leftElbow"
    | "rightElbow"
    | "leftWrist"
    | "rightWrist"
    | "leftHip"
    | "rightHip"
    | "leftKnee"
    | "rightKnee"
    | "leftAnkle"
    | "rightAnkle",
    [number, number]
  >
>;

export type CutUploadOptions = {
  alphaThreshold?: number;
  jointCoverRadius?: number;
  inpaintTorso?: boolean;
  /** Prefer pose-driven capsules + ball-joint covers (B-gated amodal path). */
  usePose?: boolean;
  /** presentation = promo/dealer poses; humanoid-v1 = full limbs; legacy = 5-part hero. */
  taxonomy?: "legacy" | "humanoid-v1" | "presentation";
  /** Refuse cut when limbs heavily overlap torso. Off by default — promo art is posed. */
  requireClearLimbs?: boolean;
  maxLimbTorsoOverlap?: number;
  outlineInterrupt?: boolean;
  emitSpineJson?: boolean;
  pose?: CutPoseLandmarks;
};

/** Default cutter config used by Import and drag-drop. */
export function defaultCutConfig(options: CutUploadOptions = {}) {
  const alphaThreshold = options.alphaThreshold ?? 8;
  const jointCoverRadius = options.jointCoverRadius ?? 14;
  const inpaintTorso = options.inpaintTorso ?? true;
  // Default to presentation: bent arms + prop + hair-over-shoulder promo art.
  const taxonomy = options.taxonomy ?? "presentation";
  const usePose = options.usePose ?? true;

  const base: Record<string, unknown> = {
    trimSource: alphaThreshold > 0,
    jointCoverRadius,
    jointCoverScale: 1.15,
    inpaintTorso,
    usePose,
    taxonomy,
    requireClearLimbs: options.requireClearLimbs ?? false,
    maxLimbTorsoOverlap: options.maxLimbTorsoOverlap ?? 0.08,
    outlineInterrupt: options.outlineInterrupt ?? true,
    emitSpineJson: options.emitSpineJson ?? false,
    inpaint: { mode: "telea", dilatePx: taxonomy === "presentation" ? 14 : 6 },
  };

  if (options.pose) {
    base.pose = options.pose;
  }

  // Legacy capsules remain as seeds when pose estimation is weak; pose graph fills gaps.
  if (taxonomy === "legacy") {
    base.capsules = {
      head: [[0.5, 0.08, 0.5, 0.16, 0.09]],
      "arm-back": [[0.3, 0.25, 0.28, 0.48, 0.07]],
      "arm-front": [[0.72, 0.22, 0.85, 0.44, 0.08]],
      weapon: [[0.82, 0.45, 0.85, 0.92, 0.12]],
    };
    base.priority = ["weapon", "forearm", "arm-front", "arm-back", "head"];
    base.occluders = inpaintTorso ? ["weapon", "arm-front", "arm-back", "forearm"] : [];
    base.order = ["body", "head", "arm-back", "weapon", "arm-front", "forearm"];
  }

  return base;
}

/** POST the file to the part cutter and return a ready-to-open studio project. */
export async function importCharacterFile(file: File, options: CutUploadOptions = {}): Promise<SpineForgeProject> {
  const form = new FormData();
  form.append("file", file);
  form.append("projectId", file.name.replace(/\.[^.]+$/, "") || "import");
  form.append("config", JSON.stringify(defaultCutConfig(options)));

  const res = await fetch("/api/cut-parts", { method: "POST", body: form });
  const data = (await res.json().catch(() => ({}))) as Partial<CutResult> & {
    error?: string;
    code?: string;
    overlap?: number;
  };
  if (!res.ok) {
    if (data.code === "pose_not_riggable") {
      throw new Error(
        data.error ||
          "This pose crosses the torso too much for automatic joints. Use a clear A-pose or turn off the pose gate.",
      );
    }
    throw new Error(data.error || `Cut failed (${res.status})`);
  }
  if (!data.parts?.length || !data.projectId || !data.heroSrc) {
    throw new Error("The cutter found no layers in this image.");
  }
  return projectFromCut(data as CutResult, file.name);
}

/** Build a File from base64 bytes (native Mac shell drop/open). */
export function fileFromBase64(name: string, base64: string, mime = "application/octet-stream"): File {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}
