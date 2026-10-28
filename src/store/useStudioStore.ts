"use client";

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { bakeClipConstraintsToKeyframes, sampleDeformTrack } from "@/core/animator";
import { applyPose, breakdownKey, patchKeyAt, retimeClip, samplePose, snapTime, upsertKey } from "@/core/keyframes";
import type { BonePose } from "@/core/solver";
import { buildSymbolRigProject, getThemeSymbols, type SlotSymbolRole } from "@/core/batch-symbols";
import {
  applyVoiceLipSyncToClip,
  DEFAULT_PARALLAX_CONFIG,
  type ParallaxLookAtConfig,
} from "@/core/parallax-and-lipsync";
import {
  DEFAULT_12_PRINCIPLES,
  inferVisualPhysics,
  runFullAutoModePipeline,
  synthesizeAllFamousGameClips,
  type AnimationPrinciplesConfig,
  type AutoArchetypeId,
  type VisualPhysicsReport,
} from "@/core/physics-and-principles";
import { BUILTIN_PRESETS } from "@/core/presets";
import {
  RIG_BONE_PALETTE,
  type AnimationClip,
  type CurveType,
  type RigBone,
  type RigPart,
  type SpineForgeProject,
  type TransformKey,
} from "@/core/schema";
import type { ElementalVfxType } from "@/core/vfx-colliders-profiler";
import {
  buildPartMesh,
  paintFfdLiquifyStroke,
  paintMeshWeights,
  type AutoWeightMode,
  type FfdLiquifyMode,
  type WeightBrushMode,
} from "@/core/weights";
import { computeViewMetrics, VIEW_ZOOM_MAX, VIEW_ZOOM_MIN } from "@/core/webgl-renderer";
import { usePreferencesStore } from "@/store/usePreferencesStore";

/** Sub-tool of the Pose mode, matching Spine's B / C / V / X tools. */
export type TransformTool = "pose" | "rotate" | "translate" | "scale";

export type StudioMode = "import" | "auto" | "rig" | "mesh" | "weights" | "liquify" | "animate" | "export";

/**
 * A request to replace the open document. UI anywhere calls `requestDocument`; the app shell runs it
 * through one path that asks about unsaved changes first, so no button can silently discard work.
 */
export type DocumentRequest =
  | { kind: "saved" | "preset"; id: string; title: string }
  /** A character just cut by the importer; it is not saved until the user saves it. */
  | { kind: "imported"; id: string; title: string; project: SpineForgeProject }
  | { kind: "symbol"; id: SlotSymbolRole; title: string };

export type HistorySnapshot = {
  id: string;
  label: string;
  timestamp: string;
  /**
   * The project at this point in history. Every store update builds a new object and copies only the
   * branch it changes, so snapshots share untouched data (meshes, other clips) instead of
   * serialising the whole project on every edit.
   */
  project: SpineForgeProject;
  /** ms timestamp, used to merge rapid repeats of the same action into one undo step. */
  at: number;
};

type OverlayToggleKey =
  | "showMeshWireframe"
  | "showBones"
  | "showCapsules"
  | "showHeatmap"
  | "heatmapSingleBone"
  | "isolatePart"
  | "showOnionSkin"
  | "showMotionArcs"
  | "showSlashTrail"
  | "enable3DRelight"
  | "showHitboxes";

