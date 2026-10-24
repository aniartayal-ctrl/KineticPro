# Kinetic Pro — Native macOS (Apple Metal)

This package is the **primary product**: a SwiftUI + Metal studio that ships as `Kinetic Pro.app`.

| Target | Role |
| --- | --- |
| `SpineForgeMacApp` → product `SpineForge` | Native studio UI (`Kinetic Pro.app`) |
| `SpineForgeMetalCore` | Metal renderer, Vision auto-rig, exporters |
| `spineforge-metal-cli` | Headless GPU export CLI |

## Build (macOS only)

```bash
# From the repo root
./scripts/build-mac.sh
```

Requires macOS 14+, Xcode / Swift 5.10+, and Apple Silicon (or a Metal-capable Mac).

## Layout

```
Sources/SpineForgeMacApp/     SwiftUI workspace, File menu, MTKView
Sources/SpineForgeMetalCore/  Shaders, solver, Vision, Unity/Spine export
Sources/SpineForgeMetalCLI/   Command-line exporter
```

The Next.js app under `src/` is optional (CI / UI tests). Artists run the `.app`, not a browser.
