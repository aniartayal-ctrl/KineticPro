/**
 * Batch 8-Symbol Pack Auto-Rigger (`src/core/batch-symbols.ts`)
 */

import { synthesizeAllFamousGameClips } from "./physics-and-principles";
import { RIG_BONE_PALETTE, type SpineForgeProject } from "./schema";
import { buildPartMesh } from "./weights";

export type SlotSymbolRole = "h1" | "h2" | "h3" | "l1" | "l2" | "l3" | "wild" | "scatter";

export type SlotSymbolDescriptor = {
  role: SlotSymbolRole;
  label: string;
  src: string;
  defaultClip: string;
};

export const ASTRAL_FORGE_SYMBOLS: SlotSymbolDescriptor[] = [
  { role: "h1", label: "H1 · Star-Smith Helmet", src: "/presets/astral-forge/symbol-helmet.webp", defaultClip: "symbol-win" },
  { role: "h2", label: "H2 · Celestial Gauntlet", src: "/presets/astral-forge/symbol-gauntlet.webp", defaultClip: "symbol-win" },
  { role: "h3", label: "H3 · Rune Warhammer", src: "/presets/astral-forge/symbol-hammer.webp", defaultClip: "symbol-win" },
  { role: "l1", label: "L1 · Astral Anvil", src: "/presets/astral-forge/symbol-anvil.webp", defaultClip: "symbol-win" },
  { role: "l2", label: "L2 · Star Crystal", src: "/presets/astral-forge/symbol-crystal.webp", defaultClip: "symbol-win" },
  { role: "l3", label: "L3 · Forge Rune Tablet", src: "/presets/astral-forge/symbol-rune.webp", defaultClip: "symbol-win" },
  { role: "wild", label: "WILD · Star Medallion", src: "/presets/astral-forge/symbol-wild.webp", defaultClip: "wild-expand" },
  { role: "scatter", label: "SCATTER · Astral Gate", src: "/presets/astral-forge/symbol-scatter.webp", defaultClip: "scatter-trigger" },
];

export const SANDS_OF_SOLARA_SYMBOLS: SlotSymbolDescriptor[] = [
  { role: "h1", label: "H1 · Sun Crown", src: "/presets/sands-of-solara/symbol-h1.webp", defaultClip: "symbol-win" },
  { role: "h2", label: "H2 · Scarab Amulet", src: "/presets/sands-of-solara/symbol-h2.webp", defaultClip: "symbol-win" },
  { role: "h3", label: "H3 · Ankh Scepter", src: "/presets/sands-of-solara/symbol-h3.webp", defaultClip: "symbol-win" },
  { role: "l1", label: "L1 · Solar Chalice", src: "/presets/sands-of-solara/symbol-l1.webp", defaultClip: "symbol-win" },
  { role: "l2", label: "L2 · Topaz Gem", src: "/presets/sands-of-solara/symbol-l2.webp", defaultClip: "symbol-win" },
  { role: "l3", label: "L3 · Hieroglyph Tile", src: "/presets/sands-of-solara/symbol-l3.webp", defaultClip: "symbol-win" },
  { role: "wild", label: "WILD · Sun Disk", src: "/presets/sands-of-solara/symbol-wild.webp", defaultClip: "wild-expand" },
  { role: "scatter", label: "SCATTER · Pyramid Eye", src: "/presets/sands-of-solara/symbol-scatter.webp", defaultClip: "scatter-trigger" },
];

export function getThemeSymbols(themeId: string): SlotSymbolDescriptor[] {
  return themeId.includes("solara") ? SANDS_OF_SOLARA_SYMBOLS : ASTRAL_FORGE_SYMBOLS;
}

/**
 * Builds a complete rigged, Delaunay-meshed, spring-weighted `SpineForgeProject` for a single 512×512 slot symbol.
 */
