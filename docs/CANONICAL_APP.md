# Canonical Kinetic Pro app

**Only this app is Kinetic Pro:**

`Kinetic Pro.app` — Claude studio UI in a native macOS WKWebView shell  
(`macos-metal/Sources/KineticProStudio`).

**How to recognize the right app**

- Window shows **Visual Physics Learner** and **HEAVY TITAN**
- **Batch 8-Symbol Auto-Rigger**, Copilot
- Marker file: `Kinetic Pro.app/Contents/Resources/CANONICAL_APP.txt`
- Bundle id: `com.apple-style.kineticpro.studio`
- Executable: `Contents/MacOS/KineticPro`

**Never treat these as Kinetic Pro**

- `SpineForge.app` (deleted; do not recreate)
- SwiftUI Metal prototype (`macos-metal/Sources/SpineForgeMacApp`)
- Opening `http://127.0.0.1:3460` in Safari/Chrome as the product
- Copies under `~/Downloads/Kinetic-main/` or other folders

**Clean rebuild**

```bash
./scripts/build-mac.sh
open "Kinetic Pro.app"
```
