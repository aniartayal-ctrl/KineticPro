/**
 * Imported characters (`src/core/import-project.ts`): turns the part cutter's result (a flat PNG cut
 * into layers, or PSD layers) into a studio project, ready for the auto-rigger.
 */

import type { SpineForgeProject } from "./schema";

export type CutPart = { name: string; src: string; x: number; y: number; w: number; h: number; pixelWidth?: number; pixelHeight?: number; hidden?: boolean };
export type CutResult = { projectId: string; heroSrc: string; width: number; height: number; parts: CutPart[] };

const HEAVY_WEAPON = /hammer|axe|mace|club|maul|anvil/i;

/** A minimal, valid project: one root bone at the feet, the layers back to front, no clips yet. */
export function projectFromCut(cut: CutResult, fileName: string): SpineForgeProject {
  const title = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return {
    version: "1.0.0",
    id: cut.projectId,
    title: title || cut.projectId,
    src: cut.heroSrc,
    width: Math.max(1, Math.round(cut.width)),
    height: Math.max(1, Math.round(cut.height)),
    action: cut.parts.some((p) => HEAVY_WEAPON.test(p.name)) ? "slam" : "raise",
    frame: { left: 0.25, top: 0.2, right: 0.25, bottom: 0.05 },
    palette: { rim: "#ffd27a", flash: "#ffffff" },
    bones: [{ name: "root", x: 0.5, y: 0.97, length: 0.06 }],
    ikConstraints: [],
    parts: cut.parts.map((p) => ({ name: p.name, src: p.src, x: p.x, y: p.y, w: p.w, h: p.h, ...(p.hidden ? { hidden: true } : {}) })),
    animations: {},
  };
}