export function buildSymbolRigProject(themeId: string, desc: SlotSymbolDescriptor): SpineForgeProject {
  const isSolara = themeId.includes("solara");
  const project: SpineForgeProject = {
    version: "1.0.0",
    id: `${isSolara ? "solara" : "astral"}-symbol-${desc.role}`,
    title: desc.label,
    src: desc.src,
    width: 512,
    height: 512,
    action: desc.role === "wild" || desc.role === "scatter" ? "raise" : "slam",
    frame: { left: 0.25, top: 0.25, right: 0.25, bottom: 0.2 },
    palette: isSolara
      ? { rim: "#ffe28a", flash: "#ff9b3d" }
      : { rim: "#7fd8ff", flash: "#f3c969" },
    bones: [
      { name: "root", x: 0.5, y: 0.88, color: RIG_BONE_PALETTE[0] },
      {
        name: "hips",
        parent: "root",
        x: 0.5,
        y: 0.62,
        regions: [[0.35, 0.55, 0.65, 0.68, 0.16]],
        feather: 0.08,
        color: RIG_BONE_PALETTE[1],
      },
      {
        name: "chest",
        parent: "hips",
        x: 0.5,
        y: 0.45,
        regions: [[0.3, 0.35, 0.7, 0.52, 0.18]],
        feather: 0.08,
        color: RIG_BONE_PALETTE[2],
      },
      {
        name: "head",
        parent: "chest",
        x: 0.5,
        y: 0.22,
        regions: [[0.32, 0.15, 0.68, 0.28, 0.15]],
        feather: 0.07,
        spring: { stiffness: 75, damping: 7, gain: [6, 4], wind: 1.0 },
        color: RIG_BONE_PALETTE[3],
      },
      {
        name: "arm-back",
        parent: "chest",
        x: 0.24,
        y: 0.45,
        regions: [[0.14, 0.35, 0.28, 0.55, 0.12]],
        feather: 0.06,
        spring: { stiffness: 65, damping: 6, gain: [8, 4], wind: 1.4 },
        color: RIG_BONE_PALETTE[4],
      },
      {
        name: "arm",
        parent: "chest",
        x: 0.76,
        y: 0.45,
        regions: [[0.72, 0.35, 0.86, 0.55, 0.12]],
        feather: 0.06,
        spring: { stiffness: 65, damping: 6, gain: [8, 4], wind: 1.4 },
        color: RIG_BONE_PALETTE[8],
      },
      { name: "forearm", parent: "arm", x: 0.82, y: 0.38, color: RIG_BONE_PALETTE[9] },
      { name: "weapon", parent: "forearm", x: 0.86, y: 0.32, color: RIG_BONE_PALETTE[10] },
    ],
    ikConstraints: [],
    parts: [
      {
        name: "body",
        src: desc.src,
        x: 0.04,
        y: 0.04,
        w: 0.92,
        h: 0.92,
        skin: ["root", "hips", "chest", "head", "arm-back", "arm"],
        meshDensity: "high",
      },
    ],
    skins: [
      { name: "default", label: "Tier 1 · Standard Symbol", tint: "#ffffff", rimColor: "#7fd8ff", flashColor: "#f3c969" },
      { name: "awakened", label: "Tier 2 · Golden Multiplier", tint: "#fef08a", rimColor: "#facc15", flashColor: "#f97316" },
      { name: "ascended", label: "Tier 3 · Mega Jackpot Glow", tint: "#f5d0fe", rimColor: "#e879f9", flashColor: "#38bdf8" },
    ],
    animations: {},
  };

  for (const part of project.parts) {
    part.mesh = buildPartMesh(project, part, { columns: 28, weightMode: "hybrid" });
  }
  project.animations = synthesizeAllFamousGameClips(project);
  return project;
}

/**
 * Generates all 8 rigged slot symbols for a theme in a single batch call.
 */
export function generateBatch8SymbolPack(themeId: string): SpineForgeProject[] {
  const descriptors = getThemeSymbols(themeId);
  return descriptors.map((desc) => buildSymbolRigProject(themeId, desc));
}
