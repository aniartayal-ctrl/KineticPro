# Kinetic Pro — native macOS shell

**Canonical product:** `KineticPro` → packaged as `../Kinetic Pro.app`

That binary is the **Claude studio** (Visual Physics Learner / HEAVY TITAN) inside a WKWebView shell (`Sources/KineticProStudio`).

| Target | Role |
| --- | --- |
| `KineticProStudio` → product `KineticPro` | **ONLY** UI shipped as `Kinetic Pro.app` |
| `SpineForgeMetalCore` | Metal CLI helpers / exporters |
| `spineforge-metal-cli` | Headless GPU export CLI |

`Sources/SpineForgeMacApp` is a discarded SwiftUI Metal prototype. It is **not** a package product and must never be opened as Kinetic Pro.

## Clean build

```bash
./scripts/build-mac.sh
open "../Kinetic Pro.app"
```

See `../docs/CANONICAL_APP.md`.
