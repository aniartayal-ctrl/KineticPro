#!/usr/bin/env python3
"""FastAPI HTTP wrapper around SpineForge's vision part cutter & PSD extractor."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from part_cutter import cut_flat_character, extract_psd_layers
from pose_gate import PoseNotRiggableError

app = FastAPI(title="SpineForge Vision Service", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "spineforge-vision"}


@app.post("/cut")
async def cut_endpoint(
    image: UploadFile = File(...),
    config_json: str = Form("{}"),
    output_dir: str = Form(""),
) -> dict[str, Any]:
    cfg = json.loads(config_json)
    target_dir = Path(output_dir) if output_dir else Path(tempfile.mkdtemp(prefix="spineforge-parts-"))
    target_dir.mkdir(parents=True, exist_ok=True)
    src_path = target_dir / (image.filename or "source.png")
    src_path.write_bytes(await image.read())
    try:
        result = cut_flat_character(src_path, target_dir, cfg)
    except PoseNotRiggableError as exc:
        return JSONResponse(
            status_code=422,
            content={"error": str(exc), "code": exc.code, "overlap": exc.overlap},
        )
    result["outputDir"] = str(target_dir)
    return result


@app.post("/psd")
async def psd_endpoint(
    psd: UploadFile = File(...),
    output_dir: str = Form(""),
) -> dict[str, Any]:
    target_dir = Path(output_dir) if output_dir else Path(tempfile.mkdtemp(prefix="spineforge-psd-"))
    target_dir.mkdir(parents=True, exist_ok=True)
    src_path = target_dir / (psd.filename or "source.psd")
    src_path.write_bytes(await psd.read())
    result = extract_psd_layers(src_path, target_dir)
    result["outputDir"] = str(target_dir)
    return result
