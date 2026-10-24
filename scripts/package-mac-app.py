#!/usr/bin/env python3
"""Packages Kinetic Pro.app as a standalone native macOS application bundle with:
- Apple Metal 120Hz ProMotion binary (`Contents/MacOS/SpineForge`)
- Apple Metal GPU CLI (`Contents/MacOS/spineforge-metal-cli`)
- Kinetic Pro app icon (`Contents/Resources/AppIcon.icns`, built by `npm run brand`)
- Self-contained preset rigs & textures (`Contents/Resources/presets/`)
- Document types for `.project.json` and common art imports
- Ad-hoc code signature (`codesign --force --deep --sign -`)

Run on macOS after: ./scripts/build-mac.sh
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


def build_icns(dest_icns: Path) -> None:
    """Copies the brand icon (`npm run brand` renders it from scripts/brand.mjs)."""
    if not BRAND_ICNS.exists():
        raise SystemExit("public/brand/AppIcon.icns is missing: run `npm run brand` first.")
    shutil.copy2(BRAND_ICNS, dest_icns)


def make_info_plist(*, display_name: str, bundle_id: str) -> dict:
    return {
        "CFBundleName": display_name,
        "CFBundleDisplayName": display_name,
        "CFBundleIdentifier": bundle_id,
        "CFBundleVersion": "1.0.0",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundlePackageType": "APPL",
        "CFBundleExecutable": "SpineForge",
        "CFBundleIconFile": "AppIcon",
        "LSMinimumSystemVersion": "14.0",
        "LSApplicationCategoryType": "public.app-category.graphics-design",
        "NSHighResolutionCapable": True,
        "NSSupportsAutomaticGraphicsSwitching": True,
        "NSPrincipalClass": "NSApplication",
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
        "NSHumanReadableCopyright": "Kinetic Pro — Apple Metal 2D Mesh & Rigging Studio",
    }


def fill_bundle(app_bundle: Path, *, display_name: str, bundle_id: str) -> None:
    if app_bundle.exists():
        shutil.rmtree(app_bundle)

    macos_dir = app_bundle / "Contents" / "MacOS"
    res_dir = app_bundle / "Contents" / "Resources"
    macos_dir.mkdir(parents=True, exist_ok=True)
    res_dir.mkdir(parents=True, exist_ok=True)

    release_dir = ROOT / "macos-metal" / ".build" / "release"
    spineforge = release_dir / "SpineForge"
    cli = release_dir / "spineforge-metal-cli"
    if not spineforge.exists() or not cli.exists():
        raise SystemExit(
            "Missing release binaries. On macOS run: ./scripts/build-mac.sh\n"
            f"Expected: {spineforge} and {cli}"
        )

    shutil.copy2(spineforge, macos_dir / "SpineForge")
    shutil.copy2(cli, macos_dir / "spineforge-metal-cli")
    (macos_dir / "SpineForge").chmod(0o755)
    (macos_dir / "spineforge-metal-cli").chmod(0o755)

    build_icns(res_dir / "AppIcon.icns")

    presets_dst = res_dir / "presets"
    shutil.copytree(ROOT / "public" / "presets", presets_dst)
    for preset_id in ["astral-forge", "sands-of-solara"]:
        proj_json = ROOT / "exports" / preset_id / f"{preset_id}.project.json"
        if proj_json.exists():
            shutil.copy2(proj_json, presets_dst / preset_id / f"{preset_id}.project.json")
            public_proj = ROOT / "public" / "presets" / preset_id / f"{preset_id}.project.json"
            shutil.copy2(proj_json, public_proj)

    with (app_bundle / "Contents" / "Info.plist").open("wb") as f:
        plistlib.dump(make_info_plist(display_name=display_name, bundle_id=bundle_id), f)

    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app_bundle)], check=True)
    print(f"Packaged and signed native macOS Metal app -> {app_bundle}")


def package_app() -> None:
    fill_bundle(
        APP_BUNDLE,
        display_name="Kinetic Pro",
        bundle_id="com.apple-style.kineticpro.metal",
    )
    # Keep SpineForge.app as a compatibility alias for older docs/scripts.
    if LEGACY_BUNDLE.exists():
        shutil.rmtree(LEGACY_BUNDLE)
    shutil.copytree(APP_BUNDLE, LEGACY_BUNDLE)
    legacy_plist = LEGACY_BUNDLE / "Contents" / "Info.plist"
    with legacy_plist.open("rb") as f:
        lp = plistlib.load(f)
    lp["CFBundleName"] = "SpineForge"
    lp["CFBundleDisplayName"] = "SpineForge Studio"
    lp["CFBundleIdentifier"] = "com.spineforge.macos.metal"
    with legacy_plist.open("wb") as f:
        plistlib.dump(lp, f)
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(LEGACY_BUNDLE)], check=True)
    print(f"Also refreshed legacy alias -> {LEGACY_BUNDLE}")


if __name__ == "__main__":
    package_app()
