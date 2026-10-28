"use client";

import { create } from "zustand";
import type { CommandId } from "@/core/keymap";
import type { AiProviderId } from "@/core/copilot/providers";

export type ThemePreference = "dark" | "light" | "system";
export type QualityPreset = "low" | "balanced" | "max";
export type MeshDensityPref = "low" | "medium" | "high";
export type TimelinePosition = "bottom" | "top";
export type PanelId = "left" | "inspector" | "copilot";
export type PanelDockMode = "docked" | "float";
export type WorkspacePreset = "custom" | "rig" | "animate" | "export";
export type AccentId = "blue" | "teal" | "violet" | "orange" | "rose";
export type UiDensity = "compact" | "comfortable" | "spacious";
export type ExportDefault = "unity-zip" | "webm" | "both";

export type FloatRect = { x: number; y: number; w: number; h: number };
export type PanelModeMap = Record<PanelId, PanelDockMode>;
export type FloatRectMap = Record<PanelId, FloatRect>;

export type ShortcutOverrides = Partial<Record<CommandId, string[]>>;

export type PreferencesState = {
  theme: ThemePreference;
  quality: QualityPreset;
  meshDensityDefault: MeshDensityPref;
  /** Cap on devicePixelRatio used for the canvas (0.75–2). */
  pixelRatio: number;
  /** Target display refresh for the viewport loop. */
  maxFps: number;
  shortcutOverrides: ShortcutOverrides;
  timelinePosition: TimelinePosition;
  leftOpen: boolean;
  inspectorOpen: boolean;
  copilotOpen: boolean;
  leftWidth: number;
  inspectorWidth: number;
  timelineHeight: number;
  dopeExpanded: boolean;
  panelMode: PanelModeMap;
  floatRects: FloatRectMap;
  workspacePreset: WorkspacePreset;
  accent: AccentId;
  uiDensity: UiDensity;
  exportDefault: ExportDefault;
  a11yReduceMotion: boolean;
  a11yLargeControls: boolean;
  a11yHighContrast: boolean;
  copilotProviderDefault: AiProviderId;
  copilotModelDefault: string;
  /** Soft monthly spend cap in USD; 0 = off. */
  copilotSpendCapUsd: number;
  copilotSpendUsedUsd: number;
  /** `YYYY-MM` for the spend meter. */
  copilotSpendMonth: string;
  /** Last opened project ids (most recent first). */
  recentProjects: { id: string; title: string; at: number }[];
  /** Onion-skin ghost pairs on each side of the playhead (1–3). */
  onionSkinDepth: 1 | 2 | 3;
  /** Ghost opacity 0.05–0.5. */
  onionSkinOpacity: number;
  preferencesOpen: boolean;
  preferencesTab: "appearance" | "performance" | "shortcuts" | "layout" | "copilot" | "about";
};

export type RecentProject = { id: string; title: string; at: number };

const STORAGE_KEY = "kinetic.preferences.v1";

export const QUALITY_PRESETS: Record<
  QualityPreset,
  { meshDensityDefault: MeshDensityPref; pixelRatio: number; maxFps: number; label: string }
> = {
  low: { meshDensityDefault: "low", pixelRatio: 0.75, maxFps: 30, label: "Low" },
  balanced: { meshDensityDefault: "medium", pixelRatio: 1, maxFps: 60, label: "Balanced" },
  max: { meshDensityDefault: "high", pixelRatio: 2, maxFps: 120, label: "Max" },
};

export const ACCENT_SWATCHES: Record<AccentId, { label: string; dark: string; light: string; hoverDark: string; hoverLight: string }> = {
  blue: { label: "Blue", dark: "#0a84ff", light: "#0071e3", hoverDark: "#3d9bff", hoverLight: "#0077ed" },
  teal: { label: "Teal", dark: "#64d2ff", light: "#00a3c4", hoverDark: "#70d7ff", hoverLight: "#0090ad" },
  violet: { label: "Violet", dark: "#bf5af2", light: "#8944ab", hoverDark: "#cc7bf5", hoverLight: "#7a3c99" },
  orange: { label: "Orange", dark: "#ff9f0a", light: "#c93400", hoverDark: "#ffb340", hoverLight: "#d9440a" },
  rose: { label: "Rose", dark: "#ff375f", light: "#d70015", hoverDark: "#ff6482", hoverLight: "#bf0012" },
};