type StudioState = {
  project: SpineForgeProject;
  mode: StudioMode;
  selectedBone: string | null;
  selectedPart: string | null;
  activeClip: string;
  activeSkinName: string;
  currentTime: number;
  isPlaying: boolean;
  playbackSpeed: number;

  // Viewport overlays & 3D relighting
  showMeshWireframe: boolean;
  showBones: boolean;
  showCapsules: boolean;
  showHeatmap: boolean;
  heatmapSingleBone: boolean;
  isolatePart: boolean;
  showOnionSkin: boolean;
  showMotionArcs: boolean;
  showSlashTrail: boolean;
  enable3DRelight: boolean;
  lightAngleDeg: number;
  lightIntensity: number;
  showHitboxes: boolean;
  parallax: ParallaxLookAtConfig;
  activeVfx: ElementalVfxType;
  mobileProfileScale: 1 | 0.5;

  /** Viewport camera: multiplier on fit-to-window scale (1 = fit). Session-only. */
  viewZoom: number;
  viewPanX: number;
  viewPanY: number;
  /** Last overlay canvas size in device pixels (for keyboard zoom toward center). */
  viewCanvasW: number;
  viewCanvasH: number;

  // Weight & Liquify brush state
  brushMode: WeightBrushMode;
  liquifyMode: FfdLiquifyMode;
  brushRadius: number;
  brushStrength: number;
  lockedBones: string[];
  hiddenParts: string[];

  // Photoshop History Stack (Undo / Redo)
  history: HistorySnapshot[];
  historyIndex: number;

  // Visual Physics Inference & 12 Principles Auto-Mode State
  autoArchetype: AutoArchetypeId;
  principles: AnimationPrinciplesConfig;
  physicsReport: VisualPhysicsReport;

  // Core Actions
  /** Replaces the document without asking. UI code calls requestDocument instead. */
  loadPreset: (id: string) => void;
  documentRequest: DocumentRequest | null;
  requestDocument: (request: DocumentRequest | null) => void;
  setProject: (project: SpineForgeProject, historyLabel?: string) => void;
  /** Replaces the document: resets selection, clip, playhead and undo history. */
  openProject: (project: SpineForgeProject, historyLabel: string) => void;
  setMode: (mode: StudioMode) => void;
  transformTool: TransformTool;
  previousTool: { mode: StudioMode; transformTool: TransformTool } | null;
  /** Switches tool and remembers the previous one (right-click on the canvas swaps back, as in Spine). */
  chooseTool: (mode: StudioMode, transformTool?: TransformTool) => void;
  swapToPreviousTool: () => void;
  playDirection: 1 | -1;
  setPlayDirection: (direction: 1 | -1) => void;
  /** Live bone edit without an undo step (pivot drags); finish with commitPreview. */
  previewBone: (boneName: string, patch: Partial<RigBone>) => void;
  selectBone: (name: string | null) => void;
  selectPart: (name: string | null) => void;
  setActiveClip: (clipName: string) => void;
  setActiveSkin: (skinName: string) => void;
  setCurrentTime: (time: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setPlaybackSpeed: (speed: number) => void;
  toggleOverlay: (key: OverlayToggleKey) => void;
  setLightParams: (angleDeg: number, intensity: number) => void;
  togglePartVisibility: (partName: string) => void;
  movePartLayerOrder: (partName: string, direction: "up" | "down", steps?: number) => void;

  // History Actions
  pushHistory: (label: string, nextProject: SpineForgeProject) => void;
  undo: () => void;
  redo: () => void;
  jumpToHistory: (index: number) => void;

  // AI Auto-Rig & Rigging Mutations
  runOneClickAutoRig: () => void;
  runAutoModeSelectAction: (actionId: string, archetype?: AutoArchetypeId) => void;
  updatePrinciples: (patch: Partial<AnimationPrinciplesConfig>) => void;
  setParallaxConfig: (patch: Partial<ParallaxLookAtConfig>) => void;
  applyVoiceLipSync: (phraseId: string) => void;
  setActiveVfx: (vfx: ElementalVfxType) => void;
  setMobileProfileScale: (scale: 1 | 0.5) => void;
  setViewPan: (panX: number, panY: number) => void;
  setViewCanvasSize: (w: number, h: number) => void;
  resetView: () => void;
  /** Zoom by `factor` around an anchor in canvas pixels (defaults to view center). */
  zoomAt: (factor: number, anchorCanvasX?: number, anchorCanvasY?: number, canvasW?: number, canvasH?: number) => void;
  /** Replaces the document without asking. UI code calls requestDocument instead. */
  loadSymbolRig: (role: SlotSymbolRole) => void;
  updateBone: (boneName: string, patch: Partial<RigBone>) => void;
  addBone: (parentBoneName: string, name: string, x: number, y: number) => void;
  updatePart: (partName: string, patch: Partial<RigPart>) => void;
  updateIkMix: (ikName: string, mix: number, bendPositive?: boolean) => void;

  // Mesh, Weight & Liquify FFD Mutations
  regeneratePartMesh: (partName: string, density: "low" | "medium" | "high", weightMode: AutoWeightMode) => void;
  applyWeightBrush: (partName: string, rigX: number, rigY: number) => void;
  applyLiquifyBrush: (partName: string, rigX: number, rigY: number, dx: number, dy: number) => void;
  resetPartLiquifyDeform: (partName: string) => void;
  setBrushMode: (mode: WeightBrushMode) => void;
  setLiquifyMode: (mode: FfdLiquifyMode) => void;
  setBrushRadius: (radius: number) => void;
  setBrushStrength: (strength: number) => void;
  toggleBoneLock: (boneName: string) => void;

  // Animation, Bezier Curves & Unity Event Mutations
  setBoneKeyframeAtCurrentTime: (boneName: string, patch: Partial<TransformKey>) => void;
  setBoneCurveAtCurrentTime: (boneName: string, curve: CurveType) => void;
  deleteBoneKeyframe: (boneName: string, time: number) => void;

  // Animator tools (graph editor, dope sheet, breakdowns, pose clipboard, clip timing)
  /** Applies `fn` to the active clip. With a label it is one undo step; with `null` it is a live preview (drags). */
  editActiveClip: (fn: (clip: AnimationClip) => AnimationClip, label: string | null) => void;
  /** Records the current project as one undo step after a series of preview edits. */
  commitPreview: (label: string) => void;
  poseClipboard: Record<string, BonePose> | null;
  copyPose: () => void;
  pastePose: () => void;
  /** Named pose bookmarks (A–D style); max 8. */
  poseBookmarks: { id: string; label: string; pose: Record<string, BonePose> }[];
  savePoseBookmark: (label?: string) => void;
  recallPoseBookmark: (id: string) => void;
  clearPoseBookmarks: () => void;
  /** Preview: freeze IK end-effector while adjusting parents. */
  lockIkEndEffector: boolean;
  setLockIkEndEffector: (v: boolean) => void;
  /** Keys every bone (or just `bones`) at the playhead, `fraction` of the way between neighbouring keys. */
  insertBreakdown: (fraction: number, bones?: string[]) => void;
  setClipTiming: (patch: { duration?: number; fps?: number; loop?: boolean; stretch?: boolean }) => void;
  addAnimationEventAtCurrentTime: (name: string, stringParam?: string, floatParam?: number) => void;
  deleteAnimationEvent: (time: number, name: string) => void;
  regenerateAllProceduralClips: () => void;
  bakeCurrentClipSprings: () => void;
};

/** Applies a bone patch; moving a pivot or its regions rebuilds the skinned meshes that use it. */
function patchBone(project: SpineForgeProject, boneName: string, patch: Partial<RigBone>): SpineForgeProject {
  const bones = project.bones.map((b) => (b.name === boneName ? { ...b, ...patch } : b));
  const next: SpineForgeProject = { ...project, bones };
  if (patch.x !== undefined || patch.y !== undefined || patch.regions !== undefined || patch.feather !== undefined) {
    next.parts = next.parts.map((part) =>
      part.skin?.includes(boneName) ? { ...part, mesh: buildPartMesh(next, { ...part, mesh: undefined }) } : part,
    );
  }
  return next;
}

/** Undo depth. Snapshots share structure, so 100 steps cost little memory. */
const HISTORY_LIMIT = 100;

function makeSnapshot(label: string, project: SpineForgeProject): HistorySnapshot {
  return {
    id: `h-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    project,
    at: Date.now(),
  };
}

/** Repeats of the same action closer together than this become one undo step (slider drags, held keys). */
const COALESCE_MS = 800;

const initialProject = BUILTIN_PRESETS["astral-forge"]!();
const initialPhysics = inferVisualPhysics(initialProject, "auto_detect");

export const useStudioStore = create<StudioState>((set, get) => ({
  project: initialProject,
  mode: "auto",
  selectedBone: "arm",
  selectedPart: "body",
  activeClip: "strike",
  activeSkinName: "default",
  currentTime: 0,
  isPlaying: true,
  playbackSpeed: 1,
  transformTool: "pose",
  previousTool: null,
  playDirection: 1,

  showMeshWireframe: true,
  showBones: true,
  showCapsules: false,
  showHeatmap: false,
  heatmapSingleBone: false,
  isolatePart: false,
  showOnionSkin: false,
  showMotionArcs: true,
  showSlashTrail: true,
  enable3DRelight: true,
  lightAngleDeg: -38,
  lightIntensity: 0.55,
  showHitboxes: false,
  parallax: { ...DEFAULT_PARALLAX_CONFIG },
  activeVfx: "lightning_bolts",
  mobileProfileScale: 1,

  viewZoom: 1,
  viewPanX: 0,
  viewPanY: 0,
  viewCanvasW: 0,
  viewCanvasH: 0,

  brushMode: "add",
  liquifyMode: "push",
  brushRadius: 65,
  brushStrength: 0.45,
  lockedBones: [],
  hiddenParts: [],

  history: [makeSnapshot("Opened Document", initialProject)],
  historyIndex: 0,

  autoArchetype: "auto_detect",
  principles: { ...DEFAULT_12_PRINCIPLES },
  physicsReport: initialPhysics.report,

  pushHistory: (label, nextProject) => {
    const { history, historyIndex } = get();
    const last = history[historyIndex];
    const now = Date.now();
    if (historyIndex > 0 && historyIndex === history.length - 1 && last && last.label === label && now - last.at < COALESCE_MS) {
      set({ project: nextProject, history: [...history.slice(0, historyIndex), { ...last, project: nextProject, at: now }] });
      return;
    }
    const sliced = history.slice(0, historyIndex + 1);
    const nextHist = [...sliced.slice(-(HISTORY_LIMIT - 1)), makeSnapshot(label, nextProject)];
    set({
      project: nextProject,
      history: nextHist,
      historyIndex: nextHist.length - 1,
    });
  },

  undo: () => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const prevIdx = historyIndex - 1;
    const snap = history[prevIdx];
    if (!snap) return;
    set({
      project: snap.project,
      historyIndex: prevIdx,
    });
  },

  redo: () => {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const nextIdx = historyIndex + 1;
    const snap = history[nextIdx];
    if (!snap) return;
    set({
      project: snap.project,
      historyIndex: nextIdx,
    });
  },

  jumpToHistory: (index) => {
    const { history } = get();
    const snap = history[index];
    if (!snap) return;
    set({
      project: snap.project,
      historyIndex: index,
    });
  },

  documentRequest: null,
  requestDocument: (documentRequest) => set({ documentRequest }),

  loadPreset: (id) => {
    const factory = BUILTIN_PRESETS[id];
    if (!factory) return;
    const project = factory();
    get().openProject(project, `Loaded ${project.title}`);
  },

  openProject: (project, historyLabel) => {
    const { report } = inferVisualPhysics(project, "auto_detect");
    const clips = Object.keys(project.animations);
    set({
      project,
      selectedBone: project.bones[1]?.name ?? project.bones[0]?.name ?? "root",
      selectedPart: project.parts.find((p) => p.skin && p.skin.length > 1)?.name ?? project.parts[0]?.name ?? null,
      activeClip: project.animations.strike ? "strike" : (clips[0] ?? "idle"),
      activeSkinName: "default",
      currentTime: 0,
      isPlaying: false,
      hiddenParts: [],
      lockedBones: [],
      poseClipboard: null,
      poseBookmarks: [],
      physicsReport: report,
      history: [makeSnapshot(historyLabel, project)],
      historyIndex: 0,
      viewZoom: 1,
      viewPanX: 0,
      viewPanY: 0,
    });
  },

  setProject: (project, historyLabel = "Updated Project") => {
    get().pushHistory(historyLabel, project);
  },

  setMode: (mode) => {
    set({
      mode,
      showHeatmap: mode === "weights",
      showMeshWireframe: mode === "mesh" || mode === "weights" || mode === "liquify" || get().showMeshWireframe,
    });
  },

  chooseTool: (mode, transformTool) => {
    const s = get();
    const nextTransform = transformTool ?? s.transformTool;
    if (mode === s.mode && nextTransform === s.transformTool) return;
    set({ previousTool: { mode: s.mode, transformTool: s.transformTool }, transformTool: nextTransform });
    s.setMode(mode);
  },

  swapToPreviousTool: () => {
    const prev = get().previousTool;
    if (prev) get().chooseTool(prev.mode, prev.transformTool);
  },

  setPlayDirection: (playDirection) => set({ playDirection }),

  selectBone: (selectedBone) => set({ selectedBone }),
  selectPart: (selectedPart) => set({ selectedPart }),
  setActiveClip: (activeClip) => set({ activeClip, currentTime: 0 }),
  setActiveSkin: (activeSkinName) => set({ activeSkinName }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),

  toggleOverlay: (key) => set((state) => ({ [key]: !state[key] })),
  setLightParams: (lightAngleDeg, lightIntensity) => set({ lightAngleDeg, lightIntensity }),

  togglePartVisibility: (partName) =>
    set((state) => ({
      hiddenParts: state.hiddenParts.includes(partName)
        ? state.hiddenParts.filter((p) => p !== partName)
        : [...state.hiddenParts, partName],
    })),

  movePartLayerOrder: (partName, direction, steps = 1) => {
    const state = get();
    const parts = [...state.project.parts];
    const idx = parts.findIndex((p) => p.name === partName);
    if (idx < 0) return;
    const targetIdx = Math.max(0, Math.min(parts.length - 1, idx + (direction === "up" ? steps : -steps)));
    if (targetIdx === idx) return;
    const [item] = parts.splice(idx, 1);
    parts.splice(targetIdx, 0, item!);
    state.pushHistory(`Reordered Layer ${partName}`, { ...state.project, parts });
  },

  runOneClickAutoRig: () => {
    const state = get();
    const meshDensity = usePreferencesStore.getState().meshDensityDefault;
    const { project: autoShipped, physicsReport } = runFullAutoModePipeline(state.project, {
      archetype: state.autoArchetype,
      principles: state.principles,
      meshDensity,
    });
    set({ physicsReport });
    state.pushHistory("1-Click Auto-Rig & Physics", autoShipped);
  },

  runAutoModeSelectAction: (actionId, archetype) => {
    const state = get();
    const nextArch = archetype ?? state.autoArchetype;
    const meshDensity = usePreferencesStore.getState().meshDensityDefault;
    const { project: autoShipped, physicsReport } = runFullAutoModePipeline(state.project, {
      archetype: nextArch,
      principles: state.principles,
      meshDensity,
    });
    set({
      autoArchetype: nextArch,
      physicsReport,
      activeClip: autoShipped.animations[actionId] ? actionId : "strike",
      currentTime: 0,
      isPlaying: true,
    });
    state.pushHistory(`Auto Mode → ${actionId}`, autoShipped);
  },

  updatePrinciples: (patch) => {
    const state = get();
    const nextPrinciples = { ...state.principles, ...patch };
    const nextAnimations = synthesizeAllFamousGameClips(state.project, nextPrinciples);
    const nextProject = {
      ...state.project,
      animations: nextAnimations,
    };
    set({ principles: nextPrinciples });
    state.pushHistory("Tuned 12 Principles", nextProject);
  },

  setParallaxConfig: (patch) =>
    set((state) => ({
      parallax: { ...state.parallax, ...patch },
    })),

  applyVoiceLipSync: (phraseId) => {
    const state = get();
    const clip = state.project.animations[state.activeClip];
    if (!clip) return;
    const synced = applyVoiceLipSyncToClip(state.project, clip, phraseId);
    const nextProject = {
      ...state.project,
      animations: {
        ...state.project.animations,
        [state.activeClip]: synced,
      },
    };
    state.pushHistory(`Voice Lip-Sync (${phraseId})`, nextProject);
  },

  setActiveVfx: (activeVfx) => set({ activeVfx }),
  setMobileProfileScale: (mobileProfileScale) => set({ mobileProfileScale }),

  setViewPan: (viewPanX, viewPanY) => set({ viewPanX, viewPanY }),
  setViewCanvasSize: (w, h) => {
    const s = get();
    if (s.viewCanvasW === w && s.viewCanvasH === h) return;
    set({ viewCanvasW: w, viewCanvasH: h });
  },
  resetView: () => set({ viewZoom: 1, viewPanX: 0, viewPanY: 0 }),
  zoomAt: (factor, anchorCanvasX, anchorCanvasY, canvasW, canvasH) => {
    const s = get();
    const w = canvasW ?? s.viewCanvasW;
    const h = canvasH ?? s.viewCanvasH;
    const nextZoom = Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, s.viewZoom * factor));
    const actual = nextZoom / s.viewZoom;
    if (!(actual > 0) || Math.abs(actual - 1) < 1e-9) return;
    if (w > 0 && h > 0) {
      const ax = anchorCanvasX ?? w / 2;
      const ay = anchorCanvasY ?? h / 2;
      const { offsetX, offsetY } = computeViewMetrics(s.project, w, h, {
        zoom: s.viewZoom,
        panX: s.viewPanX,
        panY: s.viewPanY,
      });
      set({
        viewZoom: nextZoom,
        viewPanX: s.viewPanX + (1 - actual) * (ax - offsetX),
        viewPanY: s.viewPanY + (1 - actual) * (ay - offsetY),
      });
      return;
    }
    set({ viewZoom: nextZoom });
  },

  loadSymbolRig: (role) => {
    const state = get();
    const themeId = state.project.id.includes("solara") ? "sands-of-solara" : "astral-forge";
    const descriptors = getThemeSymbols(themeId);
    const desc = descriptors.find((d) => d.role === role) ?? descriptors[0]!;
    const symProj = buildSymbolRigProject(themeId, desc);
    const { report } = inferVisualPhysics(symProj, "slot_symbol");
    set({
      project: symProj,
      selectedBone: "chest",
      selectedPart: "body",
      activeClip: desc.defaultClip,
      currentTime: 0,
      physicsReport: report,
      history: [makeSnapshot(`Symbol Rig: ${desc.label}`, symProj)],
      historyIndex: 0,
    });
  },

  updateBone: (boneName, patch) => {
    const state = get();
    state.pushHistory(`Adjusted Bone ${boneName}`, patchBone(state.project, boneName, patch));
  },

  previewBone: (boneName, patch) => {
    set({ project: patchBone(get().project, boneName, patch) });
  },

  addBone: (parentBoneName, name, x, y) => {
    const state = get();
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    if (!clean || state.project.bones.some((b) => b.name === clean)) return;
    const newBone: RigBone = {
      name: clean,
      parent: parentBoneName,
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      length: 0.08,
      color: RIG_BONE_PALETTE[state.project.bones.length % RIG_BONE_PALETTE.length],
    };
    const nextProject = {
      ...state.project,
      bones: [...state.project.bones, newBone],
    };
    state.pushHistory(`Added Bone ${clean}`, nextProject);
    set({ selectedBone: clean });
  },

  updatePart: (partName, patch) => {
    const state = get();
    const parts = state.project.parts.map((p) => {
      if (p.name !== partName) return p;
      const updated = { ...p, ...patch };
      if (patch.bone !== undefined || patch.skin !== undefined || patch.meshDensity !== undefined) {
        updated.mesh = buildPartMesh(state.project, { ...updated, mesh: undefined });
      }
      return updated;
    });
    state.pushHistory(`Updated Layer ${partName}`, { ...state.project, parts });
  },

  updateIkMix: (ikName, mix, bendPositive) => {
    const state = get();
    const nextProject = {
      ...state.project,
      ikConstraints: state.project.ikConstraints.map((ik) =>
        ik.name === ikName
          ? { ...ik, mix: Math.max(0, Math.min(1, mix)), bendPositive: bendPositive ?? ik.bendPositive }
          : ik,
      ),
    };
    // No value in the label, so dragging the mix slider coalesces into one undo step.
    state.pushHistory(`IK Pin ${ikName}`, nextProject);
  },

  regeneratePartMesh: (partName, density, weightMode) => {
    const state = get();
    const parts = state.project.parts.map((p) => {
      if (p.name !== partName) return p;
      const nextPart: RigPart = { ...p, meshDensity: density, mesh: undefined };
      nextPart.mesh = buildPartMesh(state.project, nextPart, { weightMode });
      return nextPart;
    });
    state.pushHistory(`Meshed ${partName} (${density}/${weightMode})`, { ...state.project, parts });
  },

  applyWeightBrush: (partName, rigX, rigY) =>
    set((state) => {
      const { project, selectedBone, brushMode, brushRadius, brushStrength, lockedBones } = state;
      const boneIdx = project.bones.findIndex((b) => b.name === selectedBone);
      if (boneIdx < 0) return state;

      const lockedSet = new Set<number>();
      lockedBones.forEach((lb) => {
        const idx = project.bones.findIndex((b) => b.name === lb);
        if (idx >= 0) lockedSet.add(idx);
      });

      const parts = project.parts.map((part) => {
        if (part.name !== partName) return part;
        const currentMesh = part.mesh ?? buildPartMesh(project, part);
        const painted = paintMeshWeights(currentMesh, project.bones.length, {
          x: rigX,
          y: rigY,
          radius: brushRadius,
          strength: brushStrength,
          boneIndex: boneIdx,
          mode: brushMode,
          lockedBones: lockedSet,
        });
        return { ...part, mesh: painted };
      });

      return { project: { ...project, parts } };
    }),

  applyLiquifyBrush: (partName, rigX, rigY, dx, dy) =>
    set((state) => {
      const { project, activeClip, currentTime, liquifyMode, brushRadius, brushStrength } = state;
      const clip = project.animations[activeClip];
      const part = project.parts.find((p) => p.name === partName);
      if (!clip || !part) return state;
      const mesh = part.mesh ?? buildPartMesh(project, part);
      const vCount = mesh.positions.length / 2;

      const fps = clip.fps || 30;
      // Warp keys land on frames, like bone keys.
      const t = snapTime(currentTime, fps, clip.duration);
      const existingDeformTrack = [...(clip.deformTracks?.[partName] ?? [])];
      const currentOffsets = sampleDeformTrack(existingDeformTrack, t, vCount);
      const nextOffsets = paintFfdLiquifyStroke(mesh, currentOffsets, {
        x: rigX,
        y: rigY,
        dx,
        dy,
        radius: brushRadius,
        strength: brushStrength,
        mode: liquifyMode,
      });

      const keyIdx = existingDeformTrack.findIndex((k) => Math.abs(k.time - t) < 0.5 / fps);
      if (keyIdx >= 0) {
        existingDeformTrack[keyIdx] = { ...existingDeformTrack[keyIdx]!, offsets: nextOffsets };
      } else {
        existingDeformTrack.push({ time: t, offsets: nextOffsets });
        existingDeformTrack.sort((a, b) => a.time - b.time);
      }

      return {
        project: {
          ...project,
          animations: {
            ...project.animations,
            [activeClip]: {
              ...clip,
              deformTracks: {
                ...(clip.deformTracks ?? {}),
                [partName]: existingDeformTrack,
              },
            },
          },
        },
      };
    }),

  resetPartLiquifyDeform: (partName) => {
    const state = get();
    const clip = state.project.animations[state.activeClip];
    if (!clip) return;
    const nextDeform = { ...(clip.deformTracks ?? {}) };
    delete nextDeform[partName];
    state.pushHistory(`Reset Liquify FFD on ${partName}`, {
      ...state.project,
      animations: {
        ...state.project.animations,
        [state.activeClip]: {
          ...clip,
          deformTracks: nextDeform,
        },
      },
    });
  },

  setBrushMode: (brushMode) => set({ brushMode }),
  setLiquifyMode: (liquifyMode) => set({ liquifyMode }),
  setBrushRadius: (brushRadius) => set({ brushRadius }),
  setBrushStrength: (brushStrength) => set({ brushStrength }),

  toggleBoneLock: (boneName) =>
    set((state) => ({
      lockedBones: state.lockedBones.includes(boneName)
        ? state.lockedBones.filter((b) => b !== boneName)
        : [...state.lockedBones, boneName],
    })),

  setBoneKeyframeAtCurrentTime: (boneName, patch) => {
    const state = get();
    const clip = state.project.animations[state.activeClip];
    if (!clip) return;
    // Keys land on whole frames; channels not in `patch` keep their current pose (never reset to 0).
    const t = snapTime(state.currentTime, clip.fps || 30, clip.duration);
    if (Math.abs(t - state.currentTime) > 1e-4) set({ currentTime: t });
    const { curve, time: _ignored, ...channels } = patch;
    void _ignored;
    let track = patchKeyAt(clip.boneTracks[boneName] ?? [], t, channels as Partial<Record<"r" | "x" | "y" | "sx" | "sy", number>>);
    if (curve !== undefined) {
      const idx = track.findIndex((k) => Math.abs(k.time - t) < 1e-4);
      track = track.map((k, i) => (i === idx ? { ...k, curve } : k));
    }
    state.editActiveClip((c) => ({ ...c, boneTracks: { ...c.boneTracks, [boneName]: track } }), `Keyed ${boneName} @ ${t.toFixed(2)}s`);
  },

  setBoneCurveAtCurrentTime: (boneName, curve) => {
    const state = get();
    const { project, activeClip, currentTime } = state;
    const clip = project.animations[activeClip];
    if (!clip) return;
    const track = [...(clip.boneTracks[boneName] ?? [])];
    if (track.length === 0) return;

    // Find active or nearest keyframe <= currentTime
    let targetIdx = 0;
    for (let i = 0; i < track.length; i++) {
      if (track[i]!.time <= currentTime + 0.02) targetIdx = i;
    }
    track[targetIdx] = { ...track[targetIdx]!, curve };

    const nextProject = {
      ...project,
      animations: {
        ...project.animations,
        [activeClip]: {
          ...clip,
          boneTracks: {
            ...clip.boneTracks,
            [boneName]: track,
          },
        },
      },
    };
    state.pushHistory(`Set Curve on ${boneName}`, nextProject);
  },

  editActiveClip: (fn, label) => {
    const state = get();
    const clip = state.project.animations[state.activeClip];
    if (!clip) return;
    const nextClip = fn(clip);
    if (nextClip === clip) return;
    const nextProject = {
      ...state.project,
      animations: { ...state.project.animations, [state.activeClip]: nextClip },
    };
    if (label) state.pushHistory(label, nextProject);
    else set({ project: nextProject });
  },

  commitPreview: (label) => {
    const state = get();
    if (state.history[state.historyIndex]?.project === state.project) return;
    state.pushHistory(label, state.project);
  },

  poseClipboard: null,
  poseBookmarks: [],
  lockIkEndEffector: false,

  copyPose: () => {
    const state = get();
    const clip = state.project.animations[state.activeClip];
    if (!clip) return;
    set({ poseClipboard: samplePose(clip, state.project.bones.map((b) => b.name), state.currentTime) });
  },

  pastePose: () => {
    const state = get();
    const pose = state.poseClipboard;
    if (!pose) return;
    const t = Number(state.currentTime.toFixed(4));
    state.editActiveClip((clip) => ({ ...clip, boneTracks: applyPose(clip.boneTracks, pose, t) }), `Pasted Pose @ ${t.toFixed(2)}s`);
  },

  savePoseBookmark: (label) => {
    const state = get();
    const clip = state.project.animations[state.activeClip];
    if (!clip) return;
    const pose = samplePose(
      clip,
      state.project.bones.map((b) => b.name),
      state.currentTime,
    );
    const labels = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const nextLabel = label?.trim() || labels[state.poseBookmarks.length % labels.length]!;
    const id = `bm-${Date.now().toString(36)}`;
    const poseBookmarks = [...state.poseBookmarks, { id, label: nextLabel, pose }].slice(-8);
    set({ poseBookmarks });
  },

  recallPoseBookmark: (id) => {
    const state = get();
    const bm = state.poseBookmarks.find((b) => b.id === id);
    if (!bm) return;
    const t = Number(state.currentTime.toFixed(4));
    state.editActiveClip(
      (clip) => ({ ...clip, boneTracks: applyPose(clip.boneTracks, bm.pose, t) }),
      `Recalled pose ${bm.label} @ ${t.toFixed(2)}s`,
    );
  },

  clearPoseBookmarks: () => set({ poseBookmarks: [] }),

  setLockIkEndEffector: (lockIkEndEffector) => set({ lockIkEndEffector }),

  insertBreakdown: (fraction, bones) => {
    const state = get();
    const t = Number(state.currentTime.toFixed(4));
    const names = bones ?? state.project.bones.map((b) => b.name);
    state.editActiveClip((clip) => {
      const boneTracks = { ...clip.boneTracks };
      let changed = false;
      for (const name of names) {
        const key = breakdownKey(boneTracks[name] ?? [], t, fraction);
        if (!key) continue;
        boneTracks[name] = upsertKey(boneTracks[name] ?? [], key).track;
        changed = true;
      }
      return changed ? { ...clip, boneTracks } : clip;
    }, `Breakdown ${Math.round(fraction * 100)}% @ ${t.toFixed(2)}s`);
  },

  setClipTiming: ({ duration, fps, loop, stretch }) => {
    const state = get();
    state.editActiveClip((clip) => {
      let next = clip;
      if (duration !== undefined && Math.abs(duration - clip.duration) > 1e-4) next = retimeClip(next, duration, Boolean(stretch));
      if (fps !== undefined && fps !== next.fps) next = { ...next, fps };
      if (loop !== undefined && loop !== next.loop) next = { ...next, loop };
      return next;
    }, "Clip Timing");
    const clip = get().project.animations[state.activeClip];
    if (clip && get().currentTime > clip.duration) set({ currentTime: clip.duration });
  },

  deleteBoneKeyframe: (boneName, time) => {
    const state = get();
    const { project, activeClip } = state;
    const clip = project.animations[activeClip];
    if (!clip) return;
    const filtered = (clip.boneTracks[boneName] ?? []).filter((k) => Math.abs(k.time - time) > 0.015);
    const nextProject = {
      ...project,
      animations: {
        ...project.animations,
        [activeClip]: {
          ...clip,
          boneTracks: {
            ...clip.boneTracks,
            [boneName]: filtered,
          },
        },
      },
    };
    state.pushHistory(`Deleted Key on ${boneName}`, nextProject);
  },

  addAnimationEventAtCurrentTime: (name, stringParam = "", floatParam = 1.0) => {
    const state = get();
    const { project, activeClip, currentTime } = state;
    const clip = project.animations[activeClip];
    if (!clip) return;
    const fps = clip.fps || 30;
    const t = snapTime(currentTime, fps, clip.duration);
    const events = [...(clip.events ?? [])].filter((e) => !(Math.abs(e.time - t) < 0.5 / fps && e.name === name));
    events.push({ time: t, name, stringParam, floatParam });
    events.sort((a, b) => a.time - b.time);

    const nextProject = {
      ...project,
      animations: {
        ...project.animations,
        [activeClip]: {
          ...clip,
          events,
        },
      },
    };
    state.pushHistory(`Added Event ${name} @ frame ${Math.round(t * fps)}`, nextProject);
  },

  deleteAnimationEvent: (time, name) => {
    const state = get();
    const { project, activeClip } = state;
    const clip = project.animations[activeClip];
    if (!clip) return;
    const events = (clip.events ?? []).filter((e) => !(Math.abs(e.time - time) < 0.02 && e.name === name));
    const nextProject = {
      ...project,
      animations: {
        ...project.animations,
        [activeClip]: {
          ...clip,
          events,
        },
      },
    };
    state.pushHistory(`Removed Event ${name}`, nextProject);
  },

  regenerateAllProceduralClips: () => {
    const state = get();
    const nextProject = {
      ...state.project,
      animations: synthesizeAllFamousGameClips(state.project, state.principles),
    };
    state.pushHistory("Synthesized 14 Famous Game Clips", nextProject);
  },

  bakeCurrentClipSprings: () => {
    const state = get();
    const clip = state.project.animations[state.activeClip];
    if (!clip) return;
    const baked = bakeClipConstraintsToKeyframes(state.project, clip, 24);
    const nextProject = {
      ...state.project,
      animations: {
        ...state.project.animations,
        [state.activeClip]: baked,
      },
    };
    state.pushHistory(`Baked Springs (${state.activeClip})`, nextProject);
  },
}));

const omitTime = (s: StudioState) => {
  const { currentTime, ...rest } = s;
  void currentTime;
  return rest;
};

/**
 * The whole store except the playhead. During playback the playhead changes every frame, so panels
 * that do not draw it read the store through this hook and stay still while the canvas plays.
 */
export function useStudioNoTime() {
  return useStudioStore(useShallow(omitTime));
}

/** The playhead for readouts: exact while paused, a few updates a second while playing. */
export function useReadoutTime() {
  return useStudioStore((s) => (s.isPlaying ? Math.floor(s.currentTime * 5) / 5 : s.currentTime));
}
