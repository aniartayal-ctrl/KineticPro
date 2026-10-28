#!/usr/bin/env bash
# Clean-build the CANONICAL Kinetic Pro.app (Claude studio WKWebView shell).
# Usage: ./scripts/build-mac.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-mac.sh must run on macOS with Xcode / Swift 5.10+."
  exit 1
fi

echo "==> Quit any running Kinetic / SpineForge processes"
pkill -x KineticPro 2>/dev/null || true
pkill -x SpineForge 2>/dev/null || true
lsof -ti :3460 | xargs kill -9 2>/dev/null || true

echo "==> Remove other / legacy app bundles (only Kinetic Pro.app is allowed)"
rm -rf "SpineForge.app"
rm -rf "Kinetic Pro.app"

echo "==> Clean Swift + Next build caches"
rm -rf macos-metal/.build
rm -rf .next

echo "==> Brand assets (AppIcon.icns)"
if command -v npm >/dev/null 2>&1; then
  npm run brand
else
  echo "npm not found — using existing public/brand/AppIcon.icns"
fi

echo "==> Swift release: KineticPro (Claude studio shell) + Metal CLI"
cd "$ROOT/macos-metal"
swift build -c release --product KineticPro
swift build -c release --product spineforge-metal-cli
cd "$ROOT"

echo "==> Next.js production build (served by the native shell on :3460)"
if command -v npm >/dev/null 2>&1; then
  npm run build
else
  echo "npm not found — shell will fall back to npm run dev at launch"
fi

echo "==> Package the ONE Kinetic Pro.app"
python3 scripts/package-mac-app.py

# Final guard: no SpineForge.app must exist
if [[ -d SpineForge.app ]]; then
  echo "[ERROR] SpineForge.app still present after package — refusing."
  exit 1
fi
if [[ ! -f "Kinetic Pro.app/Contents/Resources/CANONICAL_APP.txt" ]]; then
  echo "[ERROR] Canonical marker missing — wrong package."
  exit 1
fi

echo "==> Ready: open \"Kinetic Pro.app\"  (Claude studio — Visual Physics / HEAVY TITAN)"
