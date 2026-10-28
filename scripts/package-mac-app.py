#!/usr/bin/env python3
"""Packages the ONE canonical Kinetic Pro.app.

Canonical product (do not confuse):
  Claude studio UI (Visual Physics Learner, HEAVY TITAN, Batch 8-Symbol Auto-Rigger, Copilot)
  inside a native macOS WKWebView shell — Sources/KineticProStudio.

NOT packaged (prototype only, never ship as Kinetic Pro.app):
  SpineForgeMacApp SwiftUI Metal UI

Also removes any legacy SpineForge.app alias so only one .app remains.
"""

from __future__ import annotations

import plistlib
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_BUNDLE = ROOT / "Kinetic Pro.app"
LEGACY_BUNDLE = ROOT / "SpineForge.app"
BRAND_ICNS = ROOT / "public" / "brand" / "AppIcon.icns"
EXEC_NAME = "KineticPro"
CANONICAL_MARKER = (
    "CANONICAL Kinetic Pro — Claude studio (WKWebView shell).\n"
    "UI markers: Visual Physics Learner, HEAVY TITAN, Batch 8-Symbol Auto-Rigger.\n"
    "Do NOT replace this binary with SpineForgeMetalUI / SwiftUI Metal prototype.\n"
)


def build_icns(dest_icns: Path) -> None:
    if not BRAND_ICNS.exists():
        raise SystemExit("public/brand/AppIcon.icns is missing: run `npm run brand` first.")
    shutil.copy2(BRAND_ICNS, dest_icns)


def make_info_plist() -> dict:
    return {
        "CFBundleName": "Kinetic Pro",
        "CFBundleDisplayName": "Kinetic Pro",
        "CFBundleIdentifier": "com.apple-style.kineticpro.studio",
        "CFBundleVersion": "1.0.0",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundlePackageType": "APPL",
        "CFBundleExecutable": EXEC_NAME,
        "CFBundleIconFile": "AppIcon",
        "LSMinimumSystemVersion": "14.0",
        "LSApplicationCategoryType": "public.app-category.graphics-design",
        "NSHighResolutionCapable": True,
        "NSSupportsAutomaticGraphicsSwitching": False,
        "NSPrincipalClass": "NSApplication",
        "NSHumanReadableCopyright": "Kinetic Pro — Claude Studio (native macOS shell)",
        "CFBundleDocumentTypes": [
            {
                "CFBundleTypeName": "Kinetic Pro Project",
                "CFBundleTypeRole": "Editor",
                "LSHandlerRank": "Owner",
                "LSItemContentTypes": ["com.kineticpro.project"],
                "CFBundleTypeExtensions": ["project.json", "json"],
            },
            {
                "CFBundleTypeName": "Character Art",
                "CFBundleTypeRole": "Viewer",
                "LSHandlerRank": "Alternate",
                "LSItemContentTypes": [
                    "public.png",
                    "public.jpeg",
                    "public.tiff",
                    "public.heic",
                    "org.webmproject.webp",
                    "com.adobe.photoshop-image",
                ],
            },
        ],
        "UTExportedTypeDeclarations": [
            {
                "UTTypeIdentifier": "com.kineticpro.project",
                "UTTypeDescription": "Kinetic Pro Project",
                "UTTypeConformsTo": ["public.json", "public.data"],
                "UTTypeTagSpecification": {
                    "public.filename-extension": ["project.json", "json"],
                },
            }
        ],
    }


def package_app() -> None:
    # Remove every other .app in the repo root so only the canonical build remains.
    if LEGACY_BUNDLE.exists():
        shutil.rmtree(LEGACY_BUNDLE)
        print(f"Removed legacy alias -> {LEGACY_BUNDLE}")
    if APP_BUNDLE.exists():
        shutil.rmtree(APP_BUNDLE)

    macos_dir = APP_BUNDLE / "Contents" / "MacOS"
    res_dir = APP_BUNDLE / "Contents" / "Resources"
    macos_dir.mkdir(parents=True, exist_ok=True)
    res_dir.mkdir(parents=True, exist_ok=True)

    release_dir = ROOT / "macos-metal" / ".build" / "release"
    studio_bin = release_dir / EXEC_NAME
    cli = release_dir / "spineforge-metal-cli"
    if not studio_bin.exists():
        raise SystemExit(
            f"Missing {studio_bin}. Run: ./scripts/build-mac.sh\n"
            "Expected product: KineticPro (KineticProStudio WKWebView shell)."
        )

    shutil.copy2(studio_bin, macos_dir / EXEC_NAME)
    (macos_dir / EXEC_NAME).chmod(0o755)
    if cli.exists():
        shutil.copy2(cli, macos_dir / "spineforge-metal-cli")
        (macos_dir / "spineforge-metal-cli").chmod(0o755)

    build_icns(res_dir / "AppIcon.icns")
    (res_dir / "CANONICAL_APP.txt").write_text(CANONICAL_MARKER, encoding="utf-8")

    presets_dst = res_dir / "presets"
    shutil.copytree(ROOT / "public" / "presets", presets_dst)
    for preset_id in ["astral-forge", "sands-of-solara"]:
        proj_json = ROOT / "exports" / preset_id / f"{preset_id}.project.json"
        if proj_json.exists():
            shutil.copy2(proj_json, presets_dst / preset_id / f"{preset_id}.project.json")
            public_proj = ROOT / "public" / "presets" / preset_id / f"{preset_id}.project.json"
            shutil.copy2(proj_json, public_proj)

    with (APP_BUNDLE / "Contents" / "Info.plist").open("wb") as f:
        plistlib.dump(make_info_plist(), f)

    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(APP_BUNDLE)], check=True)
    print(f"Packaged CANONICAL Kinetic Pro.app (Claude studio shell) -> {APP_BUNDLE}")


if __name__ == "__main__":
    package_app()
