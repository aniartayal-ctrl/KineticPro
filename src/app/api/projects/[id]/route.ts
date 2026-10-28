import { NextResponse } from "next/server";
import { errorResponse } from "@/server/http";
import {
  listProjectBackups,
  loadProjectBackup,
  loadProjectFile,
  saveProjectFile,
} from "@/server/projects";
import { validateProject, type SpineForgeProject } from "@/core/schema";

export const dynamic = "force-dynamic";

/** Loads one saved project. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    if (url.searchParams.get("backups") === "1") {
      return NextResponse.json({ backups: listProjectBackups(id) });
    }
    const backup = url.searchParams.get("backup");
    if (backup) {
      return NextResponse.json({ project: loadProjectBackup(id, backup) });
    }
    return NextResponse.json({ project: loadProjectFile(id) });
  } catch (err) {
    return errorResponse(err, "Could not open project");
  }
}

/** Saves / autosaves a project to disk (creates a backup of the previous file). */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { project?: SpineForgeProject };
    if (!body.project) return NextResponse.json({ error: "Missing project" }, { status: 400 });
    if (body.project.id !== id) {
      return NextResponse.json({ error: "Project id mismatch" }, { status: 400 });
    }
    const errors = validateProject(body.project);
    if (errors.length) return NextResponse.json({ error: errors[0] }, { status: 400 });
    const saved = saveProjectFile(body.project);
    return NextResponse.json({
      ok: true,
      savedAt: saved.savedAt,
      unchanged: saved.unchanged,
      backup: saved.backup ? true : false,
    });
  } catch (err) {
    return errorResponse(err, "Could not save project");
  }
}