export const DEFAULT_FLOAT_RECTS: FloatRectMap = {
  left: { x: 56, y: 72, w: 300, h: 520 },
  inspector: { x: 920, y: 72, w: 320, h: 560 },
  copilot: { x: 640, y: 100, w: 360, h: 480 },
};

export const DEFAULT_PANEL_MODE: PanelModeMap = {
  left: "docked",
  inspector: "docked",
  copilot: "docked",
};

function currentSpendMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export const DEFAULT_PREFERENCES: PreferencesState = {
  theme: "dark",
  quality: "balanced",
  meshDensityDefault: "medium",
  pixelRatio: 1,
  maxFps: 60,
  shortcutOverrides: {},
  timelinePosition: "bottom",
  leftOpen: true,
  inspectorOpen: true,
  copilotOpen: false,
  leftWidth: 288,
  inspectorWidth: 300,
  timelineHeight: 300,
  dopeExpanded: false,
  panelMode: { ...DEFAULT_PANEL_MODE },
  floatRects: { ...DEFAULT_FLOAT_RECTS },
  workspacePreset: "custom",
  accent: "blue",
  uiDensity: "comfortable",
  exportDefault: "unity-zip",
  a11yReduceMotion: false,
  a11yLargeControls: false,
  a11yHighContrast: false,
  copilotProviderDefault: "cursor",
  copilotModelDefault: "",
  copilotSpendCapUsd: 0,
  copilotSpendUsedUsd: 0,
  copilotSpendMonth: currentSpendMonth(),
  recentProjects: [],
  onionSkinDepth: 2,
  onionSkinOpacity: 0.22,
  preferencesOpen: false,
  preferencesTab: "appearance",
};

/** Studio mode returned when applying a workspace preset. */
export type WorkspaceStudioMode = "auto" | "animate" | "export" | "rig";

export const WORKSPACE_PRESETS: Record<
  Exclude<WorkspacePreset, "custom">,
  {
    label: string;
    hint: string;
    leftOpen: boolean;
    inspectorOpen: boolean;
    copilotOpen: boolean;
    dopeExpanded: boolean;
    panelMode: PanelModeMap;
    studioMode: WorkspaceStudioMode;
  }
> = {
  rig: {
    label: "Rig",
    hint: "Tool options + inspector; Auto Rig ready",
    leftOpen: true,
    inspectorOpen: true,
    copilotOpen: false,
    dopeExpanded: false,
    panelMode: { left: "docked", inspector: "docked", copilot: "docked" },
    studioMode: "auto",
  },
  animate: {
    label: "Animate",
    hint: "Timeline open; pose tools",
    leftOpen: true,
    inspectorOpen: true,
    copilotOpen: false,
    dopeExpanded: true,
    panelMode: { left: "docked", inspector: "docked", copilot: "docked" },
    studioMode: "animate",
  },
  export: {
    label: "Export",
    hint: "Export pane + budget inspector",
    leftOpen: true,
    inspectorOpen: true,
    copilotOpen: false,
    dopeExpanded: false,
    panelMode: { left: "docked", inspector: "docked", copilot: "docked" },
    studioMode: "export",
  },
};

