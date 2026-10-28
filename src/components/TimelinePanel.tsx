"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { EASE_BACK_OUT, EASE_POWER2_IN, EASE_POWER2_OUT, EASE_SINE_IN_OUT, sampleTransformTrack } from "@/core/animator";
import {
  CHANNELS,
  channelRange,
  channelValue,
  deleteKeyAt,
  moveKey,
  rippleMoveKey,
  setKeyChannel,
  setKeyCurve,
  snapTime,
  type Channel,
} from "@/core/keyframes";
import { RIG_BONE_PALETTE, type AnimationClip, type CurveType, type TransformKey } from "@/core/schema";
import { useReadoutTime, useStudioNoTime, useStudioStore } from "@/store/useStudioStore";

export type TimelineView = "keys" | "curves";
type KeyRef = { bone: string; index: number };
type Bezier = [number, number, number, number];

const CURVE_PRESETS: { label: string; curve: CurveType }[] = [
  { label: "Linear", curve: "linear" },
  { label: "Ease", curve: EASE_SINE_IN_OUT },
  { label: "Ease Out", curve: EASE_POWER2_OUT },
  { label: "Ease In", curve: EASE_POWER2_IN },
  { label: "Overshoot", curve: EASE_BACK_OUT },
  { label: "Stepped", curve: "stepped" },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLInputElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes(el.type);
};

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

/* ── Timeline panel: header + dope sheet or graph editor ───────────────────────────────────── */

export function TimelinePanel({ view, onViewChange }: { view: TimelineView; onViewChange: (v: TimelineView) => void }) {
  const { project, activeClip, selectedBone, editActiveClip, insertBreakdown, copyPose, pastePose, poseClipboard } = useStudioNoTime();
  const clip = project.animations[activeClip];
  const [selected, setSelected] = useState<KeyRef | null>(null);
  const [fraction, setFraction] = useState(0.5);

  useEffect(() => setSelected(null), [activeClip]);

  // Delete removes the selected key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected || isTyping(e) || (e.key !== "Backspace" && e.key !== "Delete")) return;
      e.preventDefault();
      editActiveClip(
        (c) => ({ ...c, boneTracks: { ...c.boneTracks, [selected.bone]: deleteKeyAt(c.boneTracks[selected.bone] ?? [], selected.index) } }),
        `Deleted key on ${selected.bone}`,
      );
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, editActiveClip]);

  if (!clip) return null;

  return (
    <div className="flex-1 min-h-0 flex flex-col border-t border-[var(--separator)]">
      <div className="h-10 px-3 flex items-center gap-3 shrink-0 text-[12px]">
        <div className="segmented w-36" role="tablist" aria-label="Timeline view">
          <button role="tab" aria-pressed={view === "keys"} onClick={() => onViewChange("keys")} data-tip="Dope sheet  T" data-tip-side="top">
            Keys
          </button>
          <button role="tab" aria-pressed={view === "curves"} onClick={() => onViewChange("curves")} data-tip="Graph editor  G" data-tip-side="top">
            Curves
          </button>
        </div>

        <span className="w-px h-5 bg-[var(--separator-strong)]" />

        <label className="flex items-center gap-2" data-tip="Key every bone between its neighbouring poses. ⇧-click: selected bone only" data-tip-side="top">
          <span className="text-[var(--label-2)]">Breakdown</span>
          <input
            type="range"
            min={-0.25}
            max={1.25}
            step={0.05}
            value={fraction}
            onChange={(e) => setFraction(parseFloat(e.target.value))}
            onDoubleClick={() => setFraction(0.5)}
            className="w-28"
            aria-label="Breakdown position"
          />
          <span className="tabular-nums w-9 text-right">{Math.round(fraction * 100)}%</span>
        </label>
        <button
          className="liquid-glass-button h-7 px-2.5 rounded-[6px] font-medium"
          onClick={(e) => insertBreakdown(fraction, e.shiftKey && selectedBone ? [selectedBone] : undefined)}
        >
          Key
        </button>

        <span className="w-px h-5 bg-[var(--separator-strong)]" />

        <button className="liquid-glass-button h-7 px-2.5 rounded-[6px] font-medium" onClick={copyPose} data-tip="Copy pose  ⌘C" data-tip-side="top">
          Copy Pose
        </button>
        <button
          className="liquid-glass-button h-7 px-2.5 rounded-[6px] font-medium disabled:opacity-40"
          onClick={pastePose}
          disabled={!poseClipboard}
          data-tip="Paste pose at playhead  ⌘V"
          data-tip-side="top"
        >
          Paste Pose
        </button>

        <div className="flex-1" />
        <ClipTiming clip={clip} />
      </div>

      {view === "keys" ? (
        <DopeSheet clip={clip} selected={selected} onSelect={setSelected} />
      ) : (
        <GraphEditor clip={clip} selected={selected} onSelect={setSelected} />
      )}
    </div>
  );
}

