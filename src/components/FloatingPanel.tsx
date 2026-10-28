"use client";

import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { FloatRect, PanelId } from "@/store/usePreferencesStore";

type DockZone = "left" | "right" | "copilot";

export function FloatingPanel({
  id,
  title,
  rect,
  onRectChange,
  onDock,
  onDragZones,
  children,
}: {
  id: PanelId;
  title: string;
  rect: FloatRect;
  onRectChange: (rect: FloatRect) => void;
  onDock: () => void;
  /** Called while dragging so the host can highlight edge drop zones. */
  onDragZones?: (active: boolean, over: DockZone | null, panelId: PanelId) => void;
  children: ReactNode;
}) {
  const dragRef = useRef<{
    ox: number;
    oy: number;
    start: FloatRect;
    moved: boolean;
  } | null>(null);

  const zoneAt = (clientX: number, clientY: number): DockZone | null => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (clientX < 72) return "left";
    if (clientX > w - 72) return "right";
    if (clientY > h - 88 && clientX > w * 0.35 && clientX < w * 0.65) return "copilot";
    return null;
  };

  const onHeaderPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { ox: e.clientX, oy: e.clientY, start: { ...rect }, moved: false };
    onDragZones?.(true, null, id);
  };

  const onHeaderPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.ox;
    const dy = e.clientY - drag.oy;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    const maxX = Math.max(0, window.innerWidth - drag.start.w);
    const maxY = Math.max(0, window.innerHeight - 48);
    onRectChange({
      ...drag.start,
      x: Math.max(0, Math.min(maxX, drag.start.x + dx)),
      y: Math.max(28, Math.min(maxY, drag.start.y + dy)),
    });
    onDragZones?.(true, zoneAt(e.clientX, e.clientY), id);
  };

  const onHeaderPointerUp = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const over = zoneAt(e.clientX, e.clientY);
    onDragZones?.(false, over, id);
    if (drag.moved && over) {
      // Host handles docking via onDragZones(false, over, id); also call onDock when dropping on matching intent.
      // Actual dock is decided by StudioApp from the zone callback.
    }
  };

  const onResizePointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...rect };
    const onMove = (ev: globalThis.PointerEvent) => {
      onRectChange({
        x: start.x,
        y: start.y,
        w: Math.max(240, Math.min(560, start.w + (ev.clientX - startX))),
        h: Math.max(200, Math.min(window.innerHeight - 40, start.h + (ev.clientY - startY))),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="fixed z-[55] pointer-events-auto flex flex-col material-thick rounded-[var(--radius-panel)] shadow-[var(--shadow-panel)] overflow-hidden"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      data-floating-panel={id}
    >
      <header
        className="h-9 px-2.5 flex items-center gap-2 shrink-0 border-b border-[var(--separator)] cursor-grab active:cursor-grabbing select-none"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span className="text-[12px] font-semibold truncate flex-1">{title}</span>
        <button
          type="button"
          className="h-6 px-2 rounded-[6px] text-[11px] bg-[var(--fill-2)] hover:bg-[var(--fill)]"
          onClick={onDock}
          data-tip="Dock panel"
        >
          Dock
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{children}</div>
      <div
        className="absolute right-0 bottom-0 w-3.5 h-3.5 cursor-nwse-resize"
        onPointerDown={onResizePointerDown}
        aria-label="Resize panel"
      />
    </div>
  );
}

export function DockDropZones({
  active,
  over,
}: {
  active: boolean;
  over: DockZone | null;
}) {
  if (!active) return null;
  const zone = (id: DockZone, className: string, label: string) => (
    <div
      className={`pointer-events-none fixed z-[60] flex items-center justify-center border-2 border-dashed rounded-[12px] transition-colors ${className} ${
        over === id ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--separator-strong)] bg-black/20"
      }`}
      aria-hidden
    >
      <span className="text-[12px] font-semibold text-[var(--label)] px-2 py-1 rounded-[8px] bg-[var(--material-thick)]">{label}</span>
    </div>
  );
  return (
    <>
      {zone("left", "left-2 top-16 bottom-16 w-14", "Dock left")}
      {zone("right", "right-2 top-16 bottom-16 w-14", "Dock right")}
      {zone("copilot", "left-1/2 -translate-x-1/2 bottom-3 w-48 h-14", "Dock copilot")}
    </>
  );
}
