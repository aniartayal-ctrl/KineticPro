import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { blockCrossSite } from "@/server/http";
import { projectAssetsDir, projectFilePath } from "@/server/projects";
import { toSafeProjectId } from "@/server/safe-paths";

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB covers large layered PSDs

const execFileAsync = promisify(execFile);

/** vision/.venv when it exists (see vision/requirements.txt), else KINETIC_PYTHON, else python3 on PATH. */
function pythonBin(): string {
  if (process.env.KINETIC_PYTHON) return process.env.KINETIC_PYTHON;
  const venv = path.join(/*turbopackIgnore: true*/ process.cwd(), "vision", ".venv", "bin", "python3");
  return existsSync(venv) ? venv : "python3";
}

/** Turns a failed part-cutter run into a message that says how to fix it. */
function cutterError(err: unknown): { message: string; status: number; code?: string; overlap?: number } {
  const e = err as { code?: string | number; killed?: boolean; signal?: string; stderr?: string; message?: string };
  const setup = "Run: python3 -m venv vision/.venv && vision/.venv/bin/pip install -r vision/requirements.txt";
  if (e?.code === "ENOENT") return { message: `Python 3 was not found, and the part cutter needs it. Install Python 3, then ${setup.charAt(0).toLowerCase()}${setup.slice(1)}`, status: 501 };
  const missing = /No module named '([^']+)'/.exec(e?.stderr ?? e?.message ?? "")?.[1];
  if (missing) return { message: `The part cutter needs the Python package "${missing}". ${setup}`, status: 501 };
  if (e?.killed || e?.signal === "SIGTERM") return { message: "The part cutter took longer than 5 minutes and was stopped. Try a smaller image.", status: 504 };
  const stderr = (e?.stderr ?? "").trim();
  // CLI prints JSON on stderr (and stdout) for pose_not_riggable; also check stdout via message
  for (const blob of [stderr, e?.message ?? ""]) {
    for (const line of blob.split("\n").filter(Boolean).reverse()) {
      try {
        const parsed = JSON.parse(line) as { error?: string; code?: string; overlap?: number };
        if (parsed?.code === "pose_not_riggable") {
          return {
            message: parsed.error || "Pose is not riggable",
            status: 422,
            code: parsed.code,
            overlap: parsed.overlap,
          };
        }
      } catch {
        /* not JSON */
      }
    }
  }
  const lastLine = stderr.split("\n").filter(Boolean).pop();
  return { message: lastLine || (err instanceof Error ? err.message : "Part cutter failed"), status: 500 };
}

export async function POST(request: Request) {
  const blocked = blockCrossSite(request);
  if (blocked) return blocked;
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const configRaw = (formData.get("config") as string | null) ?? "{}";
    // Never overwrite the assets of a project that is already saved under this name.
    const baseId = toSafeProjectId(formData.get("projectId") as string | null);
    let projectId = baseId;
    for (let n = 2; existsSync(projectFilePath(projectId)) && n < 1000; n++) projectId = toSafeProjectId(`${baseId.slice(0, 58)}-${n}`);

    if (!file) {
      return NextResponse.json({ error: "Missing image or PSD file" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "File is larger than 200 MB" }, { status: 413 });
    }
    try {
      JSON.parse(configRaw);
    } catch {
      return NextResponse.json({ error: "Cut config is not valid JSON" }, { status: 400 });
    }

    // Imports live with the user's project, never in the shipped presets folder.
    const outDir = projectAssetsDir(projectId);
    const assetUrl = (file: string) => `/api/projects/${projectId}/assets/${file.split("/").map(encodeURIComponent).join("/")}`;
    mkdirSync(outDir, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.toLowerCase().endsWith(".psd") ? ".psd" : ".png";
    const srcPath = path.join(outDir, `source${ext}`);
    writeFileSync(srcPath, buffer);

    const scriptPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "vision", "part_cutter.py");

    if (ext === ".psd") {
      const { stdout } = await execFileAsync(pythonBin(), [scriptPath, "psd", srcPath, outDir], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      });
      const parsed = JSON.parse(stdout);
      for (const p of parsed.parts ?? []) p.src = assetUrl(p.src);
      return NextResponse.json({ projectId, heroSrc: assetUrl(parsed.composite ?? "source.psd"), ...parsed });
    } else {
      const cfgPath = path.join(outDir, "cut-config.json");
      writeFileSync(cfgPath, configRaw);
      const { stdout } = await execFileAsync(pythonBin(), [scriptPath, "cut", srcPath, outDir, "--config", cfgPath], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      });
      const parsed = JSON.parse(stdout);
      for (const p of parsed.parts ?? []) p.src = assetUrl(p.src);
      return NextResponse.json({ projectId, heroSrc: assetUrl("source.png"), ...parsed });
    }
  } catch (err) {
    const { message, status, code, overlap } = cutterError(err);
    return NextResponse.json({ error: message, ...(code ? { code } : {}), ...(overlap != null ? { overlap } : {}) }, { status });
  }
}

export async function GET() {
  const pkgPath = path.join(process.cwd(), "unity-package", "com.spineforge.runtime", "package.json");
  return NextResponse.json({ visionWorker: "ready", unityPackageReady: existsSync(pkgPath) });
}
