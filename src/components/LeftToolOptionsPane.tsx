"use client";

import { useState } from "react";
import {
  EASE_BACK_OUT,
  EASE_POWER2_IN,
  EASE_POWER2_IN_OUT,
  EASE_SINE_IN_OUT,
  sampleTransformTrack,
} from "@/core/animator";
import { getThemeSymbols } from "@/core/batch-symbols";
import { VOICE_PHRASE_PRESETS } from "@/core/parallax-and-lipsync";
import { IMPORT_IMAGE_ACCEPT, importCharacterFile } from "@/core/import-character";
import { RIG_BONE_PALETTE, type CurveType, type SpineForgeProject } from "@/core/schema";
import { generateUnity2DColliders } from "@/core/vfx-colliders-profiler";
import type { AutoWeightMode, FfdLiquifyMode, WeightBrushMode } from "@/core/weights";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import { useReadoutTime, useStudioNoTime } from "@/store/useStudioStore";
import { AutoModeDock } from "./AutoModeDock";
import { BUILTIN_PROJECTS, heroTemplate } from "./ProjectsMenu";

const BEZIER_PRESETS: { id: string; label: string; curve: CurveType; svgPath: string }[] = [
  { id: "sine", label: "Smooth Sine", curve: EASE_SINE_IN_OUT, svgPath: "M 4 28 C 18 28, 26 4, 40 4" },
  { id: "easeInOut", label: "Power Ease", curve: EASE_POWER2_IN_OUT, svgPath: "M 4 28 C 22 28, 22 4, 40 4" },
  { id: "backOut", label: "Overshoot", curve: EASE_BACK_OUT, svgPath: "M 4 28 C 12 2, 26 0, 40 6" },
  { id: "powerIn", label: "Slam In", curve: EASE_POWER2_IN, svgPath: "M 4 28 C 26 28, 34 18, 40 4" },
  { id: "linear", label: "Linear", curve: "linear", svgPath: "M 4 28 L 40 4" },
  { id: "stepped", label: "Stepped", curve: "stepped", svgPath: "M 4 28 L 24 28 L 24 4 L 40 4" },
];

export type ExportBundlePreviewData = {
  id: string;
  atlasDataUrl: string;
  spriteSheetDataUrl: string;
  spineJson: string;
  spineAtlasTxt: string;
  unitySfRigJson: string;
  spriteSheetJson: string;
  zipBase64: string;
};

/** Reads the frame count from an exported sprite-sheet manifest without trusting its shape. */
function sheetFrameCount(json: string): number {
  try {
    const frames = (JSON.parse(json) as { frames?: unknown[] }).frames;
    return Array.isArray(frames) ? frames.length : 0;
  } catch {
    return 0;
  }
}

