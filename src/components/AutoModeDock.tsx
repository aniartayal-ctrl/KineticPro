"use client";

import { useState } from "react";
import { getThemeSymbols } from "@/core/batch-symbols";
import { VOICE_PHRASE_PRESETS } from "@/core/parallax-and-lipsync";
import {
  FAMOUS_GAME_ACTIONS,
  type AutoArchetypeId,
} from "@/core/physics-and-principles";
import {
  profileProjectForUnityMobile,
  type ElementalVfxType,
} from "@/core/vfx-colliders-profiler";
import { useStudioNoTime } from "@/store/useStudioStore";
import { heroTemplate } from "./ProjectsMenu";

const ARCHETYPE_OPTIONS: { id: AutoArchetypeId; label: string }[] = [
  { id: "auto_detect", label: "Auto-Detect from Visuals" },
  { id: "heavy_titan", label: "Heavy Titan / Warhammer" },
  { id: "olympus_caster", label: "Olympus Sky Caster (Zeus)" },
  { id: "agile_duelist", label: "Agile Duelist / Cleave" },
  { id: "slot_symbol", label: "Slot Wild / Scatter Medallion" },
  { id: "treasure_chest", label: "Bonus Treasure Chest" },
];

const VFX_OPTIONS: { id: ElementalVfxType; label: string }[] = [
  { id: "none", label: "Off" },
  { id: "lightning_bolts", label: "Bolts" },
  { id: "fire_aura", label: "Fire" },
  { id: "shockwave_rings", label: "Rings" },
  { id: "coin_fountain", label: "Coins" },
  { id: "star_sparks", label: "Stars" },
];

