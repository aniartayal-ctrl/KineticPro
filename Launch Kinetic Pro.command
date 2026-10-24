#!/bin/zsh
# Double-click in Finder to launch the native Kinetic Pro macOS app.
# No browser, Node, or localhost server required.
cd "$(dirname "$0")"

echo "=== Kinetic Pro — Native macOS Metal App ==="

APP="Kinetic Pro.app"
if [ ! -d "$APP" ]; then
  APP="SpineForge.app"
fi

if [ ! -d "$APP" ]; then
  echo "[ERROR] Kinetic Pro.app not found next to this launcher."
  echo "        On an Apple Silicon Mac, rebuild with: ./scripts/build-mac.sh"
  exit 1
fi

# Clear Gatekeeper quarantine (common after unzipping from GitHub) and ensure binaries are executable.
xattr -cr "$APP" 2>/dev/null || true
chmod +x "$APP/Contents/MacOS/SpineForge" "$APP/Contents/MacOS/spineforge-metal-cli" 2>/dev/null || true

# Re-seal the ad-hoc signature when a resource (e.g. the app icon) changed after signing.
if ! codesign --verify --deep "$APP" >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 && echo "[OK] Re-signed $APP (ad hoc)"
  touch "$APP"
fi

echo "[OK] Opening native Apple Metal studio: $APP"
open "$APP"
echo "Done. Kinetic Pro is a standalone macOS app — not a web page."