export function LeftToolOptionsPane({
  onImported,
  onShipToUnity,
  onHidePane,
  exportData,
  isExporting,
  onDownloadZip,
  onExportWebM,
  onUnityPreview,
  onOpenSymbol,
}: {
  /** Opens a freshly cut character (asking about unsaved work first); resolves to a status line. */
  onImported?: (project: SpineForgeProject) => Promise<string>;
  onShipToUnity: () => Promise<void>;
  onHidePane?: () => void;
  exportData?: ExportBundlePreviewData | null;
  isExporting?: boolean;
  onDownloadZip?: () => void;
  onExportWebM?: () => void;
  onUnityPreview?: () => void;
  onOpenSymbol?: (role: string, title: string) => void;
}) {
  const {
    project,
    mode,
    transformTool,
    selectedBone,
    selectedPart,
    activeClip,
    activeSkinName,
    brushMode,
    liquifyMode,
    brushRadius,
    brushStrength,
    heatmapSingleBone,
    lockedBones,
    showHeatmap,
    showCapsules,
    showHitboxes,
    enable3DRelight,
    lightAngleDeg,
    lightIntensity,
    parallax,
    requestDocument,
    setActiveSkin,
    selectBone,
    selectPart,
    updateBone,
    addBone,
    updateIkMix,
    regeneratePartMesh,
    resetPartLiquifyDeform,
    setBrushMode,
    setLiquifyMode,
    setBrushRadius,
    setBrushStrength,
    toggleOverlay,
    toggleBoneLock,
    setLightParams,
    setParallaxConfig,
    applyVoiceLipSync,
    setBoneKeyframeAtCurrentTime,
    setBoneCurveAtCurrentTime,
  } = useStudioNoTime();
  // Readouts follow the playhead a few times a second while playing, exactly when paused.
  const currentTime = useReadoutTime();

  // State for Import PSD / Smart Part Knife
  const [cutterStatus, setCutterStatus] = useState<string>("");
  const [cutterFailed, setCutterFailed] = useState(false);
  const [jointCoverRadius, setJointCoverRadius] = useState<number>(0.045);
  const [alphaThreshold, setAlphaThreshold] = useState<number>(8);
  const [inpaintTorso, setInpaintTorso] = useState<boolean>(true);

  // State for Mesh / Bone / Curve controls
  const [weightAlgo, setWeightAlgo] = useState<AutoWeightMode>("hybrid");
  const [newBoneName, setNewBoneName] = useState<string>("");
  const [activeCurveId, setActiveCurveId] = useState<string>("sine");
  const [isShaded, setIsShaded] = useState<boolean>(false);
  const [exportTab, setExportTab] = useState<"unity" | "spine" | "sheet">("unity");

  if (mode === "auto") {
    return <AutoModeDock onShipToUnity={onShipToUnity} onHidePane={onHidePane} />;
  }

  const currentBoneObj = project.bones.find((b) => b.name === selectedBone) ?? project.bones[0]!;
  const currentPartObj = project.parts.find((p) => p.name === selectedPart) ?? project.parts[0]!;
  const currentClipObj = project.animations[activeClip];
  const currentBonePoseAtTime = sampleTransformTrack(
    currentClipObj?.boneTracks[currentBoneObj?.name ?? "root"],
    currentTime,
  );
  const activeBezierPreset = BEZIER_PRESETS.find((b) => b.id === activeCurveId) ?? BEZIER_PRESETS[0]!;
  const themeSymbols = getThemeSymbols(project.id);

  const handleSmartCutUpload = async (file: File) => {
    setCutterFailed(false);
    setCutterStatus("Cutting layers and filling the body behind the limbs…");
    try {
      const project = await importCharacterFile(file, { alphaThreshold, jointCoverRadius, inpaintTorso });
      const found = `Cut ${project.parts.length} layers (${project.width}×${project.height}).`;
      setCutterStatus(onImported ? `${found} ${await onImported(project)}` : found);
    } catch (err) {
      setCutterFailed(true);
      setCutterStatus(err instanceof Error ? err.message : "Import failed");
    }
  };

  return (
    <aside
      className={`pointer-events-auto w-full rounded-[var(--radius-panel)] liquid-glass flex flex-col overflow-hidden transition-all ${
        isShaded ? "shrink-0" : "flex-1 min-h-0"
      }`}
    >
      {/* 1. PANE HEADER: Shows active Photoshop Tool + Shade (_) + Hide («) Controls */}
      <div className="p-3 border-b border-white/12 flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <span className="text-[11px] font-semibold text-[var(--label-2)] block truncate">
            {
              {
                import: "Import",
                animate: { pose: "Pose", rotate: "Rotate", translate: "Translate", scale: "Scale" }[transformTool],
                rig: "Bones & IK",
                mesh: "Mesh",
                weights: "Weight Paint",
                liquify: "Warp",
                export: "Export",
                auto: "Auto Rig",
              }[mode]
            }
          </span>
          <h2 className="text-xs font-bold text-white mt-0.5 truncate">
            {mode === "import" || mode === "export"
              ? project.title
              : mode === "mesh" || mode === "weights" || mode === "liquify"
                ? `Active Layer: ${currentPartObj.name}`
                : `Active Bone: ${currentBoneObj.name}`}
          </h2>
        </div>

        <div className="flex items-center gap-1 shrink-0">
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

      {/* 2. CONTEXTUAL TOOL OPTIONS BODY */}
      {!isShaded && (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5 text-xs">
        {/* =====================================================================
            MODE 0: IMPORT PSD & DOCUMENT SETUP PANE (Top Icon Above Auto)
           ===================================================================== */}
        {mode === "import" && (
          <>
            {/* Document Preset & Multi-Skin Tier Selector */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
              <span className="section-title">
                1. Active PSD Document & Skin Tier
              </span>
              <label className="block space-y-1">
                <span className="text-[10.5px] text-slate-400">Open document: {project.title}</span>
                <select
                  value=""
                  aria-label="Open a template"
                  onChange={(e) => {
                    const target = BUILTIN_PROJECTS.find((t) => t.id === e.target.value);
                    if (target) requestDocument(target);
                  }}
                  className="w-full bg-white/10 border border-white/20 rounded-xl px-2.5 py-1.5 text-xs text-white font-semibold focus:outline-none"
                >
                  <option value="" className="bg-slate-950 text-white">
                    Open a template…
                  </option>
                  {BUILTIN_PROJECTS.map((t) => (
                    <option key={t.id} value={t.id} className="bg-slate-950 text-white">
                      {t.title}
                    </option>
                  ))}
                </select>
              </label>

              {project.skins && project.skins.length > 0 && (
                <label className="block space-y-1">
                  <span className="text-[10.5px] text-slate-400">Multi-Skin / Evolving Symbol Wardrobe</span>
                  <select
                    value={activeSkinName}
                    onChange={(e) => setActiveSkin(e.target.value)}
                    className="w-full bg-white/10 border border-white/20 rounded-xl px-2.5 py-1.5 text-xs text-amber-200 font-semibold focus:outline-none"
                  >
                    {project.skins.map((s) => (
                      <option key={s.name} value={s.name} className="bg-slate-950 text-white">
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {/* Upload Layered .PSD or Flat .PNG / .WebP */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="section-title">
                  2. Import Photoshop .PSD or Cut PNG
                </span>
                <span className="text-[10px] tabular-nums text-slate-400">
                  {project.width}×{project.height}
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                A layered <code className="text-sky-300">.psd</code> keeps your layers and draw order (best). A flat{" "}
                <code className="text-sky-300">.png/.webp</code> is cut with a pose template: a front-facing hero with a weapon in the
                right hand. Either way the character opens auto-rigged.
              </p>
              <input
                type="file"
                accept={IMPORT_IMAGE_ACCEPT}
                aria-label="Import a PSD or PNG character"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleSmartCutUpload(f);
                }}
                className="block w-full text-[11px] text-slate-300 file:mr-2.5 file:py-1.5 file:px-3 file:rounded-full file:border-0 file:text-[11px] file:font-bold file:bg-sky-400 file:text-slate-950 cursor-pointer"
              />
              {cutterStatus && (
                <div
                  role="status"
                  className={`p-2.5 rounded-xl border text-[11px] leading-snug ${
                    cutterFailed ? "bg-[#ff453a]/12 border-[#ff453a]/35 text-[#ffb4ae]" : "bg-emerald-500/15 border-emerald-400/30 text-emerald-200"
                  }`}
                >
                  {cutterStatus}
                </div>
              )}
            </div>

            {onOpenSymbol && (
              <div className="p-3 rounded-2xl liquid-glass-well space-y-2">
                <span className="section-title">Symbol swap set</span>
                <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                  {themeSymbols.map((sym) => (
                    <button
                      key={sym.role}
                      type="button"
                      onClick={() => onOpenSymbol(sym.role, sym.label)}
                      className="shrink-0 w-14 flex flex-col items-center gap-1"
                      data-tip={sym.label}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={sym.src} alt="" className="h-10 w-10 object-contain rounded-lg bg-black/30 border border-white/10" />
                      <span className="text-[9px] text-[var(--label-3)] truncate w-full text-center">{sym.role}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Smart Part Cutter & Joint Cover Options */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
              <span className="section-title">
                3. Smart Part Knife & Inpaint Options
              </span>

              <label className="block space-y-1">
                <div className="flex justify-between text-[11px] text-slate-300">
                  <span>Joint Cover Ring Radius</span>
                  <span className="tabular-nums text-white">{Math.round(jointCoverRadius * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.01"
                  max="0.1"
                  step="0.005"
                  value={jointCoverRadius}
                  onChange={(e) => setJointCoverRadius(parseFloat(e.target.value))}
                  className="w-full"
                />
              </label>

              <label className="block space-y-1">
                <div className="flex justify-between text-[11px] text-slate-300">
                  <span>Alpha Trim Threshold</span>
                  <span className="tabular-nums text-white">{alphaThreshold} / 255</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="32"
                  step="1"
                  value={alphaThreshold}
                  onChange={(e) => setAlphaThreshold(parseInt(e.target.value, 10))}
                  className="w-full"
                />
              </label>

              <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={inpaintTorso}
                  onChange={(e) => setInpaintTorso(e.target.checked)}
                  
                />
                Inpaint Occluded Torso Behind Limbs (Telea)
              </label>
            </div>

            {/* Batch 8-Symbol Pack Switcher */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2">
              <div className="flex items-center justify-between">
                <span className="section-title">
                  4. Open Slot Symbol from Pack (8)
                </span>
                <button
                  onClick={() => requestDocument(heroTemplate(project.id))}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-200 font-semibold"
                >
                  Hero Rig
                </button>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {themeSymbols.map((sym) => (
                  <button
                    key={sym.role}
                    onClick={() => requestDocument({ kind: "symbol", id: sym.role, title: sym.label })}
                    className="p-1.5 rounded-xl bg-white/5 hover:bg-white/12 border border-white/10 flex flex-col items-center gap-0.5 transition"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={sym.src} alt={sym.label} className="w-8 h-8 object-contain" />
                    <span className="text-[9px] tabular-nums uppercase font-bold text-slate-200">{sym.role}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* =====================================================================
            MODE 1: POSE TOOLS (B C V X) OPTIONS PANE
           ===================================================================== */}
        {mode === "animate" && (
          <>
            {/* Active Bone Numeric Transform */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="section-title">
                  Free Transform ({currentBoneObj.name})
                </span>
                <button
                  onClick={() =>
                    setBoneKeyframeAtCurrentTime(currentBoneObj.name, {
                      r: currentBonePoseAtTime.r,
                      x: currentBonePoseAtTime.x,
                      y: currentBonePoseAtTime.y,
                      sx: currentBonePoseAtTime.sx,
                      sy: currentBonePoseAtTime.sy,
                      curve: activeBezierPreset.curve,
                    })
                  }
                  className="px-2.5 py-0.5 rounded-full bg-purple-500/25 border border-purple-400/40 text-purple-200 text-[10.5px] font-bold"
                >
                  + Keyframe ({currentTime.toFixed(2)}s)
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="space-y-1">
                  <span className="text-[10px] text-slate-400">Angle °</span>
                  <input
                    type="number"
                    step="1"
                    value={Number(currentBonePoseAtTime.r.toFixed(1))}
                    onChange={(e) =>
                      setBoneKeyframeAtCurrentTime(currentBoneObj.name, {
                        ...currentBonePoseAtTime,
                        r: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-slate-400">ΔX (px)</span>
                  <input
                    type="number"
                    step="1"
                    value={Number(currentBonePoseAtTime.x.toFixed(1))}
                    onChange={(e) =>
                      setBoneKeyframeAtCurrentTime(currentBoneObj.name, {
                        ...currentBonePoseAtTime,
                        x: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-slate-400">ΔY (px)</span>
                  <input
                    type="number"
                    step="1"
                    value={Number(currentBonePoseAtTime.y.toFixed(1))}
                    onChange={(e) =>
                      setBoneKeyframeAtCurrentTime(currentBoneObj.name, {
                        ...currentBonePoseAtTime,
                        y: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <label className="space-y-1">
                  <span className="text-[10px] text-slate-400">Scale X</span>
                  <input
                    type="number"
                    step="0.02"
                    value={Number(currentBonePoseAtTime.sx.toFixed(3))}
                    onChange={(e) =>
                      setBoneKeyframeAtCurrentTime(currentBoneObj.name, {
                        ...currentBonePoseAtTime,
                        sx: parseFloat(e.target.value) || 1,
                      })
                    }
                    className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-slate-400">Scale Y</span>
                  <input
                    type="number"
                    step="0.02"
                    value={Number(currentBonePoseAtTime.sy.toFixed(3))}
                    onChange={(e) =>
                      setBoneKeyframeAtCurrentTime(currentBoneObj.name, {
                        ...currentBonePoseAtTime,
                        sy: parseFloat(e.target.value) || 1,
                      })
                    }
                    className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                  />
                </label>
              </div>
            </div>

            {/* Visual Cubic Bezier Curve Graph Editor */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="section-title">Bezier Easing Curve</span>
                <svg width="48" height="32" viewBox="0 0 44 32" className="rounded bg-black/40 border border-white/10">
                  <path
                    d={activeBezierPreset.svgPath}
                    fill="none"
                    stroke="#38bdf8"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {BEZIER_PRESETS.map((bp) => (
                  <button
                    key={bp.id}
                    onClick={() => {
                      setActiveCurveId(bp.id);
                      setBoneCurveAtCurrentTime(currentBoneObj.name, bp.curve);
                    }}
                    className={`py-1.5 px-2 rounded-xl text-[10.5px] font-semibold truncate transition ${
                      activeCurveId === bp.id
                        ? "bg-sky-400 text-slate-950 font-bold"
                        : "bg-white/6 text-slate-300 hover:bg-white/12"
                    }`}
                  >
                    {bp.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 2.5D Parallax Look-At & Voice Lip-Sync */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="section-title">2.5D Parallax & Lip-Sync</span>
                <label className="flex items-center gap-1.5 text-[10.5px] text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={parallax.enabled}
                    onChange={(e) => setParallaxConfig({ enabled: e.target.checked })}
                    
                  />
                  Enable 2.5D Turn
                </label>
              </div>

              <label className="block space-y-1">
                <div className="flex justify-between text-[10.5px] text-slate-300">
                  <span>Parallax Depth Intensity</span>
                  <span className="tabular-nums text-white">{Math.round(parallax.depthIntensity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={parallax.depthIntensity}
                  onChange={(e) => setParallaxConfig({ depthIntensity: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </label>

              <div className="space-y-1 pt-1">
                <span className="text-[10px] text-slate-400 block">Voice Lip-Sync Generators:</span>
                <div className="flex flex-wrap gap-1">
                  {VOICE_PHRASE_PRESETS.map((vp) => (
                    <button
                      key={vp.id}
                      onClick={() => applyVoiceLipSync(vp.id)}
                      className="px-2 py-0.5 rounded-full liquid-glass-button text-[9.5px] text-sky-200 hover:text-white"
                    >
                      {vp.transcript}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 3D Normal-Map Point Relighting */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2">
              <div className="flex items-center justify-between">
                <span className="section-title">3D Normal Point Light</span>
                <input
                  type="checkbox"
                  checked={enable3DRelight}
                  onChange={() => toggleOverlay("enable3DRelight")}
                  
                />
              </div>
              <label className="block space-y-0.5">
                <div className="flex justify-between text-[10.5px] text-slate-300">
                  <span>Light Direction Angle</span>
                  <span className="tabular-nums text-white">{lightAngleDeg}°</span>
                </div>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  value={lightAngleDeg}
                  onChange={(e) => setLightParams(parseFloat(e.target.value), lightIntensity)}
                  className="w-full"
                />
              </label>
              <label className="block space-y-0.5">
                <div className="flex justify-between text-[10.5px] text-slate-300">
                  <span>Light Intensity</span>
                  <span className="tabular-nums text-white">{Math.round(lightIntensity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={lightIntensity}
                  onChange={(e) => setLightParams(lightAngleDeg, parseFloat(e.target.value))}
                  className="w-full"
                />
              </label>
            </div>
          </>
        )}

        {/* =====================================================================
            MODE 2: BONES & IK (N) OPTIONS PANE
           ===================================================================== */}
        {mode === "rig" && (
          <>
            {/* Bind Pivot Coordinates & Length */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="section-title">
                  Bind Pivot ({currentBoneObj.name})
                </span>
                <span className="text-[10px] tabular-nums text-slate-400">
                  Parent: {currentBoneObj.parent ?? "None (Root)"}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="space-y-1">
                  <span className="text-[10px] text-slate-400">Pivot X</span>
                  <input
                    type="number"
                    step="0.005"
                    value={currentBoneObj.x}
                    onChange={(e) => updateBone(currentBoneObj.name, { x: parseFloat(e.target.value) || 0 })}
                    className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-slate-400">Pivot Y</span>
                  <input
                    type="number"
                    step="0.005"
                    value={currentBoneObj.y}
                    onChange={(e) => updateBone(currentBoneObj.name, { y: parseFloat(e.target.value) || 0 })}
                    className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-slate-400">Length</span>
                  <input
                    type="number"
                    step="0.01"
                    value={currentBoneObj.length ?? 0.08}
                    onChange={(e) => updateBone(currentBoneObj.name, { length: parseFloat(e.target.value) || 0.08 })}
                    className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                  />
                </label>
              </div>

              {/* Add Child Bone */}
              <div className="pt-2 border-t border-white/10 flex gap-1.5">
                <input
                  type="text"
                  placeholder={`New child bone under ${currentBoneObj.name}...`}
                  value={newBoneName}
                  onChange={(e) => setNewBoneName(e.target.value)}
                  className="flex-1 min-w-0 liquid-glass-well rounded-full px-3 py-1 text-xs text-white focus:outline-none"
                />
                <button
                  onClick={() => {
                    if (!newBoneName.trim()) return;
                    addBone(
                      currentBoneObj.name,
                      newBoneName,
                      Math.min(0.95, currentBoneObj.x + 0.05),
                      Math.max(0.05, currentBoneObj.y - 0.08),
                    );
                    setNewBoneName("");
                  }}
                  className="whitespace-nowrap px-3 py-1 rounded-full liquid-glass-button text-xs font-bold text-sky-200"
                >
                  + Bone
                </button>
              </div>
            </div>

            {/* 2-Bone Analytical IK Constraints */}
            {project.ikConstraints.length > 0 && (
              <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
                <span className="section-title">
                  2-Bone Analytical IK Pins
                </span>
                {project.ikConstraints.map((ik) => (
                  <div key={ik.name} className="space-y-1.5">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-slate-200 font-semibold">{ik.name}</span>
                      <span className="tabular-nums text-sky-300">Mix: {Math.round(ik.mix * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={ik.mix}
                      onChange={(e) => updateIkMix(ik.name, parseFloat(e.target.value))}
                      className="w-full"
                    />
                    <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={ik.bendPositive}
                        onChange={(e) => updateIkMix(ik.name, ik.mix, e.target.checked)}
                        
                      />
                      Clockwise Elbow / Knee Bend Direction
                    </label>
                  </div>
                ))}
              </div>
            )}

            {/* Secondary Spring Physics */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="section-title">
                  Spring Secondary Physics ({currentBoneObj.name})
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(currentBoneObj.spring)}
                  onChange={(e) =>
                    updateBone(currentBoneObj.name, {
                      spring: e.target.checked
                        ? { stiffness: 60, damping: 7, gain: [7, 3], wind: 1.4 }
                        : undefined,
                    })
                  }
                  
                />
              </div>
              {currentBoneObj.spring && (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <label className="space-y-1">
                    <span className="text-slate-400">Stiffness</span>
                    <input
                      type="number"
                      value={currentBoneObj.spring.stiffness}
                      onChange={(e) =>
                        updateBone(currentBoneObj.name, {
                          spring: { ...currentBoneObj.spring!, stiffness: parseFloat(e.target.value) || 50 },
                        })
                      }
                      className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-400">Damping</span>
                    <input
                      type="number"
                      value={currentBoneObj.spring.damping}
                      onChange={(e) =>
                        updateBone(currentBoneObj.name, {
                          spring: { ...currentBoneObj.spring!, damping: parseFloat(e.target.value) || 6 },
                        })
                      }
                      className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-400">Wind °</span>
                    <input
                      type="number"
                      step="0.2"
                      value={currentBoneObj.spring.wind ?? 0}
                      onChange={(e) =>
                        updateBone(currentBoneObj.name, {
                          spring: { ...currentBoneObj.spring!, wind: parseFloat(e.target.value) || 0 },
                        })
                      }
                      className="w-full bg-white/8 border border-white/15 rounded-xl px-2 py-1 tabular-nums text-white"
                    />
                  </label>
                </div>
              )}

              <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={showCapsules}
                  onChange={() => toggleOverlay("showCapsules")}
                  
                />
                Show Capsule Weight Envelopes on Canvas
              </label>
            </div>
          </>
        )}

        {/* =====================================================================
            MODE 3: PUPPET WARP DELAUNAY MESH TOOL (M) OPTIONS PANE
           ===================================================================== */}
        {mode === "mesh" && (
          <>
            <div className="p-3 rounded-2xl liquid-glass-well space-y-3">
              <div className="flex items-center justify-between">
                <span className="section-title">
                  Delaunay Contour Mesher
                </span>
                <span className="text-[10px] tabular-nums text-emerald-300">
                  {currentPartObj.mesh ? currentPartObj.mesh.positions.length / 2 : 4}v ·{" "}
                  {currentPartObj.mesh ? currentPartObj.mesh.indices.length / 3 : 2}t
                </span>
              </div>

              {/* Layer Selector */}
              <label className="block space-y-1">
                <span className="text-[10.5px] text-slate-400">Target Layer</span>
                <select
                  value={currentPartObj.name}
                  onChange={(e) => selectPart(e.target.value)}
                  className="w-full bg-white/10 border border-white/20 rounded-xl px-2.5 py-1.5 text-xs text-white font-semibold focus:outline-none"
                >
                  {project.parts.map((p) => (
                    <option key={p.name} value={p.name} className="bg-slate-950 text-white">
                      {p.name} ({p.skin && p.skin.length > 1 ? `Skinned: ${p.skin.length} bones` : `Rigid: ${p.bone}`})
                    </option>
                  ))}
                </select>
              </label>

              {/* Density Selector */}
              <div className="space-y-1">
                <span className="text-[10.5px] text-slate-400 block">Triangle Mesh Density</span>
                <div className="grid grid-cols-3 gap-1.5 p-1 rounded-full bg-black/30">
                  {(["low", "medium", "high"] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => regeneratePartMesh(currentPartObj.name, d, weightAlgo)}
                      className={`py-1.5 rounded-full text-[11px] font-bold capitalize transition ${
                        (currentPartObj.meshDensity ?? "medium") === d
                          ? "liquid-glass-active"
                          : "text-slate-300 hover:text-white"
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* Auto-Weight Solver Kernel */}
              <label className="block space-y-1">
                <span className="text-[10.5px] text-slate-400">Auto-Weight Solver Kernel</span>
                <select
                  value={weightAlgo}
                  onChange={(e) => {
                    const nextAlgo = e.target.value as AutoWeightMode;
                    setWeightAlgo(nextAlgo);
                    regeneratePartMesh(
                      currentPartObj.name,
                      currentPartObj.meshDensity ?? usePreferencesStore.getState().meshDensityDefault,
                      nextAlgo,
                    );
                  }}
                  className="w-full bg-white/10 border border-white/20 rounded-xl px-2.5 py-1.5 text-xs text-sky-200 font-semibold focus:outline-none"
                >
                  <option value="hybrid" className="bg-slate-950">Hybrid Capsule + Bone Segment</option>
                  <option value="heat" className="bg-slate-950">Geodesic Inverse-Distance Heat</option>
                  <option value="capsule" className="bg-slate-950">Strict Capsule Envelopes</option>
                </select>
              </label>

              <button
                onClick={() => regeneratePartMesh(currentPartObj.name, currentPartObj.meshDensity ?? "high", weightAlgo)}
                className="w-full py-2 rounded-full liquid-glass-active text-xs font-bold"
              >
                Re-Tessellate & Solve 4-Bone Weights
              </button>
            </div>

            {/* Rigid vs Skinned Binding Mode */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2">
              <span className="section-title">
                Layer Binding Mode ({currentPartObj.name})
              </span>
              <div className="flex items-center justify-between text-[11px] text-slate-300">
                <span>Hull Vertices:</span>
                <span className="tabular-nums text-white">{currentPartObj.mesh?.hullCount ?? 4}</span>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={showHitboxes}
                  onChange={() => toggleOverlay("showHitboxes")}
                  
                />
                Show Unity PolygonCollider2D Hitboxes ({generateUnity2DColliders(project).length})
              </label>
            </div>
          </>
        )}

        {/* =====================================================================
            MODE 4: WEIGHT PAINT (⇧W) OPTIONS PANE
           ===================================================================== */}
        {mode === "weights" && (
          <>
            <div className="p-3 rounded-2xl liquid-glass-well space-y-3">
              <div className="flex items-center justify-between">
                <span className="section-title">
                  Weight Paint Brush (⇧W)
                </span>
                <button
                  onClick={() => toggleOverlay("heatmapSingleBone")}
                  className="text-[10px] px-2.5 py-0.5 rounded-full liquid-glass-button text-sky-200 font-semibold"
                >
                  {heatmapSingleBone ? "Thermal (Single Bone)" : "Multi-Bone Colors"}
                </button>
              </div>

              <div className="grid grid-cols-4 gap-1 p-1 rounded-full bg-black/30">
                {(["add", "subtract", "smooth", "replace"] as WeightBrushMode[]).map((bm) => (
                  <button
                    key={bm}
                    onClick={() => setBrushMode(bm)}
                    className={`py-1.5 rounded-full text-[11px] font-bold capitalize transition ${
                      brushMode === bm ? "liquid-glass-active" : "text-slate-300 hover:text-white"
                    }`}
                  >
                    {bm}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { label: "Soft", mode: "smooth" as WeightBrushMode, strength: 0.35, radius: 90 },
                    { label: "Hard", mode: "replace" as WeightBrushMode, strength: 0.95, radius: 40 },
                    { label: "Weapon", mode: "add" as WeightBrushMode, strength: 0.8, radius: 55 },
                  ] as const
                ).map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      setBrushMode(p.mode);
                      setBrushStrength(p.strength);
                      setBrushRadius(p.radius);
                      if (p.label === "Weapon") {
                        const weapon = project.bones.find((b) => /weapon|hammer|staff|sword/i.test(b.name));
                        if (weapon) selectBone(weapon.name);
                      }
                    }}
                    className="py-1.5 rounded-full text-[11px] font-bold liquid-glass-button"
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <label className="block space-y-1">
                <div className="flex justify-between text-[11px] text-slate-300">
                  <span>Brush Radius ([ / ])</span>
                  <span className="tabular-nums text-white">{brushRadius} px</span>
                </div>
                <input
                  type="range"
                  min="15"
                  max="180"
                  value={brushRadius}
                  onChange={(e) => setBrushRadius(parseFloat(e.target.value))}
                  className="w-full"
                />
              </label>

              <label className="block space-y-1">
                <div className="flex justify-between text-[11px] text-slate-300">
                  <span>Brush Strength / Flow</span>
                  <span className="tabular-nums text-white">{Math.round(brushStrength * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={brushStrength}
                  onChange={(e) => setBrushStrength(parseFloat(e.target.value))}
                  className="w-full"
                />
              </label>

              <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showHeatmap}
                  onChange={() => toggleOverlay("showHeatmap")}
                  
                />
                Show Live GPU Weight Heatmap Overlay
              </label>
            </div>

            {/* Target Bone Influence & Lock List */}
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2">
              <span className="section-title">
                Active Influence Bone & Locks
              </span>
              <div className="max-h-48 overflow-y-auto space-y-1 pr-0.5">
                {project.bones.map((bone, idx) => {
                  const isSel = bone.name === selectedBone;
                  const isLocked = lockedBones.includes(bone.name);
                  const col = bone.color ?? RIG_BONE_PALETTE[idx % RIG_BONE_PALETTE.length];
                  return (
                    <div
                      key={bone.name}
                      onClick={() => selectBone(bone.name)}
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded-xl cursor-pointer transition ${
                        isSel ? "bg-white/18 text-white font-semibold" : "hover:bg-white/8 text-slate-300"
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: col }} />
                        <span className="truncate">{bone.name}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleBoneLock(bone.name);
                        }}
                        className={`text-[9.5px] px-2 py-0.5 rounded-full font-semibold ${
                          isLocked ? "bg-rose-500/30 text-rose-200" : "bg-white/8 text-slate-400"
                        }`}
                      >
                        {isLocked ? "Locked" : "Free"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* =====================================================================
            MODE 5: WARP (⇧L) OPTIONS PANE
           ===================================================================== */}
        {mode === "liquify" && (
          <>
            <div className="p-3 rounded-2xl liquid-glass-well space-y-3">
              <div className="flex items-center justify-between">
                <span className="section-title">
                  Warp Sculpt Tool (⇧L)
                </span>
                <span className="text-[10px] tabular-nums text-slate-400">
                  @{currentTime.toFixed(2)}s
                </span>
              </div>

              <div className="grid grid-cols-4 gap-1 p-1 rounded-full bg-black/30">
                {(["push", "inflate", "pinch", "restore"] as FfdLiquifyMode[]).map((lm) => (
                  <button
                    key={lm}
                    onClick={() => setLiquifyMode(lm)}
                    className={`py-1.5 rounded-full text-[11px] font-bold capitalize transition ${
                      liquifyMode === lm ? "liquid-glass-active" : "text-slate-300 hover:text-white"
                    }`}
                  >
                    {lm}
                  </button>
                ))}
              </div>

              <label className="block space-y-1">
                <div className="flex justify-between text-[11px] text-slate-300">
                  <span>Warp Brush Radius ([ / ])</span>
                  <span className="tabular-nums text-white">{brushRadius} px</span>
                </div>
                <input
                  type="range"
                  min="15"
                  max="180"
                  value={brushRadius}
                  onChange={(e) => setBrushRadius(parseFloat(e.target.value))}
                  className="w-full"
                />
              </label>

              <label className="block space-y-1">
                <div className="flex justify-between text-[11px] text-slate-300">
                  <span>Warp Pressure</span>
                  <span className="tabular-nums text-white">{Math.round(brushStrength * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={brushStrength}
                  onChange={(e) => setBrushStrength(parseFloat(e.target.value))}
                  className="w-full"
                />
              </label>

              <button
                onClick={() => resetPartLiquifyDeform(currentPartObj.name)}
                className="w-full py-2 rounded-full bg-rose-500/20 border border-rose-400/40 text-rose-200 font-bold text-xs hover:bg-rose-500/30 transition"
              >
                Reset All FFD Offsets on &apos;{currentPartObj.name}&apos;
              </button>
            </div>
          </>
        )}

        {/* =====================================================================
            MODE 6: EXPORT (⌘E) PANE
           ===================================================================== */}
        {mode === "export" && (
          <>
            <div className="p-3 rounded-2xl liquid-glass-well space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="section-title">Spine 4.2 · Unity · Sprite sheet</span>
                <span className="text-[10px] tabular-nums text-sky-300">
                  {Object.keys(project.animations).length} Clips
                </span>
              </div>

              <button
                onClick={() => void onShipToUnity()}
                disabled={isExporting}
                className={`w-full py-2 rounded-full text-xs font-semibold disabled:opacity-50 ${exportData ? "liquid-glass-button text-[var(--label)]" : "btn-primary"}`}
              >
                {isExporting ? "Building…" : exportData ? "Rebuild Bundle" : "Build Bundle"}
              </button>

              {exportData && (
                <div className="grid grid-cols-2 gap-1.5 pt-1">
                  <button
                    onClick={onDownloadZip}
                    className="py-1.5 px-2.5 rounded-full btn-primary text-[11px]"
                  >
                    Download .zip
                  </button>
                  <button
                    onClick={onExportWebM}
                    className="py-1.5 px-2.5 rounded-full liquid-glass-button text-[var(--label)] text-[11px] font-semibold"
                  >
                    Record .webm
                  </button>
                  {onUnityPreview && (
                    <button
                      onClick={onUnityPreview}
                      className="col-span-2 py-1.5 px-2.5 rounded-full liquid-glass-button text-[var(--label)] text-[11px] font-semibold"
                    >
                      Unity sheet preview
                    </button>
                  )}
                </div>
              )}
            </div>

            {exportData && (
              <div className="p-3 rounded-2xl liquid-glass-well space-y-1.5">
                <span className="section-title">Atlas packing</span>
                <p className="text-[11px] text-[var(--label-2)] leading-snug">
                  MaxRects page · {Math.round((exportData.atlasDataUrl.length * 0.75) / 1024)} KB data URL
                  {exportData.spineAtlasTxt ? ` · ${exportData.spineAtlasTxt.split("\n").filter((l) => l.trim()).length} atlas lines` : ""}
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={exportData.atlasDataUrl} alt="" className="max-h-28 object-contain rounded-lg border border-white/10 mx-auto" />
              </div>
            )}

            {exportData && (
              <>
                <div className="grid grid-cols-3 gap-1 p-1 rounded-full bg-black/30">
                  {(
                    [
                      { id: "unity", label: "Unity .sfrig" },
                      { id: "spine", label: "Spine 4.2" },
                      { id: "sheet", label: "Flipbook" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setExportTab(t.id)}
                      className={`py-1 rounded-full text-[10.5px] font-bold transition ${
                        exportTab === t.id ? "liquid-glass-active" : "text-slate-300 hover:text-white"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="p-3 rounded-2xl liquid-glass-well flex flex-col items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={exportTab === "sheet" ? exportData.spriteSheetDataUrl : exportData.atlasDataUrl}
                    alt="Exported Atlas"
                    className="max-h-44 object-contain rounded-xl border border-white/10"
                  />
                  <span className="text-[10px] tabular-nums text-slate-400">
                    {exportTab === "sheet"
                      ? `${project.id}-sheet.png (${sheetFrameCount(exportData.spriteSheetJson)} frames)`
                      : `${project.id}.png (MaxRects Atlas)`}
                  </span>
                </div>

                <div className="p-2.5 rounded-2xl liquid-glass-well">
                  <pre className="max-h-44 overflow-auto text-[10px] font-mono text-cyan-200">
                    {exportTab === "unity"
                      ? exportData.unitySfRigJson.slice(0, 2400)
                      : exportTab === "spine"
                        ? `// ${project.id}.atlas.txt\n${exportData.spineAtlasTxt}\n// ${project.id}.json\n${exportData.spineJson.slice(0, 1800)}`
                        : exportData.spriteSheetJson.slice(0, 2400)}
                  </pre>
                </div>
              </>
            )}
          </>
        )}
        </div>
      )}
    </aside>
  );
}
