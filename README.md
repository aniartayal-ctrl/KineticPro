<p align="center"><img src="public/brand/kinetic-icon.svg" width="112" alt="Kinetic Pro"></p>

# Kinetic Pro — Apple Metal 2D Mesh, Rigging & Slot Game Animation Suite for Unity

**Kinetic Pro** is a **native macOS app** (`Kinetic Pro.app` only — there is no SpineForge.app). It ships the **Claude studio** (Visual Physics Learner, HEAVY TITAN, Batch 8-Symbol Auto-Rigger, Copilot) inside a native window. Do not open browser demos or any SwiftUI Metal prototype as “Kinetic Pro.”

📖 **[Read the Complete User Manual (`USER_MANUAL.md`)](./USER_MANUAL.md)**

![Kinetic Pro — graph editor with bezier handles](./docs/screenshots/studio-graph-editor.webp)

![Kinetic Pro — studio with performance budget](./docs/screenshots/studio-budget.webp)

![Kinetic Pro — bones, copilot and keyframe sheet](./docs/screenshots/studio-rig-timeline.webp)

![Kinetic Pro — Interactive In-App User Manual & 3-Click Guided Tour](./docs/screenshots/user-manual-tour.webp)

---

## Core Capabilities

1. **1-Click Auto Studio (`A`) & Visual Physics Learner**
   - Inspects character/symbol silhouette geometry, aspect ratio, and part layout to automatically infer **Mass (`kg`)**, **Center of Mass (`COM`)**, **Gravity/Drag**, and per-part material types (`heavy_metal`, `cloth_silk`, `hair_plume`, `organic_limb`, `crystal_energy`, `gold_medallion`), configuring real-time spring stiffness, damping, wind sway, and `follow` inertia.
   - **Apple Vision Pose Detection (`VNDetectHumanBodyPoseRequest`)** on macOS for automatic anatomical bone placement.

2. **12 Principles of 2D Animation Engine & 14 Built-In Famous Game Actions**
   - Live dials for **Volume-Preserving Squash & Stretch** ($s_x \cdot s_y \approx 1.0$), **Anticipation**, **Follow-Through & Overlapping Action**, and **Exaggeration**.
   - **14 Built-in Animations**: `idle`, `anticipation`, `cheer` (15×), `strike` (30×), `power` (45×), `triumph` (60×), `bow`, `zeus-bolt` (Olympus Sky Cast), `berserk-spin` (Whirlwind Cleave), `hit-react`, `symbol-win`, `wild-expand`, `scatter-trigger`, and `chest-open`.

3. **Batch 8-Symbol Auto-Rigger (`src/core/batch-symbols.ts`)**
   - One-click open any of the theme's 8 slot symbols (`H1`–`H3`, `L1`–`L3`, `WILD`, `SCATTER`) as its own auto-rigged, meshed, weighted project with win / expand / scatter clips.

4. **Contour Delaunay Mesher, GPU Weight Painter & Liquify FFD (`W`)**
   - Alpha-silhouette marching contour tracer + Ramer-Douglas-Peucker simplifier + Steiner crease vertices + Delaunay triangulation.
   - **Apple Metal Compute Kernel (`compute_auto_weights`)** & Metal 4-bone Linear Blend Skinning, interactive Weight Brush (`B`), Liquify FFD vertex sculpt (`W`), Onion Skinning, Motion Arcs, Weapon Slash Trails, and 3D Normal-Map Point Relighting.

5. **Triple Unity & Spine 4.2 Export Pipeline + Zero-Dependency Unity C# Runtime (`com.spineforge.runtime`)**
   - **Zero-Dependency Unity Runtime**: Exports `<id>.sfrig.json` + `<id>.png` with `SpineForgeAnimator.cs` (`MeshFilter`/`MeshRenderer`, 4-bone LBS, `PolygonCollider2D` hitboxes, multi-skins, and `OnAnimationEvent` triggers)—no Spine license required.
   - **Spine 4.2 Standard**: Exports `<id>.spine.json` + `<id>.atlas.txt` + `<id>.png`. By default the export is **native**: authored easing curves are kept, spring bones become Spine 4.2 **physics constraints**, follow bones become **transform constraints**, and IK mix keys become IK timelines, so the file stays editable in Spine. Pass `physics: "bake"` to sample everything into plain keys for pre-4.2 runtimes. Every build is round-tripped through Esoteric's official `spine-core` 4.2 runtime in the test suite.

6. **Performance Budget (Inspector → Budget)**
   - Measures the real atlas pack, texture memory, mesh vertices, bones per vertex, draw-call breaks and constraint count against Symbol / Mobile / Desktop targets, with one-line advice for anything over. Targets are studio rules of thumb; adjust them in `src/core/budget.ts`.
   - **Baked Flipbook Sprite Sheet & Transparent `.WebM` Video**: Bakes multi-clip sprite sheets (`<id>-sheet.png` + `<id>.sprites.json`) on the Apple Metal GPU in ~200ms.