function normalizeLoaded(parsed: Partial<PreferencesState>): PreferencesState {
  const month = currentSpendMonth();
  const spendMonth = parsed.copilotSpendMonth ?? month;
  const rolled = spendMonth !== month;
  return {
    ...DEFAULT_PREFERENCES,
    ...parsed,
    shortcutOverrides: parsed.shortcutOverrides ?? {},
    panelMode: { ...DEFAULT_PANEL_MODE, ...parsed.panelMode },
    floatRects: {
      left: { ...DEFAULT_FLOAT_RECTS.left, ...parsed.floatRects?.left },
      inspector: { ...DEFAULT_FLOAT_RECTS.inspector, ...parsed.floatRects?.inspector },
      copilot: { ...DEFAULT_FLOAT_RECTS.copilot, ...parsed.floatRects?.copilot },
    },
    copilotSpendUsedUsd: rolled ? 0 : (parsed.copilotSpendUsedUsd ?? 0),
    copilotSpendMonth: month,
    recentProjects: Array.isArray(parsed.recentProjects) ? parsed.recentProjects.slice(0, 8) : [],
    onionSkinDepth: ([1, 2, 3] as const).includes(parsed.onionSkinDepth as 1 | 2 | 3)
      ? (parsed.onionSkinDepth as 1 | 2 | 3)
      : DEFAULT_PREFERENCES.onionSkinDepth,
    onionSkinOpacity: Math.max(0.05, Math.min(0.5, parsed.onionSkinOpacity ?? DEFAULT_PREFERENCES.onionSkinOpacity)),
    preferencesOpen: false,
  };
}