export function AutoModeDock({
  onHidePane,
}: {
  onShipToUnity: () => Promise<void>;
  onHidePane?: () => void;
}) {
  const {
    project,
    activeClip,
    autoArchetype,
    principles,
    physicsReport,
    parallax,
    activeVfx,
    mobileProfileScale,
    requestDocument,
    runOneClickAutoRig,
    runAutoModeSelectAction,
    updatePrinciples,
    setParallaxConfig,
    applyVoiceLipSync,
    setActiveVfx,
    setMobileProfileScale,
  } = useStudioNoTime();

  const [isShaded, setIsShaded] = useState(false);

  const categories = [
    "Famous Game Actions",
    "Pragmatic Win Ladder",
    "Slot Symbols & Chests",
    "Core & Tease",
  ] as const;

  const themeSymbols = getThemeSymbols(project.id);
  const mobileProfile = profileProjectForUnityMobile(project, mobileProfileScale);

  return (
    <aside
      className={`pointer-events-auto w-[320px] rounded-[var(--radius-panel)] liquid-glass flex flex-col overflow-hidden transition-all ${
        isShaded ? "shrink-0" : "flex-1 min-h-0"
      }`}
    >
      {/* 1. Header + Magic Wand Auto-Rig + Shade/Hide Controls */}
      <div className="p-3 border-b border-white/12 flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <span className="text-[11px] font-semibold text-[var(--label-2)] flex items-center gap-1">
            <span>Auto Rig</span>
          </span>
          <h2 className="text-xs font-bold text-white truncate">
            Physics and game actions
          </h2>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={runOneClickAutoRig}
            title="Run 1-Click Magic Wand Auto-Rig & Physics Inference"
            className="whitespace-nowrap px-2 py-1 rounded-full text-[10px] font-bold btn-primary"
          >
            Rig
          </button>
          <button
            onClick={() => setIsShaded(!isShaded)}
            title={isShaded ? "Expand Panel Body" : "Shade / Collapse Panel Body"}
            className="w-6 h-6 rounded-full liquid-glass-button text-[11px] font-bold text-slate-200 flex items-center justify-center"
          >
            {isShaded ? "▾" : "–"}
          </button>
          {onHidePane && (
            <button
              onClick={onHidePane}
              title="Hide Panel to Tool Rail"
              className="w-6 h-6 rounded-full liquid-glass-button text-[11px] font-bold text-slate-300 hover:text-white flex items-center justify-center"
            >
              «
            </button>
          )}
        </div>
      </div>

      {!isShaded && (
        <div className="flex-1 overflow-y-auto p-3 space-y-3.5 text-xs">
        {/* 2. Visual Physics Inference Card ("Learned by Looking at Object") */}
        <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="section-title">
              Visual Physics Learner
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-400/20 text-cyan-200 tabular-nums font-semibold uppercase">
              {physicsReport.inferredArchetype.replace("_", " ")}
            </span>
          </div>

          <select
            value={autoArchetype}
            onChange={(e) =>
              runAutoModeSelectAction(activeClip, e.target.value as AutoArchetypeId)
            }
            className="w-full bg-white/10 border border-white/20 rounded-xl px-2.5 py-1.5 text-xs text-white font-medium focus:outline-none"
          >
            {ARCHETYPE_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id} className="bg-slate-950 text-white">
                {opt.label}
              </option>
            ))}
          </select>

          <div className="grid grid-cols-3 gap-1.5 text-[10px] tabular-nums">
            <div className="p-1.5 rounded-xl bg-white/6 border border-white/10 text-center">
              <div className="text-slate-400">Mass</div>
              <div className="text-white font-bold">{physicsReport.estimatedMassKg} kg</div>
            </div>
            <div className="p-1.5 rounded-xl bg-white/6 border border-white/10 text-center">
              <div className="text-slate-400">Center of Mass</div>
              <div className="text-sky-300 font-bold">
                {physicsReport.centerOfMass[0]}, {physicsReport.centerOfMass[1]}
              </div>
            </div>
            <div className="p-1.5 rounded-xl bg-white/6 border border-white/10 text-center">
              <div className="text-slate-400">Gravity / Drag</div>
              <div className="text-amber-300 font-bold">
                {physicsReport.gravityScale}g · {physicsReport.airDrag}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1 pt-0.5">
            {physicsReport.partTelemetry.slice(0, 5).map((pt) => (
              <span
                key={pt.partName}
                className="text-[9.5px] px-2 py-0.5 rounded-full bg-white/8 border border-white/12 text-slate-300 tabular-nums"
              >
                {pt.partName}: <strong className="text-sky-200">{pt.material.replace("_", " ")}</strong> ({pt.stiffness}k)
              </span>
            ))}
          </div>
        </div>

        {/* 3. GPU Elemental VFX & 2.5D Parallax / Voice Lip-Sync Card */}
        <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="section-title">
              Elemental VFX & 2.5D Parallax
            </span>
            <label className="flex items-center gap-1.5 text-[10px] text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={parallax.enabled}
                onChange={(e) => setParallaxConfig({ enabled: e.target.checked })}
                
              />
              2.5D Turn
            </label>
          </div>

          <div className="grid grid-cols-3 gap-1">
            {VFX_OPTIONS.map((vfx) => (
              <button
                key={vfx.id}
                onClick={() => setActiveVfx(vfx.id)}
                className={`py-1 px-1.5 rounded-lg text-[10.5px] font-semibold transition ${
                  activeVfx === vfx.id
                    ? "liquid-glass-active"
                    : "bg-white/6 text-slate-300 hover:bg-white/12"
                }`}
              >
                {vfx.label}
              </button>
            ))}
          </div>

          {/* Voice Lip-Sync Triggers */}
          <div className="pt-1 space-y-1">
            <div className="text-[10px] text-slate-400 font-semibold">
              1-Click Voice Lip-Sync & Eye-Blink:
            </div>
            <div className="flex flex-wrap gap-1">
              {VOICE_PHRASE_PRESETS.map((vp) => (
                <button
                  key={vp.id}
                  onClick={() => applyVoiceLipSync(vp.id)}
                  className="px-2 py-0.5 rounded-full liquid-glass-button text-[9.5px] font-medium text-sky-200 hover:text-white"
                >
                  {vp.transcript}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 4. Batch 8-Symbol Pack Auto-Rigger (Switch between Hero & All 8 Slot Symbols) */}
        <div className="p-3 rounded-2xl liquid-glass-well space-y-2">
          <div className="flex items-center justify-between">
            <span className="section-title">
              Batch 8-Symbol Auto-Rigger
            </span>
            <button
              onClick={() => requestDocument(heroTemplate(project.id))}
              className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-200 font-semibold"
            >
              Load Hero Rig
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {themeSymbols.map((sym) => {
              const active = project.id.endsWith(`-${sym.role}`);
              return (
                <button
                  key={sym.role}
                  onClick={() => requestDocument({ kind: "symbol", id: sym.role, title: sym.label })}
                  title={`Auto-Rig & Animate ${sym.label}`}
                  className={`p-1.5 rounded-xl border flex flex-col items-center gap-0.5 transition ${
                    active
                      ? "bg-emerald-400/25 border-emerald-300 text-white"
                      : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={sym.src} alt={sym.label} className="w-8 h-8 object-contain" />
                  <span className="text-[9px] tabular-nums uppercase font-bold">{sym.role}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 5. 12 Principles of 2D Animation Live Dials */}
        <div className="p-3 rounded-2xl liquid-glass-well space-y-2">
          <div className="flex items-center justify-between">
            <span className="section-title">
              12 Principles of 2D Animation
            </span>
            <span className="text-[10px] tabular-nums text-slate-400">sx·sy=1.0</span>
          </div>

          <div className="grid grid-cols-2 gap-2.5 text-[10.5px]">
            <label className="space-y-0.5">
              <div className="flex justify-between text-slate-300">
                <span>Squash & Stretch</span>
                <span className="tabular-nums text-white">{Math.round(principles.squashAndStretch * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1.8"
                step="0.1"
                value={principles.squashAndStretch}
                onChange={(e) => updatePrinciples({ squashAndStretch: parseFloat(e.target.value) })}
                className="w-full"
              />
            </label>

            <label className="space-y-0.5">
              <div className="flex justify-between text-slate-300">
                <span>Anticipation</span>
                <span className="tabular-nums text-white">{Math.round(principles.anticipation * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.2"
                max="1.8"
                step="0.1"
                value={principles.anticipation}
                onChange={(e) => updatePrinciples({ anticipation: parseFloat(e.target.value) })}
                className="w-full"
              />
            </label>

            <label className="space-y-0.5">
              <div className="flex justify-between text-slate-300">
                <span>Overlap / Trail</span>
                <span className="tabular-nums text-white">{Math.round(principles.followThroughOverlap * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1.8"
                step="0.1"
                value={principles.followThroughOverlap}
                onChange={(e) => updatePrinciples({ followThroughOverlap: parseFloat(e.target.value) })}
                className="w-full"
              />
            </label>

            <label className="space-y-0.5">
              <div className="flex justify-between text-slate-300">
                <span>Exaggeration</span>
                <span className="tabular-nums text-white">{Math.round(principles.exaggeration * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="1.8"
                step="0.1"
                value={principles.exaggeration}
                onChange={(e) => updatePrinciples({ exaggeration: parseFloat(e.target.value) })}
                className="w-full"
              />
            </label>
          </div>
        </div>

        {/* 6. Unity Mobile VRAM / Overdraw / Draw-Call Profiler (@1x vs @0.5x) */}
        <div className="p-3 rounded-2xl liquid-glass-well space-y-2">
          <div className="flex items-center justify-between">
            <span className="section-title">
              Unity Mobile VRAM Profiler
            </span>
            <div className="flex gap-1">
              {([1, 0.5] as const).map((sc) => (
                <button
                  key={sc}
                  onClick={() => setMobileProfileScale(sc)}
                  className={`px-2 py-0.5 rounded-full text-[9.5px] tabular-nums font-bold ${
                    mobileProfileScale === sc
                      ? "bg-sky-400 text-slate-950"
                      : "bg-white/8 text-slate-300"
                  }`}
                >
                  @{sc}x
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-[10px] tabular-nums">
            <div className="p-1.5 rounded-xl bg-white/6 border border-white/10 text-center">
              <div className="text-slate-400">ASTC VRAM</div>
              <div className="text-emerald-300 font-bold">{mobileProfile.astcCompressedVramMB} MB</div>
            </div>
            <div className="p-1.5 rounded-xl bg-white/6 border border-white/10 text-center">
              <div className="text-slate-400">Overdraw</div>
              <div className="text-sky-300 font-bold">
                {mobileProfile.overdrawRatio}× (-{mobileProfile.contourOverdrawSavingsPct}%)
              </div>
            </div>
            <div className="p-1.5 rounded-xl bg-white/6 border border-white/10 text-center">
              <div className="text-slate-400">Draw Calls</div>
              <div className="text-amber-300 font-bold">{mobileProfile.batchedDrawCalls} Batch</div>
            </div>
          </div>
          <div className="text-[10px] text-emerald-300 tabular-nums text-center">
            Grade: {mobileProfile.performanceGrade}
          </div>
        </div>

        {/* 7. 14 Famous Slot & Game Actions (Click Any Action to Auto-Mesh, Auto-Rig, Animate & Play) */}
        <div className="space-y-3">
          {categories.map((cat) => {
            const items = FAMOUS_GAME_ACTIONS.filter((a) => a.category === cat);
            return (
              <div key={cat} className="space-y-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-1">
                  {cat} ({items.length})
                </div>
                <div className="space-y-1.5">
                  {items.map((act) => {
                    const isSelected = activeClip === act.id;
                    return (
                      <button
                        key={act.id}
                        onClick={() => runAutoModeSelectAction(act.id)}
                        className={`w-full text-left p-2.5 rounded-2xl border transition-all flex items-center justify-between gap-2 ${
                          isSelected
                            ? "bg-sky-500/22 border-sky-300/50 text-white shadow-[0_0_18px_rgba(56,189,248,0.25)]"
                            : "bg-white/5 border-white/10 text-slate-200 hover:bg-white/10"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="font-bold text-xs truncate flex items-center gap-1.5">
                            <span>{act.title}</span>
                          </div>
                          <div className="text-[10.5px] text-slate-400 truncate mt-0.5">
                            {act.subtitle}
                          </div>
                        </div>
                        <span
                          className={`whitespace-nowrap shrink-0 text-[9.5px] px-2 py-0.5 rounded-full tabular-nums font-bold ${
                            isSelected
                              ? "bg-sky-400 text-slate-950"
                              : "bg-white/10 text-sky-300"
                          }`}
                        >
                          {act.badge}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        </div>
      )}
    </aside>
  );
}
