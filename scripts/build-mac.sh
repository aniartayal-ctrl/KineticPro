#!/usr/bin/env bash
# Build and package Kinetic Pro.app on macOS (Apple Silicon / Metal).
# Usage: ./scripts/build-mac.sh
# Must run on Amit's Mac (or any Darwin host with Xcode) — not on Linux cloud VMs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-mac.sh must run on macOS with Xcode / Swift 5.10+."
  echo "On Amit's MacBook Air (KineticPro worker):"
  echo "  cd ~/KineticPro && git checkout cursor/native-macos-app-f381 && ./scripts/build-mac.sh"
  exit 1
fi

echo "==> Brand assets (AppIcon.icns)"
if command -v npm >/dev/null 2>&1; then
  npm run brand
else
  echo "npm not found — using existing public/brand/AppIcon.icns"
fi

echo "==> Swift release build (macos-metal)"
cd "$ROOT/macos-metal"
swift build -c release --product SpineForge
swift build -c release --product spineforge-metal-cli
cd "$ROOT"

echo "==> Package Kinetic Pro.app"
python3 scripts/package-mac-app.py

echo "==> Ready: open \"Kinetic Pro.app\"  (or ./Launch\\ Kinetic\\ Pro.command)"