/* ── Clip timing (length, frame rate, loop) ────────────────────────────────────────────────── */

function ClipTiming({ clip }: { clip: AnimationClip }) {
  const setClipTiming = useStudioStore((s) => s.setClipTiming);
  const [draft, setDraft] = useState(clip.duration.toFixed(2));
  const [stretch, setStretch] = useState(true);
  useEffect(() => setDraft(clip.duration.toFixed(2)), [clip.duration, clip.name]);

  const commit = () => {
    const d = parseFloat(draft);
    if (Number.isFinite(d) && d > 0) setClipTiming({ duration: d, stretch });
    else setDraft(clip.duration.toFixed(2));
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-[var(--label-2)]">Length</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        className="w-14 h-7 rounded-[6px] bg-[var(--fill-3)] border border-[var(--separator)] px-2 tabular-nums text-right focus:outline-none focus:border-[var(--accent)]"
        aria-label="Clip length in seconds"
      />
      <span className="text-[var(--label-3)]">s</span>
      <label className="flex items-center gap-1.5 text-[var(--label-2)]" data-tip="Scale keys and events with the new length" data-tip-side="top">
        <input type="checkbox" checked={stretch} onChange={(e) => setStretch(e.target.checked)} />
        Stretch
      </label>
      <select
        value={clip.fps}
        onChange={(e) => setClipTiming({ fps: parseInt(e.target.value, 10) })}
        className="h-7 rounded-[6px] bg-[var(--fill-3)] border border-[var(--separator)] px-1.5"
        aria-label="Frame rate"
      >
        {[24, 30, 60].map((f) => (
          <option key={f} value={f}>
            {f} fps
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5 text-[var(--label-2)]">
        <input type="checkbox" checked={clip.loop} onChange={(e) => setClipTiming({ loop: e.target.checked })} />
        Loop
      </label>
    </div>
  );
}

/* ── Playheads: the only timeline parts that redraw every frame during playback ─────────────── */

function RowPlayhead({ duration }: { duration: number }) {
  const t = useStudioStore((s) => s.currentTime);
  return <div className="absolute top-0 bottom-0 w-px bg-[var(--accent)] pointer-events-none" style={{ left: `${Math.min(100, (t / duration) * 100)}%` }} />;
}

function GraphPlayhead({ x, y1, y2 }: { x: (t: number) => number; y1: number; y2: number }) {
  const t = useStudioStore((s) => s.currentTime);
  return <line x1={x(t)} x2={x(t)} y1={y1} y2={y2} stroke="#0a84ff" strokeWidth={1.5} pointerEvents="none" />;
}

/* ── Dope sheet: click to select, drag to retime (frame-snapped), ⌥-click to delete ─────────── */

function DopeSheet({ clip, selected, onSelect }: { clip: AnimationClip; selected: KeyRef | null; onSelect: (k: KeyRef | null) => void }) {
  const { project, selectedBone, selectBone, setCurrentTime, setIsPlaying, editActiveClip, commitPreview, deleteBoneKeyframe } = useStudioNoTime();
  const duration = clip.duration;
  const fps = clip.fps || 30;

  const scrub = (e: ReactPointerEvent<HTMLDivElement>, bone: string) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setIsPlaying(false);
    const t = ((e.clientX - rect.left) / rect.width) * duration;
    setCurrentTime(e.shiftKey ? Math.max(0, Math.min(duration, t)) : snapTime(t, fps, duration));
    selectBone(bone);
    onSelect(null);
  };

  const events = clip.events ?? [];
  const deleteAnimationEvent = useStudioStore((s) => s.deleteAnimationEvent);
  const addAnimationEventAtCurrentTime = useStudioStore((s) => s.addAnimationEventAtCurrentTime);

  return (
    <div className="flex-1 overflow-y-auto px-3 pb-2">
      {/* Event track */}
      <div className="flex items-center gap-3 h-7 rounded-[6px] px-2 mb-1 bg-[var(--fill-3)]/60">
        <span className="w-32 text-[11px] font-semibold text-[var(--label-2)] shrink-0">Events</span>
        <div className="relative flex-1 h-full">
          <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--separator)] pointer-events-none" />
          <RowPlayhead duration={duration} />
          {events.map((ev) => (
            <button
              key={`${ev.time}-${ev.name}`}
              type="button"
              title={`${ev.name} @ ${ev.time.toFixed(2)}s · click to seek · double-click to rename · ⌥-click to delete`}
              onClick={(e) => {
                e.stopPropagation();
                if (e.altKey) {
                  deleteAnimationEvent(ev.time, ev.name);
                  return;
                }
                setIsPlaying(false);
                setCurrentTime(ev.time);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                const next = window.prompt("Event name", ev.name);
                if (!next || next === ev.name) return;
                editActiveClip((c) => {
                  const rest = (c.events ?? []).filter((x) => !(x.time === ev.time && x.name === ev.name));
                  return {
                    ...c,
                    events: [...rest, { ...ev, name: next.trim() }].sort((a, b) => a.time - b.time),
                  };
                }, `Renamed event to ${next.trim()}`);
              }}
              style={{ left: `${Math.max(0, Math.min(100, (ev.time / duration) * 100))}%` }}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-3 w-3 rotate-45 bg-[#ff9f0a] border border-black/40 hover:scale-125 transition-transform"
              aria-label={`Event ${ev.name}`}
            />
          ))}
        </div>
        <button
          type="button"
          className="h-6 px-2 rounded-[6px] text-[10.5px] bg-[var(--fill-2)] hover:bg-[var(--fill)] shrink-0"
          onClick={() => addAnimationEventAtCurrentTime("OnHit")}
          data-tip="Add OnHit at playhead"
        >
          + Event
        </button>
      </div>

      {project.bones.map((bone, idx) => {
        const keys = clip.boneTracks[bone.name] ?? [];
        const col = bone.color ?? RIG_BONE_PALETTE[idx % RIG_BONE_PALETTE.length];
        return (
          <div
            key={bone.name}
            className={`flex items-center gap-3 h-6 rounded-[6px] px-2 ${bone.name === selectedBone ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--fill-3)]"}`}
          >
            <button className="w-32 text-[12px] truncate shrink-0 flex items-center gap-2 text-left" onClick={() => selectBone(bone.name)}>
              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: col }} />
              {bone.name}
            </button>
            <div className="relative flex-1 h-full cursor-text" onPointerDown={(e) => scrub(e, bone.name)}>
              <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--separator)] pointer-events-none" />
              <RowPlayhead duration={duration} />
              {keys.map((k, i) => {
                const isSel = selected?.bone === bone.name && selected.index === i;
                return (
                  <button
                    key={`${i}-${k.time}`}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      deleteBoneKeyframe(bone.name, k.time);
                      onSelect(null);
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (e.button !== 0) return;
                      // Window listeners: the diamond remounts as it moves, so element capture would be lost.
                      const lane = e.currentTarget.parentElement!.getBoundingClientRect();
                      const startX = e.clientX;
                      let moved = false;
                      onSelect({ bone: bone.name, index: i });
                      selectBone(bone.name);
                      const onMove = (ev: PointerEvent) => {
                        const dx = ev.clientX - startX;
                        if (!moved && Math.abs(dx) < 3) return;
                        moved = true;
                        // As in Spine: snaps to frames, ⇧ moves freely, ⌥ moves every later key with it.
                        const raw = k.time + (dx / lane.width) * duration;
                        const target = ev.shiftKey ? Math.max(0, Math.min(duration, Number(raw.toFixed(4)))) : snapTime(raw, fps, duration);
                        const r = ev.altKey ? rippleMoveKey(keys, i, target, duration) : moveKey(keys, i, target);
                        editActiveClip((c) => ({ ...c, boneTracks: { ...c.boneTracks, [bone.name]: r.track } }), null);
                        onSelect({ bone: bone.name, index: r.index });
                      };
                      const onUp = () => {
                        window.removeEventListener("pointermove", onMove);
                        window.removeEventListener("pointerup", onUp);
                        if (moved) commitPreview(`Retimed key on ${bone.name}`);
                        else {
                          setIsPlaying(false);
                          setCurrentTime(k.time);
                        }
                      };
                      window.addEventListener("pointermove", onMove);
                      window.addEventListener("pointerup", onUp);
                    }}
                    title={`${bone.name} · frame ${Math.round(k.time * fps)} · ${
                      k.curve === "stepped" ? "stepped" : Array.isArray(k.curve) ? "eased" : "linear"
                    } · drag to retime (⇧ free, ⌥ moves later keys) · double-click to delete`}
                    style={{ left: `${Math.max(0, Math.min(100, (k.time / duration) * 100))}%` }}
                    className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-2.5 w-2.5 rotate-45 rounded-[1px] cursor-ew-resize transition-transform hover:scale-125 ${
                      isSel ? "bg-white ring-2 ring-[var(--accent)]" : Array.isArray(k.curve) ? "bg-[var(--accent-hover)]" : "bg-[var(--label-2)]"
                    }`}
                    aria-label={`Key ${bone.name} frame ${Math.round(k.time * fps)}`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Graph editor ──────────────────────────────────────────────────────────────────────────── */

type GraphDrag =
  | { kind: "scrub" }
  | { kind: "key"; index: number; ch: Channel; origTrack: TransformKey[]; startX: number; startY: number; origTime: number; origValue: number; moved: boolean }
  | { kind: "h1" | "h2"; index: number; origTrack: TransformKey[]; seg: Segment; moved: boolean };

type Segment = { index: number; x0: number; y0: number; x1: number; y1: number; c: Bezier };

function GraphEditor({ clip, selected, onSelect }: { clip: AnimationClip; selected: KeyRef | null; onSelect: (k: KeyRef | null) => void }) {
  const { project, selectedBone, setCurrentTime, setIsPlaying, editActiveClip, commitPreview } = useStudioNoTime();
  const readoutTime = useReadoutTime();
  const bone = selectedBone ?? project.bones[0]?.name ?? "root";
  const { ref, size } = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<GraphDrag | null>(null);

  const track = useMemo(() => clip.boneTracks[bone] ?? [], [clip, bone]);
  const duration = clip.duration;
  const fps = clip.fps || 30;
  const boneIdx = project.bones.findIndex((b) => b.name === bone);
  const boneColor = project.bones[boneIdx]?.color ?? RIG_BONE_PALETTE[Math.max(0, boneIdx) % RIG_BONE_PALETTE.length];

  // Show the channels that actually move; reset when the bone changes.
  const movingChannels = useMemo(
    () => CHANNELS.filter((c) => track.some((k) => Math.abs(channelValue(k, c.id) - c.rest) > 1e-4)).map((c) => c.id),
    [track],
  );
  const [shown, setShown] = useState<Channel[]>(["r"]);
  const [activeCh, setActiveCh] = useState<Channel>("r");
  useEffect(() => {
    const initial = movingChannels.length > 0 ? movingChannels : (["r"] as Channel[]);
    setShown(initial);
    setActiveCh(initial[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bone, clip.name]);

  const samples = useMemo(() => {
    const n = 180;
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = (i / n) * duration;
      return { t, p: sampleTransformTrack(track, t) };
    });
  }, [track, duration]);

  // Value ranges are frozen while dragging so the view does not rescale under the cursor.
  const [frozen, setFrozen] = useState<Record<Channel, [number, number]> | null>(null);
  const ranges = useMemo(() => {
    if (frozen) return frozen;
    const r = {} as Record<Channel, [number, number]>;
    for (const c of CHANNELS) r[c.id] = channelRange(track, c.id, samples.map((s) => s.p[c.id]));
    return r;
  }, [track, samples, frozen]);

  const W = size.w;
  const H = size.h;
  const PL = 10;
  const PR = 14;
  const PT = 20;
  const PB = 12;
  const innerW = Math.max(1, W - PL - PR);
  const innerH = Math.max(1, H - PT - PB);
  const tx = (t: number) => PL + (t / duration) * innerW;
  const ty = (ch: Channel, v: number) => {
    const [lo, hi] = ranges[ch];
    return PT + (1 - (v - lo) / (hi - lo)) * innerH;
  };
  const tOf = (x: number) => ((x - PL) / innerW) * duration;
  const vOf = (ch: Channel, y: number) => {
    const [lo, hi] = ranges[ch];
    return lo + (1 - (y - PT) / innerH) * (hi - lo);
  };

  const selIndex = selected?.bone === bone ? selected.index : -1;
  const segment: Segment | null = (() => {
    const k0 = track[selIndex];
    const k1 = track[selIndex + 1];
    if (!k0 || !k1 || k0.curve === "stepped" || !shown.includes(activeCh)) return null;
    const x0 = tx(k0.time);
    const x1 = tx(k1.time);
    const y0 = ty(activeCh, channelValue(k0, activeCh));
    let y1 = ty(activeCh, channelValue(k1, activeCh));
    // Flat segment: give the handles a virtual box so the curve shape is still editable.
    if (Math.abs(y1 - y0) < 24) y1 = y0 - 48;
    const c: Bezier = Array.isArray(k0.curve) ? k0.curve : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
    return { index: selIndex, x0, y0, x1, y1, c };
  })();

  const point = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const target = e.target as SVGElement;
    const kind = target.dataset.kind;
    e.currentTarget.setPointerCapture(e.pointerId);
    setFrozen(ranges);
    const [px, py] = point(e);
    if (kind === "key") {
      const index = Number(target.dataset.index);
      const ch = target.dataset.ch as Channel;
      const k = track[index]!;
      setActiveCh(ch);
      onSelect({ bone: bone, index });
      dragRef.current = { kind: "key", index, ch, origTrack: track, startX: px, startY: py, origTime: k.time, origValue: channelValue(k, ch), moved: false };
      return;
    }
    if ((kind === "h1" || kind === "h2") && segment) {
      dragRef.current = { kind, index: segment.index, origTrack: track, seg: segment, moved: false };
      return;
    }
    dragRef.current = { kind: "scrub" };
    setIsPlaying(false);
    setCurrentTime(e.shiftKey ? clamp(tOf(px), 0, duration) : snapTime(tOf(px), fps, duration));
    onSelect(null);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const [px, py] = point(e);
    if (d.kind === "scrub") {
      setCurrentTime(e.shiftKey ? clamp(tOf(px), 0, duration) : snapTime(tOf(px), fps, duration));
      return;
    }
    if (d.kind === "key") {
      let dx = px - d.startX;
      let dy = py - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      // ⌘/Ctrl locks to time or value. As in Spine: ⇧ skips frame snapping, ⌥ moves later keys too.
      if (e.metaKey || e.ctrlKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const raw = d.origTime + (dx / innerW) * duration;
      const newTime = e.shiftKey ? clamp(Number(raw.toFixed(4)), 0, duration) : snapTime(raw, fps, duration);
      const newValue = vOf(d.ch, ty(d.ch, d.origValue) + dy);
      const moved = e.altKey ? rippleMoveKey(d.origTrack, d.index, newTime, duration) : moveKey(d.origTrack, d.index, newTime);
      const nextTrack = setKeyChannel(moved.track, moved.index, d.ch, newValue);
      editActiveClip((c) => ({ ...c, boneTracks: { ...c.boneTracks, [bone]: nextTrack } }), null);
      onSelect({ bone: bone, index: moved.index });
      return;
    }
    const s = d.seg;
    const cx = round3(clamp((px - s.x0) / (s.x1 - s.x0), 0, 1));
    const cy = round3(clamp((py - s.y0) / (s.y1 - s.y0), -1.5, 2.5));
    const c: Bezier = [...s.c];
    if (d.kind === "h1") {
      c[0] = cx;
      c[1] = cy;
    } else {
      c[2] = cx;
      c[3] = cy;
    }
    d.moved = true;
    editActiveClip((cl) => ({ ...cl, boneTracks: { ...cl.boneTracks, [bone]: setKeyCurve(d.origTrack, d.index, c) } }), null);
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setFrozen(null);
    if (d && d.kind !== "scrub" && d.moved) commitPreview(d.kind === "key" ? `Edited key on ${bone}` : `Shaped curve on ${bone}`);
  };

  const applyPreset = (curve: CurveType) => {
    if (selIndex < 0) return;
    editActiveClip((c) => ({ ...c, boneTracks: { ...c.boneTracks, [bone]: setKeyCurve(track, selIndex, curve) } }), `Curve on ${bone}`);
  };

  // Frame grid: a line per frame when there is room, labels every 1/2/5/10… frames.
  const framePx = innerW / Math.max(1, duration * fps);
  const labelEvery = [1, 2, 5, 10, 15, 30, 60, 120].find((f) => f * framePx >= 44) ?? 240;
  const totalFrames = Math.round(duration * fps);
  const pose = sampleTransformTrack(track, readoutTime);
  const selKey = track[selIndex];
  const selCurve = selKey ? JSON.stringify(selKey.curve ?? "linear") : "";

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Channel list */}
      <div className="w-48 shrink-0 border-r border-[var(--separator)] px-2 py-1.5 flex flex-col gap-1 overflow-y-auto">
        <div className="flex items-center gap-2 px-1.5 h-6 text-[12px] font-semibold">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: boneColor }} />
          <span className="truncate">{bone}</span>
        </div>
        {CHANNELS.map((c) => {
          const on = shown.includes(c.id);
          const v = pose[c.id];
          return (
            <button
              key={c.id}
              onClick={() => {
                setShown((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]));
                if (!on) setActiveCh(c.id);
              }}
              aria-pressed={on}
              className={`flex items-center gap-2 h-6 px-1.5 rounded-[6px] text-[12px] text-left ${
                on ? "text-[var(--label)]" : "text-[var(--label-3)]"
              } ${activeCh === c.id && on ? "bg-[var(--fill-2)]" : "hover:bg-[var(--fill-3)]"}`}
            >
              <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: on ? c.color : "transparent", border: `1px solid ${c.color}` }} />
              <span className="flex-1">{c.label}</span>
              <span className="tabular-nums text-[11px] text-[var(--label-2)]">
                {c.id === "sx" || c.id === "sy" ? v.toFixed(2) : v.toFixed(1)}
                {c.unit === "°" ? "°" : ""}
              </span>
            </button>
          );
        })}
        {selKey && (
          <div className="mt-1 pt-2 border-t border-[var(--separator)]">
            <div className="px-1.5 text-[11px] text-[var(--label-2)] mb-1.5">
              Key at frame {Math.round(selKey.time * fps)} → next key
            </div>
            <div className="grid grid-cols-2 gap-1">
              {CURVE_PRESETS.map((p) => {
                const active = JSON.stringify(p.curve) === selCurve;
                return (
                  <button
                    key={p.label}
                    onClick={() => applyPreset(p.curve)}
                    className={`h-6 rounded-[6px] text-[11px] ${active ? "liquid-glass-active" : "liquid-glass-button"}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <p className="px-1.5 mt-1.5 text-[10.5px] leading-snug text-[var(--label-3)]">One curve per key, shared by all its channels.</p>
          </div>
        )}
      </div>

      {/* Curve canvas */}
      <div ref={ref} className="relative flex-1 min-w-0">
        {W > 0 && H > 0 && (
          <svg
            ref={svgRef}
            width={W}
            height={H}
            className="absolute inset-0 touch-none select-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={(e) => {
              const el = e.target as SVGElement;
              if (el.dataset.kind !== "key") return;
              const index = Number(el.dataset.index);
              editActiveClip((c) => ({ ...c, boneTracks: { ...c.boneTracks, [bone]: deleteKeyAt(c.boneTracks[bone] ?? [], index) } }), `Deleted key on ${bone}`);
              onSelect(null);
            }}
            onPointerCancel={onPointerUp}
            role="application"
            aria-label={`Graph editor for ${bone}`}
          >
            {/* Frame grid */}
            {framePx >= 7 &&
              Array.from({ length: totalFrames + 1 }, (_, f) => (
                <line key={`f${f}`} x1={tx(f / fps)} x2={tx(f / fps)} y1={PT} y2={H - PB} stroke="rgba(255,255,255,0.035)" />
              ))}
            {Array.from({ length: Math.floor(totalFrames / labelEvery) + 1 }, (_, i) => {
              const f = i * labelEvery;
              const x = tx(f / fps);
              return (
                <g key={`l${f}`}>
                  <line x1={x} x2={x} y1={PT} y2={H - PB} stroke="rgba(255,255,255,0.08)" />
                  <text x={x + 3} y={13} fontSize={10} fill="rgba(235,235,245,0.38)">
                    {f}
                  </text>
                </g>
              );
            })}

            {/* Curves */}
            {CHANNELS.filter((c) => shown.includes(c.id)).map((c) => (
              <path
                key={c.id}
                d={samples.map((s, i) => `${i === 0 ? "M" : "L"}${tx(s.t).toFixed(1)},${ty(c.id, s.p[c.id]).toFixed(1)}`).join("")}
                fill="none"
                stroke={c.color}
                strokeWidth={activeCh === c.id ? 2 : 1.25}
                strokeOpacity={activeCh === c.id ? 1 : 0.55}
                pointerEvents="none"
              />
            ))}

            {/* Bezier handles of the selected segment */}
            {segment && (
              <g>
                {(["h1", "h2"] as const).map((h) => {
                  const hx = segment.x0 + segment.c[h === "h1" ? 0 : 2] * (segment.x1 - segment.x0);
                  const hy = segment.y0 + segment.c[h === "h1" ? 1 : 3] * (segment.y1 - segment.y0);
                  const ax = h === "h1" ? segment.x0 : segment.x1;
                  const ay = h === "h1" ? segment.y0 : segment.y1;
                  return (
                    <g key={h}>
                      <line x1={ax} y1={ay} x2={hx} y2={hy} stroke="rgba(255,255,255,0.5)" strokeDasharray="3 3" pointerEvents="none" />
                      <circle cx={hx} cy={hy} r={5} fill="#fff" stroke="#0a84ff" strokeWidth={2} data-kind={h} className="cursor-grab" />
                    </g>
                  );
                })}
              </g>
            )}

            {/* Keys */}
            {CHANNELS.filter((c) => shown.includes(c.id)).map((c) =>
              track.map((k, i) => {
                const isSel = i === selIndex;
                return (
                  <circle
                    key={`${c.id}-${i}`}
                    cx={tx(k.time)}
                    cy={ty(c.id, channelValue(k, c.id))}
                    r={isSel ? 5.5 : 4.5}
                    fill={isSel ? "#fff" : "#1c1c1e"}
                    stroke={isSel ? "#0a84ff" : c.color}
                    strokeWidth={2}
                    data-kind="key"
                    data-index={i}
                    data-ch={c.id}
                    className="cursor-grab"
                  >
                    <title>{`${c.label} ${channelValue(k, c.id).toFixed(2)} · frame ${Math.round(k.time * fps)} · drag to edit (⇧ free, ⌥ moves later keys, ⌘ locks axis) · double-click to delete`}</title>
                  </circle>
                );
              }),
            )}

            {/* Playhead */}
            <GraphPlayhead x={tx} y1={PT - 6} y2={H - PB} />
          </svg>
        )}
        {track.length === 0 && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none text-[12px] text-[var(--label-3)]">
            No keys on {bone}. Pose it with V, or use Breakdown to add one.
          </div>
        )}
        <span className="absolute right-3 bottom-1.5 text-[10.5px] text-[var(--label-3)] pointer-events-none">Normalized per channel</span>
      </div>
    </div>
  );
}