---

## Quick Start (native macOS)

Kinetic Pro ships as **`Kinetic Pro.app`**. Double-click it, or:

```bash
# Launch (also clears Gatekeeper quarantine after a GitHub unzip)
open "Launch Kinetic Pro.command"
# or:
open "Kinetic Pro.app"
```

The app starts its studio server itself. Use **`Kinetic Pro.app`** — never `SpineForge.app` (removed) and never a browser window as the product.

### Rebuild the Mac app (clean)

```bash
./scripts/build-mac.sh
# → cleans caches, builds KineticPro shell + Next.js, packages Kinetic Pro.app only
```

### Developer tests (not the product UI)

```bash
npm run verify:all
npm run export:cli -- all
```

### Copilot: run the whole studio in plain words

Open with **⌘K**. Every feature is a copilot tool (41, `src/core/copilot/tools.ts`): inspect, selection, tools, overlays, playback, auto-rig (with body archetypes), bones, pivots, IK, physics, bone locks, mesh density and weight solvers, warp reset, draw order, layer visibility, keys (absolute or relative, by frame), key deletion, breakdowns, pose copy/paste, curves, retiming, fps, looping, clip generation and its principle settings, physics baking, Unity events (add and remove), coach review and fixes, skins, VFX, lip-sync, symbol rigs, budget, undo/redo, save, open project and export. Hands-on only: brush strokes (weight painting, warp), the parallax and light sliders, and video recording.

**Claude (recommended).** Claude calls the tools natively and sees each result before its next step, so it can inspect values, read the coach's suggestions, recover from a wrong name, and tell you what changed. It remembers the conversation ("now do the same on the cape", "undo that"). **Stop** (or Esc) halts between steps; **New** clears the conversation. Every change is one undo step.

> tilt the head 15 degrees at frame 6, ease it, and add a wind-up before the swing

**Built-in planner (offline).** No key, no network. Understands chained steps ("…, then …"), explicit values ("rotate the weapon -30 degrees at frame 12", "nudge the hips 5 px left", "squash it 20%"), and answers questions from the rig ("which bones have physics?") without changing anything.

Each step reports ✓ or ✕ with the reason; invalid names or values are rejected without touching the rig.

**Animation coach.** The copilot reviews the open clip against the principles of animation and shows cue cards with one-click fixes: slow in and slow out (eases linear moves), anticipation (adds a wind-up before the biggest move), follow-through (overshoot and settle), squash and stretch on impact, secondary action (physics on capes, hair, tails), exaggeration, keys between frames, loop seams, and even timing. The badge on the copilot button counts open suggestions. "Fix everything" applies them all as one undo step.

### Projects

**⌘S** (native Mac app or web studio) saves to `projects/<id>/<id>.project.json` in the Kinetic folder (set `KINETIC_PROJECTS_DIR` to put it elsewhere, e.g. a synced drive). The shipped templates in `public/presets` are never written. Saves are atomic; the web studio also keeps the previous 10 versions in `projects/<id>/backups/`. Art imports go to `projects/<id>/assets/`.

**⌘O** opens a saved project. In the Mac app, use **File → Open Project…** or drop a `.project.json` onto `Kinetic Pro.app`. Opening with unsaved changes asks to Save, Don't Save or Cancel. The `projects/` folder is git-ignored.

### Autosave and recovery

**Native Mac app:** ⌘S writes to `projects/<id>/`; quitting with edits asks Save / Don’t Save / Cancel.

**Optional web studio:** Work is autosaved in the browser every 5 minutes when something changed, and immediately when the tab is hidden or closed or an error occurs. On the next launch the studio offers to restore it.

### Testing

`npm test` runs 97 unit tests: Spine 4.2 runtime round-trips, the copilot planner, every coach fix, the copilot executor, and an end-to-end Claude conversation through the real agent loop and relay against a strict mock of the Messages API that rejects malformed tool use.

`npm run test:ui` (with the studio running) clicks through every tool, overlay, tab, clip, shortcut and copilot command, drives Claude through the UI against the mock (start the studio with `KINETIC_ANTHROPIC_BASE_URL=http://127.0.0.1:4599 ANTHROPIC_API_KEY=mock`), imports a character, checks the unsaved-changes guard, autosave and restore, then runs a seeded random-click pass. `ONLY=claude,import` runs a subset.

`npm run eval:copilot` runs 32 plain-language requests against a real model and checks the rig state each should produce (Claude when `ANTHROPIC_API_KEY` is set; `-- --provider planner` for the offline baseline).

### App icon

