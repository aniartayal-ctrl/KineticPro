# Kinetic Pro — Official User Manual & Artist-to-Unity Guide

Welcome to **Kinetic Pro**, the standalone 2D Mesh, Skeletal Rigging, Weight-Painting, and Slot Game Animation Suite powered by **Apple Metal GPU acceleration** and **Zero-Dependency Unity Integration**.

---

## 1. The 30-Second Quick Start (3 Clicks from Art to Unity)

If you have a character or slot symbol and want it meshed, rigged, animated with physics, and exported for Unity immediately:

1. **Step 1 — Load or Import Your Art**
   - Pick a built-in `.psd` character preset from the top-left document selector (`Astral Forge.psd` or `Sands of Solara.psd`), **or** click **`Import PSD`** to upload your own layered `.psd` or flat `.png` / `.webp` file.
2. **Step 2 — Click `1-Click Auto-Rig` (or press `A`)**
   - Opens the **1-Click Auto Studio** on the left.
   - Kinetic Pro automatically inspects your artwork, infers mass, center of mass (`COM`), and part materials (`heavy metal`, `cloth silk`, `hair plume`, `organic limb`), generates contour Delaunay triangle meshes, solves 4-bone normalized skin weights, and synthesizes **14 famous slot & game animations**.
   - Click any of the **14 Action Cards** (e.g., *Olympus Sky-Bolt Cast*, *Mega Win 30× Slam*, *Payline Symbol Pop*, *Treasure Chest Burst*) to preview it live.
3. **Step 3 — Click `Export` (or press `⌘E`)**
   - Generates and previews your 3-way production bundle:
     - **Zero-Dependency Unity C# Runtime** (`<id>.sfrig.json` + `<id>.png` Atlas)
     - **Spine 4.2 Compatible Bundle** (`<id>.spine.json` + `<id>.atlas.txt` + `<id>.png`)
     - **Baked Flipbook Sprite Sheet & Transparent `.WebM` Video** (`<id>-sheet.png` + `<id>.sprites.json`)

---

## 2. Workspace Layout (Designed for Photoshop Users)

Kinetic Pro uses an **iOS 26 / macOS 26 Liquid Glass** spatial layout modeled directly on Adobe Photoshop so artists feel at home on day one:

