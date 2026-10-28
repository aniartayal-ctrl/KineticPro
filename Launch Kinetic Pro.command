#!/bin/zsh
# Launch the ONLY Kinetic Pro app: Claude studio in a native macOS window.
# Do not open SpineForge.app, browsers, or the SwiftUI Metal prototype.
cd "$(dirname "$0")"

echo "=== Kinetic Pro — Claude Studio (native shell) ==="

APP="Kinetic Pro.app"
if [ ! -d "$APP" ]; then
  echo "[ERROR] Kinetic Pro.app not found. Rebuild with: ./scripts/build-mac.sh"
  exit 1
fi

# Refuse legacy / wrong bundles sitting next to us.
if [ -d "SpineForge.app" ]; then
  echo "[WARN] Removing confusing legacy SpineForge.app …"
  rm -rf "SpineForge.app"
fi

MARKER="$APP/Contents/Resources/CANONICAL_APP.txt"
if [ ! -f "$MARKER" ]; then
  echo "[ERROR] This Kinetic Pro.app is missing CANONICAL_APP.txt — wrong build."
  echo "        Rebuild with: ./scripts/build-mac.sh"
  exit 1
fi

xattr -cr "$APP" 2>/dev/null || true
chmod +x "$APP/Contents/MacOS/KineticPro" 2>/dev/null || true
chmod +x "$APP/Contents/MacOS/spineforge-metal-cli" 2>/dev/null || true

if ! codesign --verify --deep "$APP" >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 && echo "[OK] Re-signed $APP (ad hoc)"
  touch "$APP"
fi

echo "[OK] Opening CANONICAL Kinetic Pro (Visual Physics / HEAVY TITAN studio) …"
open "$APP"
echo "Done."
