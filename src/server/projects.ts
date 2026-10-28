/**
 * Saved projects on disk (`src/server/projects.ts`).
 *
 * Everything a user makes lives under `projects/` (override with KINETIC_PROJECTS_DIR):
 *   projects/<id>/<id>.project.json        the project
 *   projects/<id>/backups/                  the previous 10 versions, newest first by name
 *   projects/<id>/assets/                   imported PSD/PNG layers, served by /api/projects/<id>/assets
 * Shipped presets in public/presets are never written. Saves are atomic (temp file + rename), so a
 * crash or power cut mid-save cannot leave a half-written project.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateProject, type SpineForgeProject } from "../core/schema";
import { assertSafeProjectId, isSafeProjectId, resolveInside } from "./safe-paths";

export const BACKUPS_KEPT = 10;

export type ProjectSummary = {
  id: string;
  title: string;
  /** ISO time of the last save. */
  savedAt: string;
  bytes: number;
  bones: number;
  parts: number;
  clips: number;
  /** The file exists but could not be parsed; a backup may still be good. */
  damaged?: boolean;
};

export class ProjectFileError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProjectFileError";
  }
}

export function projectsRoot(): string {
  // turbopackIgnore: this folder is user data read at run time, not a build input to trace.
  const custom = process.env.KINETIC_PROJECTS_DIR;
  return custom ? path.resolve(/*turbopackIgnore: true*/ custom) : path.join(/*turbopackIgnore: true*/ process.cwd(), "projects");
}

function projectDir(id: string, root: string): string {
  return resolveInside(root, assertSafeProjectId(id));
}

export function projectFilePath(id: string, root = projectsRoot()): string {
  return path.join(projectDir(id, root), `${id}.project.json`);
}

export function projectAssetsDir(id: string, root = projectsRoot()): string {
  return path.join(projectDir(id, root), "assets");
}

/** Resolves an asset path inside a project's assets folder; throws if it would escape it. */
export function resolveProjectAsset(id: string, segments: string[], root = projectsRoot()): string {
  return resolveInside(projectAssetsDir(id, root), segments.join("/"));
}

function pruneBackups(dir: string, id: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`${id}-`) && f.endsWith(".project.json"))
    .sort()
    .reverse();
  for (const f of files.slice(BACKUPS_KEPT)) rmSync(path.join(dir, f), { force: true });
}

export function saveProjectFile(
  project: SpineForgeProject,
  root = projectsRoot(),
): { file: string; savedAt: string; backup: string | null; unchanged: boolean } {
  const id = assertSafeProjectId(project?.id);
  const errors = validateProject(project);
  if (errors.length > 0) throw new ProjectFileError(errors.join("; "), 400);

  const dir = projectDir(id, root);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.project.json`);
  const json = JSON.stringify(project, null, 2) + "\n";

  let backup: string | null = null;
  if (existsSync(file)) {
    const previous = readFileSync(file, "utf8");
    if (previous === json) return { file, savedAt: statSync(file).mtime.toISOString(), backup: null, unchanged: true };
    const backups = path.join(dir, "backups");
    mkdirSync(backups, { recursive: true });
    backup = path.join(backups, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}.project.json`);
    copyFileSync(file, backup);
    pruneBackups(backups, id);
  }

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, json);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { file, savedAt: statSync(file).mtime.toISOString(), backup, unchanged: false };
}

export function listProjects(root = projectsRoot()): ProjectSummary[] {
  if (!existsSync(root)) return [];
  const out: ProjectSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeProjectId(entry.name)) continue;
    const file = path.join(root, entry.name, `${entry.name}.project.json`);
    if (!existsSync(file)) continue;
    const st = statSync(file);
    const base = { id: entry.name, savedAt: st.mtime.toISOString(), bytes: st.size };
    try {
      const p = JSON.parse(readFileSync(file, "utf8")) as Partial<SpineForgeProject>;
      out.push({
        ...base,
        title: typeof p.title === "string" && p.title ? p.title : entry.name,
        bones: Array.isArray(p.bones) ? p.bones.length : 0,
        parts: Array.isArray(p.parts) ? p.parts.length : 0,
        clips: p.animations && typeof p.animations === "object" ? Object.keys(p.animations).length : 0,
      });
    } catch {
      out.push({ ...base, title: entry.name, bones: 0, parts: 0, clips: 0, damaged: true });
    }
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function loadProjectFile(id: string, root = projectsRoot()): SpineForgeProject {
  const file = projectFilePath(id, root);
  if (!existsSync(file)) throw new ProjectFileError(`No saved project "${id}"`, 404);
  let project: SpineForgeProject;
  try {
    project = JSON.parse(readFileSync(file, "utf8")) as SpineForgeProject;
  } catch {
    throw new ProjectFileError(`"${id}" is damaged. Copy a file from projects/${id}/backups over it to restore.`, 422);
  }
  const errors = validateProject(project);
  if (errors.length > 0) throw new ProjectFileError(`"${id}" is not a valid project: ${errors[0]}`, 422);
  return project;
}

export type BackupSummary = { name: string; savedAt: string; bytes: number };

/** Lists backup snapshots for a project (newest first). */
export function listProjectBackups(id: string, root = projectsRoot()): BackupSummary[] {
  const dir = path.join(projectDir(assertSafeProjectId(id), root), "backups");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".project.json"))
    .map((name) => {
      const st = statSync(path.join(dir, name));
      return { name, savedAt: st.mtime.toISOString(), bytes: st.size };
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Loads a specific backup file by name (basename only). */
export function loadProjectBackup(id: string, backupName: string, root = projectsRoot()): SpineForgeProject {
  const safeId = assertSafeProjectId(id);
  if (!backupName.endsWith(".project.json") || backupName.includes("/") || backupName.includes("..")) {
    throw new ProjectFileError("Invalid backup name", 400);
  }
  const file = path.join(projectDir(safeId, root), "backups", backupName);
  if (!existsSync(file)) throw new ProjectFileError(`No backup "${backupName}"`, 404);
  try {
    const project = JSON.parse(readFileSync(file, "utf8")) as SpineForgeProject;
    const errors = validateProject(project);
    if (errors.length > 0) throw new ProjectFileError(`Backup is not valid: ${errors[0]}`, 422);
    return project;
  } catch (err) {
    if (err instanceof ProjectFileError) throw err;
    throw new ProjectFileError("Could not read backup", 422);
  }
}
