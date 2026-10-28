"use client";

import { useEffect, useMemo, useState } from "react";
import {
  COMMANDS,
  comboFromEvent,
  findShortcutConflict,
  formatCombo,
  isMacPlatform,
  resolveCommands,
  type CommandId,
  type KeyGroup,
} from "@/core/keymap";
import type { AiProviderId } from "@/core/copilot/providers";
import {
  ACCENT_SWATCHES,
  deviceBudgetMb,
  estimateWorkingSetMb,
  QUALITY_PRESETS,
  usePreferencesStore,
  WORKSPACE_PRESETS,
  type AccentId,
  type ExportDefault,
  type MeshDensityPref,
  type QualityPreset,
  type ThemePreference,
  type UiDensity,
  type WorkspacePreset,
} from "@/store/usePreferencesStore";
import { useStudioStore } from "@/store/useStudioStore";

const GROUPS: KeyGroup[] = ["Tools", "Keying", "Playback", "Layers", "View", "Edit", "File", "Panels"];
const TABS = [
  { id: "appearance", label: "Appearance" },
  { id: "performance", label: "Performance" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "layout", label: "Layout" },
  { id: "copilot", label: "Copilot" },
  { id: "about", label: "About" },
] as const;

const COPILOT_PROVIDERS: { id: AiProviderId; name: string }[] = [
  { id: "cursor", name: "Built-in" },
  { id: "claude", name: "Claude" },
  { id: "chatgpt", name: "ChatGPT" },
  { id: "grok", name: "Grok" },
];

