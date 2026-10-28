"use client";

import { useEffect, useMemo, useState } from "react";

type SheetFrame = { filename?: string; frame?: { x: number; y: number; w: number; h: number } };

/** Lean Unity “play mode”: scrub the exported sprite sheet as a flipbook. */
export function UnityPreviewModal({
  open,
  onClose,
  sheetDataUrl,
  sheetJson,
  title,
}: {
  open: boolean;
  onClose: () => void;
  sheetDataUrl: string;
  sheetJson: string;
  title: string;
}) {
  const frames = useMemo(() => {
    try {
      const parsed = JSON.parse(sheetJson) as { frames?: SheetFrame[] | Record<string, SheetFrame> };
      if (Array.isArray(parsed.frames)) return parsed.frames.filter((f) => f.frame);
      if (parsed.frames && typeof parsed.frames === "object") {
        return Object.values(parsed.frames).filter((f) => f.frame);
      }
    } catch {
      /* ignore */
    }
    return [] as SheetFrame[];
  }, [sheetJson]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setPlaying(true);
  }, [open, sheetDataUrl]);

  useEffect(() => {
    if (!open || !playing || frames.length === 0) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % frames.length), 100);
    return () => window.clearInterval(id);
  }, [open, playing, frames.length]);

  if (!open) return null;
  const fr = frames[index]?.frame;

  return (
    <div
      className="fixed inset-0 z-[85] grid place-items-center bg-black/50 pointer-events-auto"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Unity sheet preview"
        className="material-thick w-[min(520px,calc(100vw-32px))] rounded-[16px] overflow-hidden animate-panel-in"
      >
        <header className="h-11 px-4 flex items-center justify-between border-b border-[var(--separator)]">
          <h2 className="text-[14px] font-semibold truncate">Unity preview · {title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="p-4 flex flex-col items-center gap-3">
          <div className="relative w-64 h-64 rounded-[12px] bg-black/40 overflow-hidden border border-[var(--separator)]">
            {fr ? (
              <div
                className="absolute inset-0 bg-no-repeat"
                style={{
                  backgroundImage: `url(${sheetDataUrl})`,
                  backgroundPosition: `-${fr.x}px -${fr.y}px`,
                  width: fr.w,
                  height: fr.h,
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  imageRendering: "pixelated",
                }}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sheetDataUrl} alt="" className="w-full h-full object-contain" />
            )}
          </div>
          <div className="flex items-center gap-2 w-full">
            <button type="button" className="btn-primary h-8 px-3 text-[12px]" onClick={() => setPlaying((p) => !p)}>
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={index}
              onChange={(e) => {
                setPlaying(false);
                setIndex(Number(e.target.value));
              }}
              className="flex-1"
              aria-label="Frame"
            />
            <span className="text-[11px] tabular-nums text-[var(--label-3)] w-16 text-right">
              {frames.length ? `${index + 1}/${frames.length}` : "sheet"}
            </span>
          </div>
          <p className="text-[11px] text-[var(--label-3)] text-center">
            Sprite-sheet flipbook stand-in for Unity play mode. Export the ZIP for the real player.
          </p>
        </div>
      </div>
    </div>
  );
}