function load(): PreferencesState {
  if (typeof window === "undefined") return { ...DEFAULT_PREFERENCES };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return normalizeLoaded(JSON.parse(raw) as Partial<PreferencesState>);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function persist(state: PreferencesState) {
  if (typeof window === "undefined") return;
  try {
    const { preferencesOpen: _o, preferencesTab: _t, ...rest } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    // storage full / private mode
  }
}

export function resolvedTheme(theme: ThemePreference): "dark" | "light" {
  if (theme === "system" && typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme === "light" ? "light" : "dark";
}

/** Theme-only apply (legacy callers). Prefer `applyAppearanceToDocument` with full prefs. */
export function applyThemeToDocument(theme: ThemePreference) {
  if (typeof document === "undefined") return;
  const resolved = resolvedTheme(theme);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function applyAppearanceToDocument(opts: {
  theme: ThemePreference;
  accent: AccentId;
  uiDensity: UiDensity;
  a11yReduceMotion: boolean;
  a11yLargeControls: boolean;
  a11yHighContrast: boolean;
}) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved = resolvedTheme(opts.theme);
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  root.dataset.density = opts.uiDensity;
  root.dataset.contrast = opts.a11yHighContrast ? "high" : "normal";
  root.dataset.controls = opts.a11yLargeControls ? "large" : "default";
  root.classList.toggle("reduce-motion", opts.a11yReduceMotion);

  const swatch = ACCENT_SWATCHES[opts.accent];
  const accent = resolved === "light" ? swatch.light : swatch.dark;
  const hover = resolved === "light" ? swatch.hoverLight : swatch.hoverDark;
  const r = parseInt(accent.slice(1, 3), 16);
  const g = parseInt(accent.slice(3, 5), 16);
  const b = parseInt(accent.slice(5, 7), 16);
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-hover", hover);
  root.style.setProperty("--accent-soft", `rgba(${r}, ${g}, ${b}, ${resolved === "light" ? 0.14 : 0.18})`);
}

/** Soft device memory budget in MB (navigator.deviceMemory is GB when present). */
export function deviceBudgetMb(): number {
  if (typeof navigator === "undefined") return 8192;
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return gb ? Math.round(gb * 1024) : 8192;
}

/** Rough studio working-set estimate from canvas + mesh quality. */
export function estimateWorkingSetMb(opts: {
  pixelRatio: number;
  meshDensityDefault: MeshDensityPref;
  canvasCssW?: number;
  canvasCssH?: number;
}): number {
  const w = opts.canvasCssW ?? 1440;
  const h = opts.canvasCssH ?? 900;
  const dpr = opts.pixelRatio;
  const pixels = w * h * dpr * dpr;
  const frameMb = (pixels * 8) / (1024 * 1024);
  const densityMul = opts.meshDensityDefault === "low" ? 0.6 : opts.meshDensityDefault === "high" ? 1.8 : 1;
  const meshMb = 48 * densityMul;
  return Math.max(32, Math.round(frameMb + meshMb + 64));
}

/** Soft estimate charged per successful cloud copilot turn. */
export const COPILOT_TURN_COST_USD = 0.02;

type PrefActions = {
  setTheme: (theme: ThemePreference) => void;
  setQuality: (quality: QualityPreset) => void;
  setMeshDensityDefault: (d: MeshDensityPref) => void;
  setPixelRatio: (n: number) => void;
  setMaxFps: (n: number) => void;
  setShortcutOverride: (id: CommandId, keys: string[] | null) => void;
  resetShortcuts: () => void;
  setTimelinePosition: (p: TimelinePosition) => void;
  setLeftOpen: (v: boolean) => void;
  setInspectorOpen: (v: boolean) => void;
  setCopilotOpen: (v: boolean) => void;
  setLeftWidth: (n: number) => void;
  setInspectorWidth: (n: number) => void;
  setTimelineHeight: (n: number) => void;
  setDopeExpanded: (v: boolean) => void;
  setPanelMode: (id: PanelId, mode: PanelDockMode) => void;
  setFloatRect: (id: PanelId, rect: FloatRect) => void;
  undockPanel: (id: PanelId) => void;
  dockPanel: (id: PanelId) => void;
  markLayoutCustom: () => void;
  applyWorkspacePreset: (id: Exclude<WorkspacePreset, "custom">) => WorkspaceStudioMode;
  setAccent: (accent: AccentId) => void;
  setUiDensity: (d: UiDensity) => void;
  setExportDefault: (d: ExportDefault) => void;
  setA11yReduceMotion: (v: boolean) => void;
  setA11yLargeControls: (v: boolean) => void;
  setA11yHighContrast: (v: boolean) => void;
  setCopilotProviderDefault: (id: AiProviderId) => void;
  setCopilotModelDefault: (model: string) => void;
  setCopilotSpendCapUsd: (n: number) => void;
  recordCopilotSpend: (usd?: number) => void;
  resetCopilotSpend: () => void;
  isCopilotSpendBlocked: () => boolean;
  pushRecentProject: (id: string, title: string) => void;
  clearRecentProjects: () => void;
  setOnionSkinDepth: (n: 1 | 2 | 3) => void;
  setOnionSkinOpacity: (n: number) => void;
  openPreferences: (tab?: PreferencesState["preferencesTab"]) => void;
  closePreferences: () => void;
  setPreferencesTab: (tab: PreferencesState["preferencesTab"]) => void;
  resetLayout: () => void;
  resetAll: () => void;
  hydrate: () => void;
};

function appearanceSlice(s: PreferencesState) {
  return {
    theme: s.theme,
    accent: s.accent,
    uiDensity: s.uiDensity,
    a11yReduceMotion: s.a11yReduceMotion,
    a11yLargeControls: s.a11yLargeControls,
    a11yHighContrast: s.a11yHighContrast,
  };
}

function persistSet(partial: Partial<PreferencesState>) {
  return (s: PreferencesState & PrefActions) => {
    const next = { ...s, ...partial };
    persist(next);
    return partial;
  };
}

export const usePreferencesStore = create<PreferencesState & PrefActions>((set, get) => ({
  ...DEFAULT_PREFERENCES,

  hydrate: () => {
    const next = load();
    set(next);
    applyAppearanceToDocument(appearanceSlice(next));
  },

  setTheme: (theme) => {
    set((s) => {
      const next = { ...s, theme };
      persist(next);
      applyAppearanceToDocument(appearanceSlice(next));
      return { theme };
    });
  },

  setQuality: (quality) => {
    const preset = QUALITY_PRESETS[quality];
    set((s) => {
      const next = {
        ...s,
        quality,
        meshDensityDefault: preset.meshDensityDefault,
        pixelRatio: preset.pixelRatio,
        maxFps: preset.maxFps,
      };
      persist(next);
      return {
        quality,
        meshDensityDefault: preset.meshDensityDefault,
        pixelRatio: preset.pixelRatio,
        maxFps: preset.maxFps,
      };
    });
  },

  setMeshDensityDefault: (meshDensityDefault) =>
    set((s) => {
      const next = { ...s, meshDensityDefault, quality: "balanced" as QualityPreset };
      persist(next);
      return { meshDensityDefault, quality: "balanced" as QualityPreset };
    }),

  setPixelRatio: (pixelRatio) =>
    set((s) => {
      const clamped = Math.max(0.75, Math.min(2, Number(pixelRatio.toFixed(2))));
      const next = { ...s, pixelRatio: clamped };
      persist(next);
      return { pixelRatio: clamped };
    }),

  setMaxFps: (maxFps) =>
    set((s) => {
      const allowed = [30, 60, 120].includes(maxFps) ? maxFps : 60;
      const next = { ...s, maxFps: allowed };
      persist(next);
      return { maxFps: allowed };
    }),

  setShortcutOverride: (id, keys) =>
    set((s) => {
      const shortcutOverrides = { ...s.shortcutOverrides };
      if (!keys || keys.length === 0) delete shortcutOverrides[id];
      else shortcutOverrides[id] = keys;
      const next = { ...s, shortcutOverrides };
      persist(next);
      return { shortcutOverrides };
    }),

  resetShortcuts: () =>
    set((s) => {
      const next = { ...s, shortcutOverrides: {} };
      persist(next);
      return { shortcutOverrides: {} };
    }),

  setTimelinePosition: (timelinePosition) =>
    set((s) => {
      const next = { ...s, timelinePosition, workspacePreset: "custom" as WorkspacePreset };
      persist(next);
      return { timelinePosition, workspacePreset: "custom" as WorkspacePreset };
    }),

  setLeftOpen: (leftOpen) =>
    set((s) => {
      const next = { ...s, leftOpen, workspacePreset: "custom" as WorkspacePreset };
      persist(next);
      return { leftOpen, workspacePreset: "custom" as WorkspacePreset };
    }),

  setInspectorOpen: (inspectorOpen) =>
    set((s) => {
      const next = { ...s, inspectorOpen, workspacePreset: "custom" as WorkspacePreset };
      persist(next);
      return { inspectorOpen, workspacePreset: "custom" as WorkspacePreset };
    }),

  setCopilotOpen: (copilotOpen) =>
    set((s) => {
      const next = { ...s, copilotOpen, workspacePreset: "custom" as WorkspacePreset };
      persist(next);
      return { copilotOpen, workspacePreset: "custom" as WorkspacePreset };
    }),

  setLeftWidth: (leftWidth) =>
    set((s) => {
      const w = Math.max(220, Math.min(420, Math.round(leftWidth)));
      const next = { ...s, leftWidth: w };
      persist(next);
      return { leftWidth: w };
    }),

  setInspectorWidth: (inspectorWidth) =>
    set((s) => {
      const w = Math.max(240, Math.min(440, Math.round(inspectorWidth)));
      const next = { ...s, inspectorWidth: w };
      persist(next);
      return { inspectorWidth: w };
    }),

  setTimelineHeight: (timelineHeight) =>
    set((s) => {
      const h = Math.max(200, Math.min(480, Math.round(timelineHeight)));
      const next = { ...s, timelineHeight: h };
      persist(next);
      return { timelineHeight: h };
    }),

  setDopeExpanded: (dopeExpanded) =>
    set((s) => {
      const next = { ...s, dopeExpanded, workspacePreset: "custom" as WorkspacePreset };
      persist(next);
      return { dopeExpanded, workspacePreset: "custom" as WorkspacePreset };
    }),

  setPanelMode: (id, mode) =>
    set((s) => {
      const panelMode = { ...s.panelMode, [id]: mode };
      const next = { ...s, panelMode, workspacePreset: "custom" as WorkspacePreset };
      persist(next);
      return { panelMode, workspacePreset: "custom" as WorkspacePreset };
    }),

  setFloatRect: (id, rect) =>
    set((s) => {
      const floatRects = {
        ...s.floatRects,
        [id]: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.max(240, Math.round(rect.w)),
          h: Math.max(200, Math.round(rect.h)),
        },
      };
      const next = { ...s, floatRects };
      persist(next);
      return { floatRects };
    }),

  undockPanel: (id) =>
    set((s) => {
      const panelMode = { ...s.panelMode, [id]: "float" as PanelDockMode };
      const openPatch =
        id === "left" ? { leftOpen: true } : id === "inspector" ? { inspectorOpen: true } : { copilotOpen: true };
      const next = { ...s, panelMode, ...openPatch, workspacePreset: "custom" as WorkspacePreset };
      persist(next);
      return { panelMode, ...openPatch, workspacePreset: "custom" as WorkspacePreset };
    }),

  dockPanel: (id) =>
    set((s) => {
      const panelMode = { ...s.panelMode, [id]: "docked" as PanelDockMode };
      const openPatch =
        id === "left" ? { leftOpen: true } : id === "inspector" ? { inspectorOpen: true } : { copilotOpen: true };
      const next = { ...s, panelMode, ...openPatch, workspacePreset: "custom" as WorkspacePreset };
      persist(next);
      return { panelMode, ...openPatch, workspacePreset: "custom" as WorkspacePreset };
    }),

  markLayoutCustom: () =>
    set((s) => {
      if (s.workspacePreset === "custom") return {};
      const next = { ...s, workspacePreset: "custom" as WorkspacePreset };
      persist(next);
      return { workspacePreset: "custom" as WorkspacePreset };
    }),

  applyWorkspacePreset: (id) => {
    const preset = WORKSPACE_PRESETS[id];
    set((s) => {
      const next = {
        ...s,
        workspacePreset: id,
        leftOpen: preset.leftOpen,
        inspectorOpen: preset.inspectorOpen,
        copilotOpen: preset.copilotOpen,
        dopeExpanded: preset.dopeExpanded,
        panelMode: { ...preset.panelMode },
      };
      persist(next);
      return {
        workspacePreset: id,
        leftOpen: preset.leftOpen,
        inspectorOpen: preset.inspectorOpen,
        copilotOpen: preset.copilotOpen,
        dopeExpanded: preset.dopeExpanded,
        panelMode: { ...preset.panelMode },
      };
    });
    return preset.studioMode;
  },

  setAccent: (accent) =>
    set((s) => {
      const next = { ...s, accent };
      persist(next);
      applyAppearanceToDocument(appearanceSlice(next));
      return { accent };
    }),

  setUiDensity: (uiDensity) =>
    set((s) => {
      const next = { ...s, uiDensity };
      persist(next);
      applyAppearanceToDocument(appearanceSlice(next));
      return { uiDensity };
    }),

  setExportDefault: (exportDefault) => set(persistSet({ exportDefault })),

  setA11yReduceMotion: (a11yReduceMotion) =>
    set((s) => {
      const next = { ...s, a11yReduceMotion };
      persist(next);
      applyAppearanceToDocument(appearanceSlice(next));
      return { a11yReduceMotion };
    }),

  setA11yLargeControls: (a11yLargeControls) =>
    set((s) => {
      const next = { ...s, a11yLargeControls };
      persist(next);
      applyAppearanceToDocument(appearanceSlice(next));
      return { a11yLargeControls };
    }),

  setA11yHighContrast: (a11yHighContrast) =>
    set((s) => {
      const next = { ...s, a11yHighContrast };
      persist(next);
      applyAppearanceToDocument(appearanceSlice(next));
      return { a11yHighContrast };
    }),

  setCopilotProviderDefault: (copilotProviderDefault) => set(persistSet({ copilotProviderDefault })),

  setCopilotModelDefault: (copilotModelDefault) => set(persistSet({ copilotModelDefault })),

  setCopilotSpendCapUsd: (n) =>
    set((s) => {
      const copilotSpendCapUsd = Math.max(0, Math.min(500, Number(n.toFixed(2))));
      const next = { ...s, copilotSpendCapUsd };
      persist(next);
      return { copilotSpendCapUsd };
    }),

  recordCopilotSpend: (usd = COPILOT_TURN_COST_USD) =>
    set((s) => {
      const month = currentSpendMonth();
      const base = s.copilotSpendMonth === month ? s.copilotSpendUsedUsd : 0;
      const copilotSpendUsedUsd = Number((base + usd).toFixed(4));
      const next = { ...s, copilotSpendUsedUsd, copilotSpendMonth: month };
      persist(next);
      return { copilotSpendUsedUsd, copilotSpendMonth: month };
    }),

  resetCopilotSpend: () =>
    set((s) => {
      const next = { ...s, copilotSpendUsedUsd: 0, copilotSpendMonth: currentSpendMonth() };
      persist(next);
      return { copilotSpendUsedUsd: 0, copilotSpendMonth: next.copilotSpendMonth };
    }),

  isCopilotSpendBlocked: () => {
    const s = get();
    if (s.copilotSpendCapUsd <= 0) return false;
    const month = currentSpendMonth();
    const used = s.copilotSpendMonth === month ? s.copilotSpendUsedUsd : 0;
    return used >= s.copilotSpendCapUsd;
  },

  pushRecentProject: (id, title) =>
    set((s) => {
      const entry = { id, title, at: Date.now() };
      const recentProjects = [entry, ...s.recentProjects.filter((r) => r.id !== id)].slice(0, 8);
      const next = { ...s, recentProjects };
      persist(next);
      return { recentProjects };
    }),

  clearRecentProjects: () => set(persistSet({ recentProjects: [] })),

  setOnionSkinDepth: (onionSkinDepth) => set(persistSet({ onionSkinDepth })),

  setOnionSkinOpacity: (n) =>
    set((s) => {
      const onionSkinOpacity = Math.max(0.05, Math.min(0.5, Number(n.toFixed(2))));
      const next = { ...s, onionSkinOpacity };
      persist(next);
      return { onionSkinOpacity };
    }),

  openPreferences: (tab) =>
    set({
      preferencesOpen: true,
      preferencesTab: tab ?? get().preferencesTab,
    }),

  closePreferences: () => set({ preferencesOpen: false }),

  setPreferencesTab: (preferencesTab) => set({ preferencesTab }),

  resetLayout: () =>
    set((s) => {
      const next = {
        ...s,
        timelinePosition: DEFAULT_PREFERENCES.timelinePosition,
        leftOpen: DEFAULT_PREFERENCES.leftOpen,
        inspectorOpen: DEFAULT_PREFERENCES.inspectorOpen,
        copilotOpen: DEFAULT_PREFERENCES.copilotOpen,
        leftWidth: DEFAULT_PREFERENCES.leftWidth,
        inspectorWidth: DEFAULT_PREFERENCES.inspectorWidth,
        timelineHeight: DEFAULT_PREFERENCES.timelineHeight,
        dopeExpanded: DEFAULT_PREFERENCES.dopeExpanded,
        panelMode: { ...DEFAULT_PANEL_MODE },
        floatRects: { ...DEFAULT_FLOAT_RECTS },
        workspacePreset: "custom" as WorkspacePreset,
      };
      persist(next);
      return {
        timelinePosition: next.timelinePosition,
        leftOpen: next.leftOpen,
        inspectorOpen: next.inspectorOpen,
        copilotOpen: next.copilotOpen,
        leftWidth: next.leftWidth,
        inspectorWidth: next.inspectorWidth,
        timelineHeight: next.timelineHeight,
        dopeExpanded: next.dopeExpanded,
        panelMode: next.panelMode,
        floatRects: next.floatRects,
        workspacePreset: next.workspacePreset,
      };
    }),

  resetAll: () => {
    const next = {
      ...DEFAULT_PREFERENCES,
      preferencesOpen: get().preferencesOpen,
      preferencesTab: get().preferencesTab,
      copilotSpendMonth: currentSpendMonth(),
    };
    persist(next);
    applyAppearanceToDocument(appearanceSlice(next));
    set(next);
  },
}));