export function PreferencesModal() {
  const open = usePreferencesStore((s) => s.preferencesOpen);
  const tab = usePreferencesStore((s) => s.preferencesTab);
  const close = usePreferencesStore((s) => s.closePreferences);
  const setTab = usePreferencesStore((s) => s.setPreferencesTab);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/45 pointer-events-auto"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prefs-title"
        className="material-thick w-[min(720px,calc(100vw-32px))] max-h-[min(640px,calc(100vh-48px))] rounded-[16px] flex flex-col overflow-hidden animate-panel-in"
      >
        <header className="h-12 px-4 flex items-center justify-between border-b border-[var(--separator)] shrink-0">
          <h2 id="prefs-title" className="text-[15px] font-semibold">
            Preferences
          </h2>
          <button type="button" className="icon-btn" aria-label="Close preferences" onClick={close}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex flex-1 min-h-0">
          <nav className="w-[148px] shrink-0 border-r border-[var(--separator)] p-2 space-y-0.5 overflow-y-auto">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`w-full text-left h-8 px-2.5 rounded-[8px] text-[12.5px] ${
                  tab === t.id ? "bg-[var(--accent)] text-white font-semibold" : "hover:bg-[var(--fill-3)] text-[var(--label)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="flex-1 min-w-0 overflow-y-auto p-4">
            {tab === "appearance" && <AppearancePane />}
            {tab === "performance" && <PerformancePane />}
            {tab === "shortcuts" && <ShortcutsPane />}
            {tab === "layout" && <LayoutPane />}
            {tab === "copilot" && <CopilotPane />}
            {tab === "about" && <AboutPane />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearancePane() {
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const accent = usePreferencesStore((s) => s.accent);
  const setAccent = usePreferencesStore((s) => s.setAccent);
  const uiDensity = usePreferencesStore((s) => s.uiDensity);
  const setUiDensity = usePreferencesStore((s) => s.setUiDensity);
  const exportDefault = usePreferencesStore((s) => s.exportDefault);
  const setExportDefault = usePreferencesStore((s) => s.setExportDefault);
  const a11yReduceMotion = usePreferencesStore((s) => s.a11yReduceMotion);
  const setA11yReduceMotion = usePreferencesStore((s) => s.setA11yReduceMotion);
  const a11yLargeControls = usePreferencesStore((s) => s.a11yLargeControls);
  const setA11yLargeControls = usePreferencesStore((s) => s.setA11yLargeControls);
  const a11yHighContrast = usePreferencesStore((s) => s.a11yHighContrast);
  const setA11yHighContrast = usePreferencesStore((s) => s.setA11yHighContrast);

  const themes: { id: ThemePreference; label: string; hint: string }[] = [
    { id: "dark", label: "Dark", hint: "Pro dark studio (default)" },
    { id: "light", label: "Light", hint: "Bright panels for daylight" },
    { id: "system", label: "System", hint: "Follow macOS appearance" },
  ];
  const densities: { id: UiDensity; label: string }[] = [
    { id: "compact", label: "Compact" },
    { id: "comfortable", label: "Comfortable" },
    { id: "spacious", label: "Spacious" },
  ];
  const exports: { id: ExportDefault; label: string }[] = [
    { id: "unity-zip", label: "Unity ZIP" },
    { id: "webm", label: "WebM" },
    { id: "both", label: "Both" },
  ];

  return (
    <section className="space-y-5">
      <div>
        <h3 className="section-title mb-2">Theme</h3>
        <div className="grid grid-cols-3 gap-2">
          {themes.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={theme === o.id}
              onClick={() => setTheme(o.id)}
              className={`rounded-[12px] p-3 text-left border transition-colors ${
                theme === o.id ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--separator)] hover:bg-[var(--fill-3)]"
              }`}
            >
              <div className="text-[13px] font-semibold">{o.label}</div>
              <div className="text-[11px] text-[var(--label-3)] mt-1 leading-snug">{o.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="section-title mb-2">Accent</h3>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(ACCENT_SWATCHES) as AccentId[]).map((id) => {
            const sw = ACCENT_SWATCHES[id];
            return (
              <button
                key={id}
                type="button"
                aria-pressed={accent === id}
                aria-label={sw.label}
                onClick={() => setAccent(id)}
                className={`h-8 w-8 rounded-full border-2 ${accent === id ? "border-[var(--label)] scale-110" : "border-transparent"}`}
                style={{ background: sw.dark }}
              />
            );
          })}
        </div>
      </div>

      <div>
        <h3 className="section-title mb-2">UI density</h3>
        <div className="segmented w-full" role="group" aria-label="UI density">
          {densities.map((d) => (
            <button key={d.id} type="button" className="flex-1" aria-pressed={uiDensity === d.id} onClick={() => setUiDensity(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="section-title mb-2">Export default</h3>
        <p className="text-[11.5px] text-[var(--label-3)] mb-2">What the Export button and ⌘E run.</p>
        <div className="segmented w-full" role="group" aria-label="Export default">
          {exports.map((d) => (
            <button key={d.id} type="button" className="flex-1" aria-pressed={exportDefault === d.id} onClick={() => setExportDefault(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="section-title">Accessibility</h3>
        <label className="flex items-center justify-between h-8">
          <span className="text-[12.5px]">Reduce motion</span>
          <input type="checkbox" checked={a11yReduceMotion} onChange={(e) => setA11yReduceMotion(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between h-8">
          <span className="text-[12.5px]">Larger controls</span>
          <input type="checkbox" checked={a11yLargeControls} onChange={(e) => setA11yLargeControls(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between h-8">
          <span className="text-[12.5px]">High contrast</span>
          <input type="checkbox" checked={a11yHighContrast} onChange={(e) => setA11yHighContrast(e.target.checked)} />
        </label>
      </div>
    </section>
  );
}

function PerformancePane() {
  const quality = usePreferencesStore((s) => s.quality);
  const meshDensityDefault = usePreferencesStore((s) => s.meshDensityDefault);
  const pixelRatio = usePreferencesStore((s) => s.pixelRatio);
  const maxFps = usePreferencesStore((s) => s.maxFps);
  const setQuality = usePreferencesStore((s) => s.setQuality);
  const setMeshDensityDefault = usePreferencesStore((s) => s.setMeshDensityDefault);
  const setPixelRatio = usePreferencesStore((s) => s.setPixelRatio);
  const setMaxFps = usePreferencesStore((s) => s.setMaxFps);

  const estimate = estimateWorkingSetMb({ pixelRatio, meshDensityDefault });
  const budget = deviceBudgetMb();
  const pct = Math.min(100, Math.round((estimate / budget) * 100));

  return (
    <section className="space-y-4">
      <div>
        <h3 className="section-title mb-2">GPU / RAM quality</h3>
        <p className="text-[12px] text-[var(--label-2)] leading-snug mb-2">
          Controls canvas resolution, refresh target, and default mesh density. The studio cannot reserve OS RAM; these raise how much GPU/memory work it asks for.
        </p>
        <div className="segmented w-full" role="group" aria-label="Quality preset">
          {(Object.keys(QUALITY_PRESETS) as QualityPreset[]).map((q) => (
            <button key={q} type="button" aria-pressed={quality === q} onClick={() => setQuality(q)} className="flex-1">
              {QUALITY_PRESETS[q].label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] tabular-nums text-[var(--label-3)]">
          Est. studio use ~{estimate} MB · device budget ~{budget} MB ({pct}%)
        </p>
      </div>

      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium">Default mesh density</span>
        <select
          className="w-full h-8 rounded-[8px] bg-[var(--fill-3)] border border-[var(--separator)] px-2 text-[12.5px]"
          value={meshDensityDefault}
          onChange={(e) => setMeshDensityDefault(e.target.value as MeshDensityPref)}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>

      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium flex justify-between">
          Canvas pixel ratio <span className="tabular-nums text-[var(--label-3)]">{pixelRatio.toFixed(2)}×</span>
        </span>
        <input
          type="range"
          min={0.75}
          max={2}
          step={0.05}
          value={pixelRatio}
          onChange={(e) => setPixelRatio(Number(e.target.value))}
          className="w-full"
        />
      </label>

      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium">Max FPS</span>
        <div className="segmented w-full" role="group" aria-label="Max FPS">
          {[30, 60, 120].map((n) => (
            <button key={n} type="button" aria-pressed={maxFps === n} onClick={() => setMaxFps(n)} className="flex-1">
              {n}
            </button>
          ))}
        </div>
      </label>
    </section>
  );
}

function ShortcutsPane() {
  const overrides = usePreferencesStore((s) => s.shortcutOverrides);
  const setOverride = usePreferencesStore((s) => s.setShortcutOverride);
  const resetShortcuts = usePreferencesStore((s) => s.resetShortcuts);
  const [mac] = useState(() => isMacPlatform());
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const commands = useMemo(() => resolveCommands(overrides), [overrides]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setConflict(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const other = findShortcutConflict(combo, recording, overrides);
      if (other) {
        const label = COMMANDS.find((c) => c.id === other)?.label ?? other;
        setConflict(`Conflicts with “${label}”. Choose another key or clear that binding first.`);
        return;
      }
      setOverride(recording, [combo]);
      setRecording(null);
      setConflict(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, overrides, setOverride]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] text-[var(--label-2)] leading-snug">
          Click a shortcut, then press the new keys. Esc cancels. Spine defaults stay until you override them.
        </p>
        <button type="button" className="liquid-glass-button h-7 px-3 text-[12px] rounded-[8px] shrink-0" onClick={resetShortcuts}>
          Reset defaults
        </button>
      </div>
      {conflict && <p className="text-[12px] text-[#ff453a]">{conflict}</p>}
      {recording && (
        <p className="text-[12px] text-[var(--accent-hover)] font-medium">
          Recording “{COMMANDS.find((c) => c.id === recording)?.label}”… press a key
        </p>
      )}
      <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1">
        {GROUPS.map((group) => (
          <div key={group}>
            <h3 className="section-title mb-1">{group}</h3>
            <ul className="space-y-0.5">
              {commands
                .filter((c) => c.group === group)
                .map((c) => {
                  const overridden = Boolean(overrides[c.id]);
                  return (
                    <li key={c.id} className="flex items-center gap-2 py-1 border-b border-[var(--separator)] last:border-0">
                      <span className="flex-1 min-w-0 text-[12.5px] truncate">{c.label}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setConflict(null);
                          setRecording(c.id);
                        }}
                        className={`h-7 min-w-[88px] px-2 rounded-[7px] text-[11.5px] tabular-nums ${
                          recording === c.id ? "bg-[var(--accent)] text-white" : "bg-[var(--fill-2)] hover:bg-[var(--fill)]"
                        }`}
                      >
                        {c.keys[0] ? formatCombo(c.keys[0], mac) : "—"}
                        {overridden ? " *" : ""}
                      </button>
                      {overridden && (
                        <button
                          type="button"
                          className="text-[11px] text-[var(--label-3)] hover:text-[var(--label)]"
                          onClick={() => setOverride(c.id, null)}
                        >
                          Clear
                        </button>
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function LayoutPane() {
  const timelinePosition = usePreferencesStore((s) => s.timelinePosition);
  const setTimelinePosition = usePreferencesStore((s) => s.setTimelinePosition);
  const leftOpen = usePreferencesStore((s) => s.leftOpen);
  const inspectorOpen = usePreferencesStore((s) => s.inspectorOpen);
  const copilotOpen = usePreferencesStore((s) => s.copilotOpen);
  const setLeftOpen = usePreferencesStore((s) => s.setLeftOpen);
  const setInspectorOpen = usePreferencesStore((s) => s.setInspectorOpen);
  const setCopilotOpen = usePreferencesStore((s) => s.setCopilotOpen);
  const leftWidth = usePreferencesStore((s) => s.leftWidth);
  const inspectorWidth = usePreferencesStore((s) => s.inspectorWidth);
  const setLeftWidth = usePreferencesStore((s) => s.setLeftWidth);
  const setInspectorWidth = usePreferencesStore((s) => s.setInspectorWidth);
  const resetLayout = usePreferencesStore((s) => s.resetLayout);
  const workspacePreset = usePreferencesStore((s) => s.workspacePreset);
  const applyWorkspacePreset = usePreferencesStore((s) => s.applyWorkspacePreset);
  const panelMode = usePreferencesStore((s) => s.panelMode);
  const undockPanel = usePreferencesStore((s) => s.undockPanel);
  const dockPanel = usePreferencesStore((s) => s.dockPanel);
  const setMode = useStudioStore((s) => s.setMode);

  const applyPreset = (id: Exclude<WorkspacePreset, "custom">) => {
    const studioMode = applyWorkspacePreset(id);
    setMode(studioMode);
  };

  return (
    <section className="space-y-4">
      <div>
        <h3 className="section-title mb-2">Workspace presets</h3>
        <div className="segmented w-full" role="group" aria-label="Workspace preset">
          {(Object.keys(WORKSPACE_PRESETS) as Exclude<WorkspacePreset, "custom">[]).map((id) => (
            <button key={id} type="button" className="flex-1" aria-pressed={workspacePreset === id} onClick={() => applyPreset(id)}>
              {WORKSPACE_PRESETS[id].label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--label-3)]">
          {workspacePreset === "custom"
            ? "Custom layout"
            : WORKSPACE_PRESETS[workspacePreset].hint}
        </p>
      </div>

      <div>
        <h3 className="section-title mb-2">Timeline / dope sheet</h3>
        <div className="segmented w-full" role="group" aria-label="Timeline position">
          <button type="button" className="flex-1" aria-pressed={timelinePosition === "top"} onClick={() => setTimelinePosition("top")}>
            Top
          </button>
          <button type="button" className="flex-1" aria-pressed={timelinePosition === "bottom"} onClick={() => setTimelinePosition("bottom")}>
            Bottom
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="section-title">Panels</h3>
        <label className="flex items-center justify-between h-8">
          <span className="text-[12.5px]">Tool options (left)</span>
          <input type="checkbox" checked={leftOpen} onChange={(e) => setLeftOpen(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between h-8">
          <span className="text-[12.5px]">Inspector (right)</span>
          <input type="checkbox" checked={inspectorOpen} onChange={(e) => setInspectorOpen(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between h-8">
          <span className="text-[12.5px]">Copilot</span>
          <input type="checkbox" checked={copilotOpen} onChange={(e) => setCopilotOpen(e.target.checked)} />
        </label>
      </div>

      <div className="space-y-2">
        <h3 className="section-title">Float / dock</h3>
        {(
          [
            ["left", "Tool options"],
            ["inspector", "Inspector"],
            ["copilot", "Copilot"],
          ] as const
        ).map(([id, label]) => (
          <div key={id} className="flex items-center justify-between h-8 gap-2">
            <span className="text-[12.5px]">{label}</span>
            <button
              type="button"
              className="h-7 px-2.5 rounded-[7px] text-[11.5px] bg-[var(--fill-2)] hover:bg-[var(--fill)]"
              onClick={() => (panelMode[id] === "float" ? dockPanel(id) : undockPanel(id))}
            >
              {panelMode[id] === "float" ? "Dock" : "Float"}
            </button>
          </div>
        ))}
      </div>

      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium flex justify-between">
          Left width <span className="tabular-nums text-[var(--label-3)]">{leftWidth}px</span>
        </span>
        <input type="range" min={220} max={420} value={leftWidth} onChange={(e) => setLeftWidth(Number(e.target.value))} className="w-full" />
      </label>
      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium flex justify-between">
          Inspector width <span className="tabular-nums text-[var(--label-3)]">{inspectorWidth}px</span>
        </span>
        <input
          type="range"
          min={240}
          max={440}
          value={inspectorWidth}
          onChange={(e) => setInspectorWidth(Number(e.target.value))}
          className="w-full"
        />
      </label>

      <button type="button" className="liquid-glass-button h-8 px-3 text-[12px] rounded-[8px]" onClick={resetLayout}>
        Reset layout
      </button>
    </section>
  );
}

function CopilotPane() {
  const provider = usePreferencesStore((s) => s.copilotProviderDefault);
  const setProvider = usePreferencesStore((s) => s.setCopilotProviderDefault);
  const model = usePreferencesStore((s) => s.copilotModelDefault);
  const setModel = usePreferencesStore((s) => s.setCopilotModelDefault);
  const cap = usePreferencesStore((s) => s.copilotSpendCapUsd);
  const setCap = usePreferencesStore((s) => s.setCopilotSpendCapUsd);
  const used = usePreferencesStore((s) => s.copilotSpendUsedUsd);
  const month = usePreferencesStore((s) => s.copilotSpendMonth);
  const resetSpend = usePreferencesStore((s) => s.resetCopilotSpend);

  return (
    <section className="space-y-4">
      <div>
        <h3 className="section-title mb-2">Default provider</h3>
        <div className="segmented w-full" role="group" aria-label="Copilot provider">
          {COPILOT_PROVIDERS.map((p) => (
            <button key={p.id} type="button" className="flex-1 text-[11.5px]" aria-pressed={provider === p.id} onClick={() => setProvider(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium">Default model</span>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Provider default"
          className="w-full h-8 rounded-[8px] bg-[var(--fill-3)] border border-[var(--separator)] px-2 text-[12.5px]"
        />
      </label>

      <div>
        <h3 className="section-title mb-2">Spend cap (soft)</h3>
        <p className="text-[11.5px] text-[var(--label-3)] mb-2">
          Local estimate (~$0.02 per cloud turn). At the cap, Copilot falls back to the built-in planner. 0 = off.
        </p>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium flex justify-between">
            Monthly cap (USD) <span className="tabular-nums text-[var(--label-3)]">${cap.toFixed(2)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={20}
            step={0.5}
            value={cap}
            onChange={(e) => setCap(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <p className="mt-2 text-[12px] tabular-nums text-[var(--label-2)]">
          Used this month ({month}): <span className="font-semibold text-[var(--label)]">${used.toFixed(2)}</span>
          {cap > 0 ? ` / $${cap.toFixed(2)}` : ""}
        </p>
        <button type="button" className="mt-2 liquid-glass-button h-7 px-3 text-[12px] rounded-[8px]" onClick={resetSpend}>
          Reset spend meter
        </button>
      </div>
    </section>
  );
}

function AboutPane() {
  const resetAll = usePreferencesStore((s) => s.resetAll);
  return (
    <section className="space-y-3 text-[12.5px] leading-relaxed text-[var(--label-2)]">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/kinetic-icon.svg" alt="" width={48} height={48} className="rounded-[12px] shadow-sm" draggable={false} />
        <div>
          <p className="text-[14px] font-semibold text-[var(--label)]">Kinetic Pro</p>
          <p className="text-[12px]">Claude studio in a native macOS window</p>
        </div>
      </div>
      <p>
        Built by{" "}
        <a
          href="https://www.linkedin.com/in/amittayal/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-semibold text-[var(--label)] hover:text-[var(--accent-hover)]"
        >
          Amit Tayal
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" className="text-[#0A66C2]">
            <path
              fill="currentColor"
              d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.23 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.23 0z"
            />
          </svg>
        </a>
      </p>
      <p className="text-[11.5px] text-[var(--label-3)]">Preferences are stored in this profile (`kinetic.preferences.v1`).</p>
      <div>
        <h3 className="section-title mb-1.5 text-[var(--label)]">Included in this build</h3>
        <ul className="list-disc pl-4 space-y-1">
          <li>Drag-drop dock zones &amp; floating panels</li>
          <li>Workspace presets (Rig / Animate / Export)</li>
          <li>Custom accent color &amp; UI density</li>
          <li>Export defaults &amp; accessibility options</li>
          <li>Copilot provider defaults &amp; spend caps</li>
        </ul>
      </div>
      <button type="button" className="liquid-glass-button h-8 px-3 text-[12px] rounded-[8px] text-[#ff453a]" onClick={resetAll}>
        Reset all preferences
      </button>
    </section>
  );
}
