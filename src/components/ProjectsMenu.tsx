"use client";

import { useEffect, useState } from "react";
import { BUILTIN_PRESETS } from "@/core/presets";
import type { BackupSummary, ProjectSummary } from "@/server/projects";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import type { DocumentRequest } from "@/store/useStudioStore";
import type { SpineForgeProject } from "@/core/schema";

export type OpenTarget = DocumentRequest;

const SMALL_WORDS = new Set(["of", "the", "and", "a", "an", "in", "on", "to"]);
const humanize = (id: string) =>
  id
    .split(/[-_]+/)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");

export const BUILTIN_PROJECTS: OpenTarget[] = Object.keys(BUILTIN_PRESETS).map((id) => ({ kind: "preset", id, title: humanize(id) }));

/** The hero template of the theme a project belongs to (symbol rigs share their hero's theme). */
export function heroTemplate(projectId: string): OpenTarget {
  const id = projectId.includes("solara") ? "sands-of-solara" : "astral-forge";
  return BUILTIN_PROJECTS.find((t) => t.id === id) ?? BUILTIN_PROJECTS[0]!;
}

export async function fetchSavedProjects(): Promise<ProjectSummary[]> {
  const res = await fetch("/api/projects", { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { projects?: ProjectSummary[]; error?: string };
  if (!res.ok || !Array.isArray(data.projects)) throw new Error(data.error ?? `Could not list projects (${res.status})`);
  return data.projects;
}

export function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  if (new Date(now.getTime() - 86_400_000).toDateString() === d.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

const Check = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5 10 17.5 19 7" />
  </svg>
);

/** Popover under the document title: saved projects first, then built-in presets. */
export function ProjectsMenu({
  currentId,
  onOpen,
  onRestoreBackup,
}: {
  currentId: string;
  onOpen: (target: OpenTarget) => Promise<string | null>;
  onRestoreBackup?: (project: SpineForgeProject) => Promise<string | null>;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupSummary[] | null>(null);
  const recent = usePreferencesStore((s) => s.recentProjects);

  useEffect(() => {
    fetchSavedProjects()
      .then(setProjects)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not list projects"));
    fetch(`/api/projects/${encodeURIComponent(currentId)}?backups=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { backups?: BackupSummary[] } | null) => setBackups(d?.backups ?? []))
      .catch(() => setBackups([]));
  }, [currentId]);

  const open = async (target: OpenTarget) => {
    setBusy(`${target.kind}:${target.id}`);
    setError(null);
    const err = await onOpen(target);
    setBusy(null);
    if (err) setError(err);
  };

  const restore = async (name: string) => {
    if (!onRestoreBackup) return;
    setBusy(`backup:${name}`);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(currentId)}?backup=${encodeURIComponent(name)}`);
      const data = (await res.json().catch(() => ({}))) as { project?: SpineForgeProject; error?: string };
      if (!res.ok || !data.project) throw new Error(data.error ?? "Could not load backup");
      const err = await onRestoreBackup(data.project);
      if (err) setError(err);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not restore backup");
    } finally {
      setBusy(null);
    }
  };

  const row = "w-full text-left rounded-[8px] px-2 py-1.5 group hover:bg-[var(--accent)] hover:text-white disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-inherit transition-colors";
  const sub = "text-[11px] text-[var(--label-3)] group-hover:text-white/75";

  return (
    <div role="menu" aria-label="Projects" className="absolute top-[calc(100%+6px)] left-1/2 -translate-x-1/2 w-[340px] material-thick rounded-[12px] p-1.5 animate-panel-in text-left">
      {recent.length > 0 && (
        <>
          <div className="px-2 pt-1 pb-1 text-[11px] font-semibold text-[var(--label-3)]">Recent</div>
          {recent.map((r) => (
            <button
              key={r.id}
              role="menuitem"
              disabled={busy !== null}
              onClick={() =>
                void open(
                  projects?.some((p) => p.id === r.id)
                    ? { kind: "saved", id: r.id, title: r.title }
                    : BUILTIN_PROJECTS.find((t) => t.id === r.id) ?? { kind: "saved", id: r.id, title: r.title },
                )
              }
              className={row}
            >
              <div className="flex items-center gap-2">
                <span className="w-4 shrink-0" />
                <span className="flex-1 truncate text-[13px]">{r.title}</span>
              </div>
            </button>
          ))}
          <div className="h-px bg-[var(--separator)] my-1 mx-2" />
        </>
      )}
      <div className="px-2 pt-1 pb-1 text-[11px] font-semibold text-[var(--label-3)]">Saved</div>
      {projects === null && !error && <div className="px-2 py-2 text-[12px] text-[var(--label-3)]">Loading…</div>}
      {projects?.length === 0 && (
        <div className="px-2 py-2 text-[12px] text-[var(--label-2)] leading-snug">Nothing saved yet. Press ⌘S to save this project into the projects folder.</div>
      )}
      <div className="max-h-[46vh] overflow-y-auto">
        {projects?.map((p) => (
          <button key={p.id} role="menuitem" disabled={p.damaged || busy !== null} onClick={() => void open({ kind: "saved", id: p.id, title: p.title })} className={row}>
            <div className="flex items-center gap-2">
              <span className="w-4 shrink-0 grid place-items-center">{p.id === currentId ? <Check /> : null}</span>
              <span className="flex-1 truncate text-[13px]">{p.title}</span>
              <span className={`${sub} tabular-nums shrink-0`}>{busy === `saved:${p.id}` ? "Opening…" : formatSavedAt(p.savedAt)}</span>
            </div>
            <div className={`pl-6 ${sub}`}>
              {p.damaged ? `Damaged. Restore a copy from projects/${p.id}/backups` : `${p.bones} bones · ${p.parts} layers · ${p.clips} clips`}
            </div>
          </button>
        ))}
      </div>

      <div className="h-px bg-[var(--separator)] my-1 mx-2" />
      <div className="px-2 pt-1 pb-1 text-[11px] font-semibold text-[var(--label-3)]">Built-in</div>
      {BUILTIN_PROJECTS.map((t) => (
        <button key={t.id} role="menuitem" disabled={busy !== null} onClick={() => void open(t)} className={row}>
          <div className="flex items-center gap-2">
            <span className="w-4 shrink-0" />
            <span className="flex-1 truncate text-[13px]">{t.title}</span>
            <span className={sub}>{busy === `preset:${t.id}` ? "Opening…" : "Template"}</span>
          </div>
        </button>
      ))}

      {error && (
        <p role="alert" className="mx-2 mt-1 text-[12px] leading-snug text-[#ff453a]">
          {error}
        </p>
      )}
      {backups && backups.length > 0 && onRestoreBackup && (
        <>
          <div className="h-px bg-[var(--separator)] my-1 mx-2" />
          <div className="px-2 pt-1 pb-1 text-[11px] font-semibold text-[var(--label-3)]">Versions</div>
          <div className="max-h-28 overflow-y-auto">
            {backups.slice(0, 8).map((b) => (
              <button
                key={b.name}
                role="menuitem"
                disabled={busy !== null}
                onClick={() => void restore(b.name)}
                className={row}
              >
                <div className="flex items-center gap-2">
                  <span className="w-4 shrink-0" />
                  <span className="flex-1 truncate text-[12px]">{formatSavedAt(b.savedAt)}</span>
                  <span className={`${sub} tabular-nums`}>{busy === `backup:${b.name}` ? "…" : `${Math.round(b.bytes / 1024)} KB`}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="h-px bg-[var(--separator)] my-1 mx-2" />
      <p className="px-2 pb-1 text-[11px] text-[var(--label-3)]">Saved in the projects folder · ⌘S save · ⌘O open</p>
    </div>
  );
}

/** macOS-style "Save changes?" sheet shown before replacing an edited project. */
export function UnsavedChangesDialog({
  title,
  nextTitle,
  error,
  busy,
  onSave,
  onDiscard,
  onCancel,
}: {
  title: string;
  nextTitle: string;
  error: string | null;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 animate-panel-in"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-body" className="material-thick rounded-[14px] w-[360px] p-5 space-y-3 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/kinetic-icon-small.svg" alt="" width={48} height={48} className="mx-auto" draggable={false} />
        <h2 id="unsaved-title" className="text-[13px] font-semibold leading-snug">
          Save changes to “{title}”?
        </h2>
        <p id="unsaved-body" className="text-[12px] text-[var(--label-2)] leading-snug">
          Opening “{nextTitle}” closes this project. Changes you don’t save will be lost.
        </p>
        {error && (
          <p role="alert" className="text-[12px] text-[#ff453a] leading-snug">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button onClick={onDiscard} disabled={busy} className="liquid-glass-button h-7 px-3 rounded-[6px] text-[12px]">
            Don’t Save
          </button>
          <div className="flex-1" />
          <button onClick={onCancel} disabled={busy} className="liquid-glass-button h-7 px-3 rounded-[6px] text-[12px]">
            Cancel
          </button>
          <button autoFocus onClick={onSave} disabled={busy} className="btn-primary h-7 px-4 text-[12px]">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