The icon draws the K's stem and leg, leaves the upper arm to the eye, and puts the AI spark where it would end. `scripts/brand.mjs` holds its geometry; `npm run brand` rewrites every size from it: favicon, Apple touch icon, title bar, brand marks and the Mac app's `AppIcon.icns`. After icon or Swift changes, rebuild on a Mac with `./scripts/build-mac.sh` (or re-sign with `Launch Kinetic Pro.command` if only resources changed).

### AI Copilot keys and models

Copy `.env.example` to `.env.local` (git-ignored), set `ANTHROPIC_API_KEY`, and restart the studio. The copilot then picks Claude on its own and shows "server key" next to the model. You can also paste a key under **Key** (kept in that tab only) and pick a model there: `claude-sonnet-5-5` (default), `claude-opus-5-5` (strongest) or `claude-haiku-5-5` (fastest). `KINETIC_CLAUDE_MODEL` sets the default. ChatGPT and Grok work the same way with `OPENAI_API_KEY` / `XAI_API_KEY` and `KINETIC_OPENAI_MODEL` / `KINETIC_XAI_MODEL`.

Keys stay on your machine and go only to the provider; each provider tab keeps its own key. The studio's write endpoints (save, import, export, copilot) refuse requests from other websites, so a page open in another tab cannot overwrite projects or spend your key. Without a key the request runs on the built-in planner and says so; other failures (bad key, rate limit, unknown model) explain the fix and leave the rig as it was.

### Importing characters

**Import** (O) takes a layered `.psd` (layers and draw order kept, best) or a flat `.png`/`.webp`. The character opens auto-rigged, meshed, weighted and animated; save it with ⌘S. Flat images are cut with a pose template (a front-facing hero with a weapon in the right hand), so other poses should come in as PSD layers. The cutter needs Python 3:

```bash
python3 -m venv vision/.venv && vision/.venv/bin/pip install -r vision/requirements.txt
```

The studio uses `vision/.venv` automatically (or `KINETIC_PYTHON`).

### Keyboard (Spine defaults)

Shortcuts follow [Spine's default hotkeys](https://esotericsoftware.com/spine-cheat-sheet), so Spine muscle memory works. Kinetic-only tools use keys Spine leaves free. The full, always-current list is in the app (**?** → Shortcuts), generated from `src/core/keymap.ts`.

| Spine key | Action | Spine key | Action |
| --- | --- | --- | --- |
| B | Pose tool | D / A | Play forward / backward (press again to stop) |
| C | Rotate (⇧ 15° steps) | Q / E | Jump to start / last key |
| V | Translate (⇧ axis lock) | W / S | Next / previous key |
| X | Scale (⇧ uniform) | R / F | Next / previous frame (⇧ = 10 frames) |
| N | Bones & IK (Spine's Create) | ⌘R | Loop on / off |
| ← → ↑ ↓ | Nudge (⇧ = 10×) | H | Hide / show selected layer |
| K, ⌘L | Key selected bone | + / − | Draw order up / down (⇧ = 5) |
| L | Key active transform (same as K: Kinetic keys whole bones) | ⌘Z / ⇧⌘Z, ⌘Y | Undo / redo |
| ⇧⌘L | Key every bone | ⌘S / ⌘O / ⌘E | Save / open / export |
| ⌘C / ⌘V | Copy / paste pose | F1 | Instant tooltips |
| Right-click canvas | Previous tool | | |

| Kinetic key | Action | Kinetic key | Action |
| --- | --- | --- | --- |
| O | Import | I | Inspector |
| ⇧A | Auto Rig | ⌘K | Copilot |
| M | Mesh | T / G | Dope sheet / graph editor |
| ⇧W | Weight Paint (`[` `]` brush size) | Tab | Hide all panels |
| ⇧L | Warp | Space | Play / pause (in Spine, Space deselects) |

Dope sheet and graph editor (Spine-matched): drag a key to move it on frames, ⇧-drag to move freely, ⌥-drag to move it with every later key, double-click to delete; ⇧-drag the playhead to scrub between frames. Not yet available: shear (Z), set parent (P), rename (F2), selection history (PgUp/PgDn); pressing them says so.

### Animation tools

- **Graph editor (G)**: rotation, move and scale curves per bone with bezier handles, frame-snapped key dragging (⇧ free, ⌘ locks an axis, ⌥ moves later keys) and curve presets. One curve per key, shared by its channels.
- **Dope sheet (T)**: drag keys to retime on whole frames (⇧ free, ⌥ moves later keys too), click to jump, double-click or Delete to remove.
- **Breakdown**: key every bone (⇧-click: selected bone) at any percentage between its neighbouring poses, including overshoot.
- **Pose clipboard**: ⌘C copies the full pose at the playhead, ⌘V pastes it as one undo step.
- **Clip timing**: length (optionally stretching keys and events), 24/30/60 fps, loop.
- Every drag is one undo step. Unity export bakes each clip at its own frame rate (at least 30 Hz) so short, snappy timing survives.