| Zone | Location | What It Does |
| :--- | :--- | :--- |
| **1. Tool Rail** | Far-Left Vertical Bar | Single-key tools (`A`, `V`, `P`, `M`, `B`, `W`, `K`) + Viewport Overlay Toggles (`Bones`, `Grid`, `Heat`, `Onion`, `Arcs`, `Trail`, `3D Lit`, `Box2D`, `Solo`). |
| **2. Tool Options Bar** | Top Center Bar | Dynamically changes to show the settings for whichever tool is active (just like Photoshop's top options bar). |
| **3. 1-Click Auto Studio** | Left Floating Dock (in `A` mode) | Visual Physics Learner, Elemental VFX, 2.5D Parallax, Voice Lip-Sync, Batch 8-Symbol Auto-Rigger, 12 Principles Dials, and 14 Game Actions. |
| **4. Properties & Layers** | Right-Center Floating Dock | **Top half**: Transform (`Angle °`, `ΔX`, `ΔY`), Visual Bezier Curve Graph, and 3D Normal Relight. **Bottom half**: Tabbed **Layers** (with Eye `●` visibility & `↑`/`↓` z-order), **Bones**, and **History** (`⌘Z`). |
| **5. AI Rigging Copilot** | Extreme-Right Floating Dock | Natural-language copilot (**Claude** with native tool use, **ChatGPT**, **Grok**, or the offline **Built-in** planner) that runs real tool calls on your rig, mesh, weights, animation and exporter, sees each result, and remembers the conversation. |
| **6. Video Timeline & Dope Sheet** | Bottom Floating Dock | Play/Pause (`Space`), Clip selector, Time scrubber with `⚡ OnHit` / `✨ SpawnVFX` Unity event flags, `+ Event` button, `Bake Springs`, and expandable multi-bone diamond **Dope Sheet**. |

---

## 3. Keyboard Shortcuts (Spine Defaults)

Kinetic uses [Spine's default hotkeys](https://esotericsoftware.com/spine-cheat-sheet). Press **`?`** in the app for the complete list (generated from `src/core/keymap.ts`).

| Shortcut | Action | Notes |
|---|---|---|
| **`B` / `C` / `V` / `X`** | **Pose / Rotate / Translate / Scale** | Drag a bone to key it at the current frame. `⇧` snaps rotation to 15°, locks translation to an axis, or scales uniformly. Right-click the canvas to return to the previous tool. |
| **`N`** | **Bones & IK** (Spine's Create) | Drag bone joints to move their bind pivots; skinned meshes re-weight. |
| **Arrows** | **Nudge** | 1 px, 1° or 1% with the active tool (`⇧` = 10×). |
| **`K`** / **`⇧⌘L`** | **Key selection / every bone** | `L` and `⌘L` key the selection too (Kinetic keys whole bones). |
| **`D` / `A`** | **Play forward / backward** | Press again to stop. `Space` also plays or pauses. |
| **`Q` / `E`** | **Start / last key** | |
| **`W` / `S`** | **Next / previous key** | |
| **`R` / `F`** | **Next / previous frame** | `⇧` jumps 10 frames. `⌘R` toggles looping. |
| **`H`**, **`+` / `−`** | **Hide layer, draw order** | `⇧+` / `⇧−` move five places. |
| **`⌘Z` / `⇧⌘Z` / `⌘Y`** | **Undo / Redo** | Up to 100 steps; each drag or brush stroke is one step. |
| **`⌘S` / `⌘O` / `⌘E`** | **Save / Open / Export** | Saves to `projects/<id>/` with the last 10 versions in `backups/`. |
| **`O`, `⇧A`, `M`, `⇧W`, `⇧L`** | **Import, Auto Rig, Mesh, Weight Paint, Warp** | Kinetic-only tools. `[` / `]` resize the brush. |
| **`I`, `⌘K`, `T`, `G`, `Tab`** | **Inspector, Copilot, Dope sheet, Graph, Hide panels** | Kinetic-only panels. |
| **`F1`**, **`?`** | **Instant tooltips, Help** | |

## 4. Deep-Dive Feature Guide

### A. Visual Physics Learner & 12 Principles of 2D Animation
- **Visual Physics Learner**: Inspects every part's bounding box, area share, and slenderness ($h/w$) to classify its material (`heavy metal`, `cloth silk`, `hair plume`, `organic limb`, `crystal energy`, `gold medallion`) and automatically sets `stiffness`, `damping`, `wind`, and `follow` ratios.
- **12 Principles Live Dials**:
  - **Squash & Stretch**: Enforces area conservation ($s_x \cdot s_y \approx 1.0$) during crouches, leaps, and symbol pops.
  - **Anticipation**: Controls the reverse wind-up depth before every strike, cast, or jump.
  - **Overlap / Trail**: Controls hierarchical phase delay so the hips/chest lead and extremities (arms, weapon, cape, hair) follow naturally.
  - **Exaggeration**: Scales key pose extremes and overshoot arcs.

### B. Batch 8-Symbol Auto-Rigger
- In **Auto Studio (`A`)**, find the **Batch 8-Symbol Auto-Rigger** grid (`H1`, `H2`, `H3`, `L1`, `L2`, `L3`, `WILD`, `SCATTER`).
- Click any symbol icon to immediately rig, mesh, weight, and animate that symbol with all 14 clips (`symbol-win`, `wild-expand`, `scatter-trigger`). Click **`Load Hero Rig`** to return to your main character.

### C. 2.5D Parallax Look-At, Voice Lip-Sync & 3D Normal Relighting
- **2.5D Turn**: Move your cursor over the character—foreground parts (`head`, `weapon`, `forearm`) shift forward while background parts (`cape`, `hair`, `arm-back`) shift in inverse Z-parallax.
- **Voice Lip-Sync**: Click any **`🎙`** voice chip (`BY THE ASTRAL FORGE!`, `FEEL THE THUNDER!`, `SENSATIONAL MEGA WIN!`) to keyframe jaw/head/chest syllables automatically.
- **3D Normal Relight**: In the **Properties** panel, drag the **3D Normal Relight** angle (`-180°` to `+180°`) and intensity sliders to relight 2D painted sprites in real time using GPU Sobel surface normals.

---

## 5. Unity Integration Guide (3 Supported Workflows)

When you click **`Export Unity`** and download `<id>-unity-bundle.zip`, you get three complete integration folders:

### Option 1: Zero-Dependency Unity C# Runtime (No Spine License Needed)
1. Copy `unity-package/com.spineforge.runtime` into your Unity project's `Packages/` folder (or link it in `Packages/manifest.json`).
2. Drag the exported `unity-spineforge-runtime/<id>.sfrig.json` and `<id>.png` into your Unity `Assets/` folder.
3. In Unity, right-click `<id>.sfrig.json` → **`Assets → SpineForge → Build Prefab from Selected .sfrig.json`**.
4. Drop the generated Prefab into your scene! Control it from C#:
   ```csharp
   using SpineForge;
   using UnityEngine;

   public class HeroController : MonoBehaviour
   {
       [SerializeField] private SpineForgeAnimator animator;

       void Start()
       {
           animator.Play("strike");
           animator.SetSkin("ascended"); // "default", "awakened", "ascended"
           animator.OnAnimationEvent += ev =>
           {
               Debug.Log($"Event {ev.name} ({ev.stringParam}) at {ev.time}s");
           };
       }
   }
   ```

### Option 2: Spine 4.2 Official Runtime (`spine-unity`)
1. Drag the files from `spine-4.2/` (`<id>.json`, `<id>.atlas.txt`, `<id>.png`) into any Unity project with `spine-unity 4.2` installed.
2. `spine-unity` automatically creates the `SkeletonDataAsset` with all bones, weighted Delaunay meshes, IK constraints, 3 skin tiers, events, and 14 baked animations.

### Option 3: Baked Flipbook Sprite Sheet (`unity-spritesheet/`)
1. Drag `<id>-sheet.png` and `<id>.sprites.json` into Unity for ultra-lightweight `SpriteRenderer` / `UI Image` flipbook playback.

---

## 6. Native macOS Apple Metal App (primary product)

Kinetic Pro is a **native macOS application**. Day-to-day work happens in **`Kinetic Pro.app`** — not in a browser.

- **Launch**:
  ```bash
  open "Kinetic Pro.app"
  # or double-click:
  open "Launch Kinetic Pro.command"
  ```
- **File menu**: Import Art (O), Open Project (⌘O), Save (⌘S), Save As (⇧⌘S), Export (⌘E). Projects land in `projects/<id>/` next to the app (or under Documents/KineticPro when installed to `/Applications`). Drop a `.project.json` or PNG/WebP onto the app icon to open/import.
- **Rebuild** (after pulling Swift changes; requires Apple Silicon + Xcode):
  ```bash
  ./scripts/build-mac.sh
  ```
- **Headless Apple Metal GPU Exporter** (`~219ms` for 187+ frames):
  ```bash
  "./Kinetic Pro.app/Contents/MacOS/spineforge-metal-cli" export-all \
    ./exports/astral-forge/astral-forge.project.json \
    ./public \
    ./exports/astral-forge-native-metal 220 12
  ```

The optional Next.js studio (`npm run dev:web`) is for automated tests and CI only.
