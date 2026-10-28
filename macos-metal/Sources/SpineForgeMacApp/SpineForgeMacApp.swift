import SwiftUI
import AppKit
import Metal
import MetalKit
import UniformTypeIdentifiers
import SpineForgeMetalCore

// MARK: - iOS 26 / macOS 26 Liquid Glass Material Modifier

public struct LiquidGlassModifier: ViewModifier {
    var cornerRadius: CGFloat = 26
    var isPill: Bool = false

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: isPill ? 999 : cornerRadius, style: .continuous)
        content
            .background(
                ZStack {
                    shape.fill(.ultraThinMaterial)
                    shape.fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.15),
                                Color.cyan.opacity(0.045),
                                Color(red: 0.03, green: 0.06, blue: 0.13).opacity(0.48)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                }
            )
            .overlay(
                shape.strokeBorder(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.52),
                            Color.cyan.opacity(0.26),
                            Color.white.opacity(0.08)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1.0
                )
            )
            .shadow(color: Color.black.opacity(0.68), radius: 24, x: 0, y: 14)
    }
}

extension View {
    public func liquidGlass(cornerRadius: CGFloat = 26, isPill: Bool = false) -> some View {
        modifier(LiquidGlassModifier(cornerRadius: cornerRadius, isPill: isPill))
    }
}

public struct AiChatEntry: Identifiable {
    public let id = UUID()
    public var role: String // "user" | "assistant"
    public var provider: String
    public var text: String
    public var toolCalls: [String]
}

// MARK: - Studio ViewModel Driving 100% Native Apple Metal Pipeline + AI Agent Copilot

@MainActor
public final class MacStudioViewModel: ObservableObject {
    public enum StudioMode: String, CaseIterable {
        case importPsd = "Import PSD (O)"
        case autoStudio = "Auto Studio (A)"
        case animate = "Move / Pose (V)"
        case rig = "Bone Pin (P)"
        case mesh = "Puppet Mesh (M)"
        case weights = "Weight Brush (B)"
        case export = "Unity Export"
    }

    public enum OutlinerTab: String, CaseIterable {
        case layers = "Layers"
        case bones = "Bones"
    }

    public enum AiProvider: String, CaseIterable {
        case cursor = "Cursor"
        case claude = "Claude"
        case chatgpt = "ChatGPT"
        case grok = "Grok"
    }

    @Published public var project: SfProject
    @Published public var mode: StudioMode = .animate {
        didSet {
            NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default)
            if mode == .weights {
                showHeatmap = true
                showWireframe = true
                outlinerTab = .layers
            } else if mode == .mesh {
                showWireframe = true
                outlinerTab = .layers
            } else if mode == .export {
                bakeAndExportOnMetal(revealInFinder: false)
            }
            syncHeatmaps()
        }
    }

    @Published public var outlinerTab: OutlinerTab = .layers
    @Published public var dopeSheetExpanded: Bool = false
    @Published public var timelineAtTop: Bool = false
    @Published public var leftPaneOpen: Bool = true
    @Published public var showAiCopilot: Bool = true
    @Published public var showUserManualSheet: Bool = false
    @Published public var aiProvider: AiProvider = .cursor
    @Published public var aiPrompt: String = ""
    @Published public var aiMessages: [AiChatEntry] = [
        AiChatEntry(
            role: "assistant",
            provider: "Cursor",
            text: "Connected to Kinetic Pro Apple Metal Engine. Switch between Cursor, Claude, ChatGPT, or Grok—prompts execute real Metal GPU & rigging tool calls.",
            toolCalls: ["MCP Bridge linked to Apple Metal GPU + 12 bones & 7 layers"]
        )
    ]

    @Published public var selectedPreset: String = "astral-forge"
    @Published public var selectedBone: String = "arm" {
        didSet { syncHeatmaps() }
    }
    @Published public var selectedPart: String = "body"
    @Published public var activeClip: String = "strike"
    @Published public var currentTime: Float = 0.0
    @Published public var isPlaying: Bool = true
    @Published public var playbackSpeed: Float = 1.0

    // Viewport Overlays
    @Published public var showWireframe: Bool = true
    @Published public var showBones: Bool = true
    @Published public var showHeatmap: Bool = false {
        didSet { syncHeatmaps() }
    }
    @Published public var singleBoneThermalHeatmap: Bool = false {
        didSet { syncHeatmaps() }
    }
    @Published public var isolateSelectedPart: Bool = false

    // Weight Brush & Mesh Controls — default high to use more of the Metal working-set quota
    @Published public var meshDensity: String = "high"
    @Published public var gpuQuotaLine: String = ""
    @Published public var brushMode: String = "add"
    @Published public var brushRadius: Float = 65.0
    @Published public var brushStrength: Float = 0.45
    @Published public var hoverRigCursor: SIMD2<Float>? = nil
    @Published public var newBoneName: String = ""

    // Export Preview State
    @Published public var lastExportSummary: CompleteMetalExportSummary? = nil
    @Published public var exportedAtlasImage: NSImage? = nil
    @Published public var exportedSheetImage: NSImage? = nil

    // Status & GPU telemetry
    @Published public var gpuDeviceName: String = "Apple Metal GPU"
    @Published public var gpuUnifiedMemory: Bool = true
    @Published public var statusMessage: String = "120Hz ProMotion Apple Metal Pipeline Active"
    @Published public var history: [SfProject] = []
    @Published public var historyIndex: Int = 0
    @Published public var currentProjectURL: URL? = nil
    @Published public var isDirty: Bool = false

    public var renderer: MetalRigRenderer?
    public let workspaceRootURL: URL
    public let bundledPublicRootURL: URL
    public var publicRootURL: URL

    public var projectsDirURL: URL {
        if let env = ProcessInfo.processInfo.environment["KINETIC_PROJECTS_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        return workspaceRootURL.appendingPathComponent("projects")
    }

    public init() {
        let envRoot = ProcessInfo.processInfo.environment["KINETIC_ROOT"] ?? ProcessInfo.processInfo.environment["SPINEFORGE_ROOT"]
        let bundleParent = Bundle.main.bundleURL.deletingLastPathComponent()
        let fallbackRoot: URL
        if FileManager.default.isWritableFile(atPath: bundleParent.path) && bundleParent.path != "/Applications" {
            fallbackRoot = bundleParent
        } else {
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory())
            fallbackRoot = docs.appendingPathComponent("KineticPro")
        }
        let rootURL = envRoot != nil ? URL(fileURLWithPath: envRoot!) : fallbackRoot
        self.workspaceRootURL = rootURL

        let bundled: URL
        if let resourceURL = Bundle.main.resourceURL,
           FileManager.default.fileExists(atPath: resourceURL.appendingPathComponent("presets").path) {
            bundled = resourceURL
        } else {
            bundled = rootURL.appendingPathComponent("public")
        }
        self.bundledPublicRootURL = bundled
        self.publicRootURL = bundled

        let initialProj = Self.loadProjectFile(id: "astral-forge", rootURL: rootURL, publicRootURL: bundled)
        self.project = initialProj
        self.history = [initialProj]
        self.historyIndex = 0

        do {
            let r = try MetalRigRenderer(project: initialProj, publicRootURL: bundled)
            self.renderer = r
            self.gpuDeviceName = r.device.name
            self.gpuUnifiedMemory = r.device.hasUnifiedMemory
            let quota = MetalMaxPerformance.quota(for: r.device)
            self.gpuQuotaLine = quota.statusLine
            self.statusMessage = "Max GPU/RAM · \(quota.statusLine)"
        } catch {
            self.statusMessage = "Metal init warning: \(error.localizedDescription)"
        }

        let projectsPath: URL
        if let env = ProcessInfo.processInfo.environment["KINETIC_PROJECTS_DIR"], !env.isEmpty {
            projectsPath = URL(fileURLWithPath: env)
        } else {
            projectsPath = rootURL.appendingPathComponent("projects")
        }
        try? FileManager.default.createDirectory(at: projectsPath, withIntermediateDirectories: true)
    }

    public static func loadProjectFile(id: String, rootURL: URL, publicRootURL: URL) -> SfProject {
        let candidates: [URL] = [
            publicRootURL.appendingPathComponent("presets/\(id)/\(id).project.json"),
            rootURL.appendingPathComponent("exports/\(id)/\(id).project.json")
        ]
        for url in candidates {
            if let data = try? Data(contentsOf: url),
               let decoded = try? JSONDecoder().decode(SfProject.self, from: data) {
                return decoded
            }
        }
        return SfProject(
            version: "1.0.0",
            id: id,
            title: id.capitalized,
            src: "/presets/\(id)/hero.webp",
            width: 653,
            height: 1080,
            action: "slam",
            frame: SfFrameMargin(left: 0.35, top: 0.35, right: 0.45, bottom: 0.05),
            palette: SfPalette(rim: "#7fd8ff", flash: "#f3c969"),
            bones: [SfBone(name: "root", x: 0.5, y: 0.975)],
            ikConstraints: [],
            parts: [],
            animations: [:]
        )
    }

    public func loadPreset(id: String) {
        selectedPreset = id
        currentProjectURL = nil
        publicRootURL = bundledPublicRootURL
        let loaded = Self.loadProjectFile(id: id, rootURL: workspaceRootURL, publicRootURL: bundledPublicRootURL)
        applyLoadedProject(loaded, assetsRoot: bundledPublicRootURL, projectURL: nil)
    }

    public func applyLoadedProject(_ next: SfProject, assetsRoot: URL? = nil, projectURL: URL? = nil) {
        if let assetsRoot {
            publicRootURL = assetsRoot
        }
        if projectURL != nil {
            currentProjectURL = projectURL
        }
        self.project = next
        self.history = [next]
        self.historyIndex = 0
        self.isDirty = false
        self.selectedBone = next.bones.dropFirst().first?.name ?? next.bones.first?.name ?? "root"
        self.selectedPart = next.parts.first(where: { ($0.skin?.count ?? 0) > 1 })?.name ?? next.parts.first?.name ?? ""
        self.activeClip = next.animations["strike"] != nil ? "strike" : (next.animations.keys.sorted().first ?? "idle")
        self.currentTime = 0
        try? renderer?.loadProject(next, publicRoot: publicRootURL)
        syncHeatmaps()
        statusMessage = "Loaded '\(next.title)' (\(next.bones.count) bones, \(next.parts.count) layers) on \(gpuDeviceName)"
    }

    public func pushHistorySnapshot() {
        let sliced = Array(history.prefix(historyIndex + 1)).suffix(24)
        history = Array(sliced) + [project]
        historyIndex = history.count - 1
        isDirty = true
    }

    public func undo() {
        guard historyIndex > 0 else { return }
        historyIndex -= 1
        project = history[historyIndex]
        renderer?.solver.project = project
        renderer?.solver.rebuildHierarchy()
        statusMessage = "Undo (\(historyIndex + 1)/\(history.count))"
    }

    public func redo() {
        guard historyIndex < history.count - 1 else { return }
        historyIndex += 1
        project = history[historyIndex]
        renderer?.solver.project = project
        renderer?.solver.rebuildHierarchy()
        statusMessage = "Redo (\(historyIndex + 1)/\(history.count))"
    }

    public func syncHeatmaps() {
        guard let renderer = renderer else { return }
        let idx = singleBoneThermalHeatmap ? (renderer.solver.boneIndex[selectedBone] ?? -1) : -1
        renderer.updateAllHeatmaps(selectedBoneIndex: idx)
    }

    public func setPartMeshDensity(_ density: String) {
        meshDensity = density
        guard let renderer = renderer else { return }
        let idx = singleBoneThermalHeatmap ? (renderer.solver.boneIndex[selectedBone] ?? -1) : -1
        renderer.regeneratePartMeshOnMetal(
            partName: selectedPart,
            density: density,
            weightMode: 0,
            selectedBoneForHeatmap: idx
        )
        project = renderer.solver.project
        let vCount = renderer.parts[selectedPart]?.vertexCount ?? 0
        let tCount = (renderer.parts[selectedPart]?.indexCount ?? 0) / 3
        NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .default)
        statusMessage = "Delaunay Mesher (\(density)): '\(selectedPart)' -> \(vCount) verts, \(tCount) tris"
    }

    public func dispatchGpuComputeAutoWeights(mode: UInt32) {
        guard let renderer = renderer,
              let part = project.parts.first(where: { $0.name == selectedPart }),
              var state = renderer.parts[selectedPart] else { return }
        let t0 = CFAbsoluteTimeGetCurrent()
        renderer.computeWeightsOnGPU(for: &state, part: part, mode: mode)
        let idx = singleBoneThermalHeatmap ? (renderer.solver.boneIndex[selectedBone] ?? -1) : -1
        renderer.updateAllHeatmaps(selectedBoneIndex: idx)
        renderer.parts[selectedPart] = state
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0
        NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .default)
        statusMessage = String(format: "Metal Compute Auto-Weights (%@) on '%@' (%d verts) in %.2f ms",
                               mode == 1 ? "Geodesic Heat" : "Hybrid Capsule", selectedPart, state.vertexCount, ms)
    }

    public func runAiAgentPrompt(_ rawPrompt: String) {
        let q = rawPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        aiMessages.append(AiChatEntry(role: "user", provider: aiProvider.rawValue, text: q, toolCalls: []))
        aiPrompt = ""

        let lower = q.lowercased()
        var tools: [String] = []
        var replyParts: [String] = []

        if lower.contains("mesh") || lower.contains("delaunay") || lower.contains("weight") || lower.contains("heat") {
            setPartMeshDensity("ultra")
            dispatchGpuComputeAutoWeights(mode: lower.contains("capsule") ? 0 : 1)
            mode = .weights
            tools.append("regeneratePartMeshOnMetal(part: '\(selectedPart)', density: 'ultra')")
            tools.append("compute_auto_weights(mode: 'geodesic_heat', gpu: '\(gpuDeviceName)')")
            replyParts.append("Tessellated '\(selectedPart)' with ultra-density Delaunay triangles and solved 4-bone weights on \(gpuDeviceName).")
        }
        if lower.contains("spring") || lower.contains("wind") || lower.contains("cape") || lower.contains("hair") {
            for i in project.bones.indices {
                if project.bones[i].name.contains("cape") || project.bones[i].name.contains("hair") || project.bones[i].spring != nil {
                    project.bones[i].spring = SfSpringConfig(stiffness: 72, damping: 6, gain: [8, 4], wind: 2.2)
                    tools.append("configure_spring(bone: '\(project.bones[i].name)', stiffness: 72, wind: 2.2)")
                }
            }
            renderer?.solver.project = project
            replyParts.append("Tuned secondary spring physics and wind sway across cloth/hair bones.")
        }
        if lower.contains("ik") || lower.contains("pin") || lower.contains("elbow") {
            for i in project.ikConstraints.indices {
                project.ikConstraints[i].mix = 1.0
                tools.append("configure_ik(name: '\(project.ikConstraints[i].name)', mix: 1.0)")
            }
            renderer?.solver.project = project
            replyParts.append("Enabled 100% 2-Bone Analytical IK mix.")
        }
        if lower.contains("clip") || lower.contains("animate") || lower.contains("procedural") {
            regenerateProceduralClipsNatively()
            mode = .animate
            tools.append("generateProceduralClips(clips: 6, fps: 24)")
            replyParts.append("Synthesized all 6 procedural slot animations.")
        }
        if lower.contains("export") || lower.contains("unity") || lower.contains("spine") {
            bakeAndExportOnMetal(revealInFinder: false)
            mode = .export
            tools.append("exportCompleteUnityBundle(sfrig + spine42 + metal_sheet)")
            replyParts.append("Built 3-way Unity + Spine 4.2 + Metal Flipbook bundle.")
        }

        if tools.isEmpty {
            setPartMeshDensity("ultra")
            dispatchGpuComputeAutoWeights(mode: 0)
            regenerateProceduralClipsNatively()
            tools.append("auto_rig_and_weight_pipeline(gpu: '\(gpuDeviceName)')")
            replyParts.append("Executed full \(aiProvider.rawValue) Auto-Rig & Metal Weight Pipeline on '\(project.title)'.")
        }

        aiMessages.append(AiChatEntry(
            role: "assistant",
            provider: aiProvider.rawValue,
            text: replyParts.joined(separator: " "),
            toolCalls: tools
        ))
    }

    public func addChildBone() {
        let clean = newBoneName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !clean.isEmpty, !project.bones.contains(where: { $0.name == clean }) else { return }
        let parentBone = project.bones.first(where: { $0.name == selectedBone }) ?? project.bones[0]
        let palette = MetalRigRenderer.bonePaletteHex
        let newBone = SfBone(
            name: clean,
            parent: parentBone.name,
            x: min(0.95, parentBone.x + 0.05),
            y: max(0.05, parentBone.y - 0.08),
            length: 0.08,
            color: palette[project.bones.count % palette.count]
        )
        project.bones.append(newBone)
        renderer?.solver.project = project
        renderer?.solver.rebuildHierarchy()
        selectedBone = clean
        newBoneName = ""
        statusMessage = "Added child bone '\(clean)' under '\(parentBone.name)'"
    }

    public func movePartOrder(partName: String, up: Bool) {
        guard let idx = project.parts.firstIndex(where: { $0.name == partName }) else { return }
        let target = up ? idx + 1 : idx - 1
        guard target >= 0 && target < project.parts.count else { return }
        let item = project.parts.remove(at: idx)
        project.parts.insert(item, at: target)
        renderer?.solver.project = project
    }

    public func updateSelectedBonePivot(x: Float, y: Float) {
        guard let idx = project.bones.firstIndex(where: { $0.name == selectedBone }) else { return }
        project.bones[idx].x = max(0, min(1, x))
        project.bones[idx].y = max(0, min(1, y))
        renderer?.solver.project = project
        renderer?.solver.rebuildHierarchy()
    }

    public func updateKeyAtCurrentTime(boneName: String, r: Float?, x: Float?, y: Float?) {
        guard var clip = project.animations[activeClip] else { return }
        let t = (currentTime * 100.0).rounded() / 100.0
        var track = clip.boneTracks[boneName] ?? []
        if let kIdx = track.firstIndex(where: { abs($0.time - t) < 0.025 }) {
            if let r = r { track[kIdx].r = r }
            if let x = x { track[kIdx].x = x }
            if let y = y { track[kIdx].y = y }
        } else {
            let cur = renderer?.solver.sampleTrack(track, time: t) ?? BonePose2D()
            track.append(SfTransformKey(
                time: t,
                r: r ?? cur.r,
                x: x ?? cur.x,
                y: y ?? cur.y,
                sx: cur.sx,
                sy: cur.sy
            ))
            track.sort { $0.time < $1.time }
        }
        clip.boneTracks[boneName] = track
        project.animations[activeClip] = clip
        renderer?.solver.project = project
    }

    public func regenerateProceduralClipsNatively() {
        let clips = MetalMeshAndClipsGenerator.generateProceduralClips(for: project)
        project.animations = clips
        renderer?.solver.project = project
        statusMessage = "Synthesized 6 procedural clips (idle, cheer, strike, power, triumph, bow) natively"
    }

    public func runAppleVisionAutoRig() {
        guard let renderer = renderer else { return }
        let msg = MetalAutoRigger.autoRigOnAppleSilicon(renderer: renderer)
        self.project = renderer.solver.project
        syncHeatmaps()
        NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .default)
        statusMessage = msg
    }

    public func bakeAndExportOnMetal(revealInFinder: Bool = true) {
        guard let renderer = renderer else { return }
        let outDir = workspaceRootURL.appendingPathComponent("exports/\(project.id)")
        do {
            let summary = try MetalUnityExporter.exportCompleteUnityBundle(
                renderer: renderer,
                outputDir: outDir,
                sheetCellHeight: 220,
                sheetFps: 12.0
            )
            lastExportSummary = summary
            exportedAtlasImage = NSImage(contentsOf: outDir.appendingPathComponent("\(project.id).png"))
            exportedSheetImage = NSImage(contentsOf: outDir.appendingPathComponent("\(project.id)-sheet.png"))
            statusMessage = String(
                format: "Exported Unity .sfrig + Spine 4.2 + Metal Flipbook (%d frames, %dx%d) in %.1f ms",
                summary.totalFrames, summary.sheetWidth, summary.sheetHeight, summary.elapsedMs
            )
            if revealInFinder {
                NSWorkspace.shared.activateFileViewerSelecting([
                    outDir.appendingPathComponent("\(project.id).sfrig.json"),
                    outDir.appendingPathComponent("\(project.id).spine.json"),
                    outDir.appendingPathComponent("\(project.id)-sheet.png")
                ])
            }
        } catch {
            statusMessage = "Metal export error: \(error.localizedDescription)"
        }
    }

    public func openProjectDialog() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Open a Kinetic Pro .project.json"
        panel.directoryURL = projectsDirURL
        if panel.runModal() == .OK, let url = panel.url {
            openProject(at: url)
        }
    }

    public func openProject(at url: URL) {
        guard let data = try? Data(contentsOf: url),
              let loaded = try? JSONDecoder().decode(SfProject.self, from: data) else {
            statusMessage = "Could not open project: \(url.lastPathComponent)"
            return
        }
        // Assets live next to the project file (projects/<id>/) or under bundled presets.
        let folder = url.deletingLastPathComponent()
        let hasLocalAssets = FileManager.default.fileExists(atPath: folder.appendingPathComponent("assets").path)
            || FileManager.default.fileExists(atPath: folder.appendingPathComponent("presets").path)
            || loaded.src.hasPrefix("assets/")
        let assetsRoot = hasLocalAssets ? folder : bundledPublicRootURL
        selectedPreset = loaded.id
        applyLoadedProject(loaded, assetsRoot: assetsRoot, projectURL: url)
    }

    @discardableResult
    public func saveProject() -> Bool {
        if let url = currentProjectURL {
            return writeProject(to: url)
        }
        return saveProjectAs()
    }

    @discardableResult
    public func saveProjectAs() -> Bool {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = "\(project.id).project.json"
        panel.directoryURL = projectsDirURL.appendingPathComponent(project.id)
        panel.message = "Save Kinetic Pro project"
        try? FileManager.default.createDirectory(at: panel.directoryURL!, withIntermediateDirectories: true)
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        return writeProject(to: url)
    }

    private func writeProject(to url: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(project)
            let tmp = url.appendingPathExtension("tmp")
            try data.write(to: tmp, options: .atomic)
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: url)
            }
            currentProjectURL = url
            isDirty = false
            statusMessage = "Saved \(url.lastPathComponent)"
            return true
        } catch {
            statusMessage = "Save failed: \(error.localizedDescription)"
            return false
        }
    }

    public func importArtDialog() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .webP, .jpeg, .tiff, .pdf]
        if let psd = UTType(filenameExtension: "psd") {
            panel.allowedContentTypes.append(psd)
        }
        panel.allowsMultipleSelection = false
        panel.message = "Import character art (PNG / WebP / PSD). Flat images auto-rig as a single layer."
        guard panel.runModal() == .OK, let sourceURL = panel.url else { return }
        importArt(from: sourceURL)
    }

    public func importArt(from sourceURL: URL) {
        guard let nsImg = NSImage(contentsOf: sourceURL),
              let cgImg = nsImg.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            statusMessage = "Could not read image: \(sourceURL.lastPathComponent)"
            return
        }

        let stem = sourceURL.deletingPathExtension().lastPathComponent
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let id = stem.isEmpty ? "imported-\(Int(Date().timeIntervalSince1970))" : stem
        let projectDir = projectsDirURL.appendingPathComponent(id)
        let assetsDir = projectDir.appendingPathComponent("assets")
        do {
            try FileManager.default.createDirectory(at: assetsDir, withIntermediateDirectories: true)
        } catch {
            statusMessage = "Could not create projects/\(id): \(error.localizedDescription)"
            return
        }

        let ext = sourceURL.pathExtension.lowercased().isEmpty ? "png" : sourceURL.pathExtension.lowercased()
        let destName = "hero.\(ext == "psd" ? "png" : ext)"
        let destURL = assetsDir.appendingPathComponent(destName)

        if ext == "psd" {
            // Flatten PSD via CoreGraphics when possible; otherwise copy bytes.
            if let dest = CGImageDestinationCreateWithURL(destURL as CFURL, UTType.png.identifier as CFString, 1, nil) {
                CGImageDestinationAddImage(dest, cgImg, nil)
                CGImageDestinationFinalize(dest)
            } else {
                try? FileManager.default.copyItem(at: sourceURL, to: destURL)
            }
        } else {
            try? FileManager.default.removeItem(at: destURL)
            do {
                try FileManager.default.copyItem(at: sourceURL, to: destURL)
            } catch {
                statusMessage = "Import copy failed: \(error.localizedDescription)"
                return
            }
        }

        let w = cgImg.width
        let h = cgImg.height
        let rel = "assets/\(destName)"
        let body = SfPart(
            name: "body",
            src: rel,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            bone: "hips",
            skin: ["hips", "chest", "head"],
            swap: nil,
            meshDensity: "ultra",
            mesh: nil
        )
        let bones: [SfBone] = [
            SfBone(name: "root", x: 0.5, y: 0.96, length: 0.04, color: "#7fd8ff"),
            SfBone(name: "hips", parent: "root", x: 0.5, y: 0.62, length: 0.12, color: "#f3c969"),
            SfBone(name: "chest", parent: "hips", x: 0.5, y: 0.42, length: 0.14, color: "#7fd8ff"),
            SfBone(name: "head", parent: "chest", x: 0.5, y: 0.18, length: 0.1, color: "#ff9f7a"),
            SfBone(name: "arm", parent: "chest", x: 0.68, y: 0.4, length: 0.12, color: "#9ae6b4"),
            SfBone(name: "forearm", parent: "arm", x: 0.82, y: 0.48, length: 0.1, color: "#68d391")
        ]
        let imported = SfProject(
            version: "1.0.0",
            id: id,
            title: stem.replacingOccurrences(of: "-", with: " ").capitalized,
            src: rel,
            width: w,
            height: h,
            action: "idle",
            frame: SfFrameMargin(left: 0.2, top: 0.1, right: 0.2, bottom: 0.05),
            palette: SfPalette(rim: "#7fd8ff", flash: "#f3c969"),
            bones: bones,
            ikConstraints: [
                SfIkConstraint(name: "arm-ik", bones: ["arm", "forearm"], target: "ik-hand", bendPositive: true, mix: 1.0)
            ],
            parts: [body],
            animations: [:]
        )

        // Ensure IK target bone exists
        var withIk = imported
        if !withIk.bones.contains(where: { $0.name == "ik-hand" }) {
            withIk.bones.append(SfBone(name: "ik-hand", parent: nil, x: 0.9, y: 0.55, length: 0.02, color: "#fc8181"))
        }

        let projectURL = projectDir.appendingPathComponent("\(id).project.json")
        selectedPreset = id
        applyLoadedProject(withIk, assetsRoot: projectDir, projectURL: projectURL)
        regenerateProceduralClipsNatively()
        runAppleVisionAutoRig()
        pushHistorySnapshot()
        _ = writeProject(to: projectURL)
        mode = .animate
        statusMessage = "Imported '\(withIk.title)' → projects/\(id) (Vision auto-rig on \(gpuDeviceName))"
    }

    public func revealProjectsInFinder() {
        NSWorkspace.shared.open(projectsDirURL)
    }
}

// MARK: - Interactive 120Hz ProMotion MTKView Wrapper

public final class InteractiveMTKView: MTKView, MTKViewDelegate {
    public weak var viewModel: MacStudioViewModel?
    private var lastFrameTimestamp: CFTimeInterval = CFAbsoluteTimeGetCurrent()
    private var dragStartRigPoint: SIMD2<Float>?
    private var dragOrigBoneXY: SIMD2<Float>?
    private var dragOrigBoneRot: Float = 0

    public init(viewModel: MacStudioViewModel) {
        self.viewModel = viewModel
        super.init(frame: .zero, device: viewModel.renderer?.device ?? MetalMaxPerformance.bestDevice())
        self.colorPixelFormat = .bgra8Unorm
        self.clearColor = MTLClearColor(red: 0.016, green: 0.027, blue: 0.067, alpha: 1.0)
        // Lock to the display’s maximum refresh (ProMotion 120Hz when available).
        self.preferredFramesPerSecond = MetalMaxPerformance.maximumFramesPerSecond(for: window?.screen ?? NSScreen.main)
        self.enableSetNeedsDisplay = false
        self.isPaused = false
        self.autoResizeDrawable = true
        self.framebufferOnly = true
        if let p3 = CGColorSpace(name: CGColorSpace.displayP3) {
            self.colorspace = p3
        }
        self.delegate = self

        let tracking = NSTrackingArea(
            rect: .zero,
            options: [.activeInKeyWindow, .inVisibleRect, .mouseMoved, .mouseEnteredAndExited],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(tracking)
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        preferredFramesPerSecond = MetalMaxPerformance.maximumFramesPerSecond(for: window?.screen ?? NSScreen.main)
        if let scale = window?.backingScaleFactor, scale > 0 {
            // Full native Retina drawable — no undersampled backing store.
            layer?.contentsScale = scale
        }
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    public func draw(in view: MTKView) {
        guard let vm = viewModel,
              let renderer = vm.renderer,
              let drawable = currentDrawable,
              let passDesc = currentRenderPassDescriptor,
              let cmdBuf = renderer.commandQueue.makeCommandBuffer() else { return }

        let now = CFAbsoluteTimeGetCurrent()
        let rawDt = Float(min(0.05, max(0.0, now - lastFrameTimestamp)))
        lastFrameTimestamp = now

        let dt = rawDt * vm.playbackSpeed
        let clipDur = max(0.1, vm.project.animations[vm.activeClip]?.duration ?? 2.4)

        var evalTime = vm.currentTime
        if vm.isPlaying && vm.mode != .rig && vm.mode != .mesh {
            evalTime = fmod(vm.currentTime + dt, clipDur)
            vm.currentTime = evalTime
        } else if vm.mode == .rig || vm.mode == .mesh {
            evalTime = 0
        }

        let eval = renderer.solver.evaluateClip(
            name: vm.activeClip,
            at: evalTime,
            dt: (vm.mode == .rig || vm.mode == .mesh) ? 0 : dt
        )

        guard let enc = cmdBuf.makeRenderCommandEncoder(descriptor: passDesc) else { return }
        let vpW = Float(drawableSize.width)
        let vpH = Float(drawableSize.height)
        enc.setViewport(MTLViewport(originX: 0, originY: 0, width: Double(vpW), height: Double(vpH), znear: 0, zfar: 1))

        let brush: (pos: SIMD2<Float>, radius: Float)? = (vm.mode == .weights && vm.hoverRigCursor != nil)
            ? (vm.hoverRigCursor!, vm.brushRadius)
            : nil

        renderer.encodeFrame(
            into: enc,
            viewportSize: SIMD2<Float>(vpW, vpH),
            drawOrder: eval.drawOrder,
            flash: eval.flash,
            heatmapMix: vm.showHeatmap ? 0.78 : 0.0,
            selectedPart: vm.selectedPart,
            isolatePart: vm.isolateSelectedPart,
            showWireframe: vm.showWireframe,
            showBones: vm.showBones,
            selectedBone: vm.selectedBone,
            brushCursor: brush
        )

        enc.endEncoding()
        cmdBuf.present(drawable)
        cmdBuf.commit()
    }

    private func eventToRigCoordinates(_ event: NSEvent) -> SIMD2<Float>? {
        guard let vm = viewModel, let renderer = vm.renderer else { return nil }
        let loc = convert(event.locationInWindow, from: nil)
        let boundsW = Float(max(1.0, bounds.width))
        let boundsH = Float(max(1.0, bounds.height))
        let viewX = Float(loc.x)
        let viewY = boundsH - Float(loc.y)
        let metrics = renderer.computeViewMetrics(viewportWidth: boundsW, viewportHeight: boundsH)
        return SIMD2<Float>((viewX - metrics.offsetX) / metrics.scale, (viewY - metrics.offsetY) / metrics.scale)
    }

    public override func mouseMoved(with event: NSEvent) {
        viewModel?.hoverRigCursor = eventToRigCoordinates(event)
    }

    public override func mouseExited(with event: NSEvent) {
        viewModel?.hoverRigCursor = nil
    }

    public override func mouseDown(with event: NSEvent) {
        guard let vm = viewModel, let renderer = vm.renderer, let pt = eventToRigCoordinates(event) else { return }
        vm.hoverRigCursor = pt

        if vm.mode == .weights {
            let bIdx = renderer.solver.boneIndex[vm.selectedBone] ?? 0
            let heatIdx = vm.singleBoneThermalHeatmap ? bIdx : -1
            renderer.paintWeightStroke(
                partName: vm.selectedPart,
                rigPoint: pt,
                radius: vm.brushRadius,
                strength: vm.brushStrength,
                boneIndex: bIdx,
                mode: vm.brushMode,
                selectedBoneForHeatmap: heatIdx
            )
            return
        }

        var closestName: String? = nil
        var bestDist: Float = 32.0
        for (i, bone) in vm.project.bones.enumerated() {
            let wMat = renderer.solver.world[i]
            let bPos = SIMD2<Float>(wMat.tx, wMat.ty)
            let d = simd_distance(pt, bPos)
            if d < bestDist {
                bestDist = d
                closestName = bone.name
            }
        }

        if let hitName = closestName,
           let bone = vm.project.bones.first(where: { $0.name == hitName }) {
            vm.selectedBone = hitName
            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .default)
            dragStartRigPoint = pt
            dragOrigBoneXY = SIMD2<Float>(bone.x, bone.y)
            let track = vm.project.animations[vm.activeClip]?.boneTracks[hitName]
            dragOrigBoneRot = renderer.solver.sampleTrack(track, time: vm.currentTime).r
        }
    }

    public override func mouseDragged(with event: NSEvent) {
        guard let vm = viewModel, let renderer = vm.renderer, let pt = eventToRigCoordinates(event) else { return }
        vm.hoverRigCursor = pt

        if vm.mode == .weights {
            let bIdx = renderer.solver.boneIndex[vm.selectedBone] ?? 0
            let heatIdx = vm.singleBoneThermalHeatmap ? bIdx : -1
            renderer.paintWeightStroke(
                partName: vm.selectedPart,
                rigPoint: pt,
                radius: vm.brushRadius,
                strength: vm.brushStrength,
                boneIndex: bIdx,
                mode: vm.brushMode,
                selectedBoneForHeatmap: heatIdx
            )
            return
        }

        guard let startPt = dragStartRigPoint, let origXY = dragOrigBoneXY else { return }
        let delta = pt - startPt
        if vm.mode == .rig {
            let nx = origXY.x + delta.x / Float(vm.project.width)
            let ny = origXY.y + delta.y / Float(vm.project.height)
            vm.updateSelectedBonePivot(x: nx, y: ny)
        } else if vm.mode == .animate {
            if vm.selectedBone.hasPrefix("ik-") || vm.selectedBone == "root" {
                vm.updateKeyAtCurrentTime(boneName: vm.selectedBone, r: nil, x: delta.x, y: delta.y)
            } else {
                vm.updateKeyAtCurrentTime(boneName: vm.selectedBone, r: dragOrigBoneRot + delta.x * 0.45, x: nil, y: nil)
            }
        }
    }

    public override func mouseUp(with event: NSEvent) {
        dragStartRigPoint = nil
        dragOrigBoneXY = nil
    }
}

public struct MetalViewportRepresentable: NSViewRepresentable {
    @ObservedObject var viewModel: MacStudioViewModel

    public func makeNSView(context: Context) -> InteractiveMTKView {
        return InteractiveMTKView(viewModel: viewModel)
    }

    public func updateNSView(_ nsView: InteractiveMTKView, context: Context) {
        nsView.viewModel = viewModel
    }
}

// MARK: - Photoshop-Adaptable Liquid Glass Workspace + Extreme-Right AI Agent Copilot

public struct SpineForgeMainStudioView: View {
    @ObservedObject var vm: MacStudioViewModel

    public init(vm: MacStudioViewModel) {
        self.vm = vm
    }

    public var body: some View {
        ZStack {
            // 1. 100% Full-Bleed Apple Metal 120Hz ProMotion Stage
            MetalViewportRepresentable(viewModel: vm)
                .ignoresSafeArea()

            // 2. Non-Overlapping Spatial Workspace Columns (Supports Stacking Timeline at Top or Bottom)
            VStack(spacing: 10) {
                if vm.timelineAtTop {
                    timelineDockView
                }

                // MIDDLE WORKSPACE ROW:
                // [Left Photoshop Tool Rail (Import PSD above Auto) + Contextual Tool Options Pane] | [Canvas] | [Right-Center Layers/Bones] | [Extreme-Right AI Copilot]
                HStack(alignment: .top, spacing: 12) {
                    // 1. Far-Left Unified 2-Column Photoshop Tool Palette (All tools & view overlays share the same icon+button style)
                    LazyVGrid(columns: [GridItem(.fixed(42), spacing: 6), GridItem(.fixed(42), spacing: 6)], spacing: 6) {
                        Button(action: {
                            if vm.mode == .importPsd && vm.leftPaneOpen { vm.leftPaneOpen = false }
                            else { vm.mode = .importPsd; vm.leftPaneOpen = true }
                        }) {
                            VStack(spacing: 1) {
                                Image(systemName: "square.and.arrow.down.fill")
                                Text("PSD").font(.system(size: 8.5, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.mode == .importPsd && vm.leftPaneOpen ? .cyan : .blue.opacity(0.35))

                        Button(action: {
                            if vm.mode == .autoStudio && vm.leftPaneOpen { vm.leftPaneOpen = false }
                            else { vm.mode = .autoStudio; vm.leftPaneOpen = true }
                        }) {
                            VStack(spacing: 1) {
                                Image(systemName: "wand.and.stars")
                                Text("Auto").font(.system(size: 8.5, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.mode == .autoStudio && vm.leftPaneOpen ? .cyan : .gray.opacity(0.3))

                        Button(action: {
                            if vm.mode == .animate && vm.leftPaneOpen { vm.leftPaneOpen = false }
                            else { vm.mode = .animate; vm.leftPaneOpen = true }
                        }) {
                            VStack(spacing: 1) {
                                Image(systemName: "cursorarrow.motionlines")
                                Text("Pose V").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.mode == .animate && vm.leftPaneOpen ? .cyan : .gray.opacity(0.3))

                        Button(action: {
                            if vm.mode == .rig && vm.leftPaneOpen { vm.leftPaneOpen = false }
                            else { vm.mode = .rig; vm.leftPaneOpen = true }
                        }) {
                            VStack(spacing: 1) {
                                Image(systemName: "pin.fill")
                                Text("Rig P").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.mode == .rig && vm.leftPaneOpen ? .cyan : .gray.opacity(0.3))

                        Button(action: {
                            if vm.mode == .mesh && vm.leftPaneOpen { vm.leftPaneOpen = false }
                            else { vm.mode = .mesh; vm.leftPaneOpen = true }
                        }) {
                            VStack(spacing: 1) {
                                Image(systemName: "triangle")
                                Text("Mesh M").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.mode == .mesh && vm.leftPaneOpen ? .cyan : .gray.opacity(0.3))

                        Button(action: {
                            if vm.mode == .weights && vm.leftPaneOpen { vm.leftPaneOpen = false }
                            else { vm.mode = .weights; vm.leftPaneOpen = true }
                        }) {
                            VStack(spacing: 1) {
                                Image(systemName: "paintbrush.pointed.fill")
                                Text("Brush B").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.mode == .weights && vm.leftPaneOpen ? .cyan : .gray.opacity(0.3))

                        Button(action: {
                            vm.bakeAndExportOnMetal(revealInFinder: false)
                            if vm.mode == .export && vm.leftPaneOpen { vm.leftPaneOpen = false }
                            else { vm.mode = .export; vm.leftPaneOpen = true }
                        }) {
                            VStack(spacing: 1) {
                                Image(systemName: "cube.box.fill")
                                Text("Unity").font(.system(size: 8.5, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.mode == .export ? .green : .green.opacity(0.35))

                        Button(action: {
                            vm.showAiCopilot.toggle()
                        }) {
                            VStack(spacing: 1) {
                                Image(systemName: "sparkles")
                                Text("Copilot").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.showAiCopilot ? .purple : .gray.opacity(0.3))

                        Button(action: { vm.undo() }) {
                            VStack(spacing: 1) {
                                Image(systemName: "arrow.uturn.backward")
                                Text("Undo").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.gray.opacity(0.3))
                        .disabled(vm.historyIndex <= 0)

                        Button(action: { vm.redo() }) {
                            VStack(spacing: 1) {
                                Image(systemName: "arrow.uturn.forward")
                                Text("Redo").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.gray.opacity(0.3))
                        .disabled(vm.historyIndex >= vm.history.count - 1)

                        Button(action: { vm.showBones.toggle() }) {
                            VStack(spacing: 1) {
                                Image(systemName: "point.3.connected.trianglepath.dotted")
                                Text("Bone").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.showBones ? .cyan : .gray.opacity(0.3))

                        Button(action: { vm.showWireframe.toggle() }) {
                            VStack(spacing: 1) {
                                Image(systemName: "squareshape.split.3x3")
                                Text("Grid").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.showWireframe ? .cyan : .gray.opacity(0.3))

                        Button(action: { vm.showHeatmap.toggle() }) {
                            VStack(spacing: 1) {
                                Image(systemName: "flame.fill")
                                Text("Heat").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.showHeatmap ? .cyan : .gray.opacity(0.3))

                        Button(action: { vm.isolateSelectedPart.toggle() }) {
                            VStack(spacing: 1) {
                                Image(systemName: "eye.fill")
                                Text("Solo").font(.system(size: 8, weight: .bold))
                            }
                            .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.isolateSelectedPart ? .cyan : .gray.opacity(0.3))

                        Button(action: { vm.showUserManualSheet.toggle() }) {
                            Text("?")
                                .font(.system(size: 15, weight: .heavy))
                                .frame(width: 40, height: 38)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(vm.showUserManualSheet ? .yellow : .yellow.opacity(0.35))
                        .help("User Manual & Guided Tour (?)")
                    }
                    .padding(10)
                    .frame(width: 108)
                    .liquidGlass(cornerRadius: 24)

                    // 2. Left Contextual Photoshop Tool Options Pane (Hideable & Stackable)
                    if vm.leftPaneOpen {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(vm.mode.rawValue.uppercased())
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(.cyan)
                            Spacer()
                            Button("↶") { vm.undo() }
                                .disabled(vm.historyIndex <= 0)
                                .controlSize(.mini)
                            Button("↷") { vm.redo() }
                                .disabled(vm.historyIndex >= vm.history.count - 1)
                                .controlSize(.mini)
                            Button("🪄 Auto") {
                                vm.runAppleVisionAutoRig()
                                vm.pushHistorySnapshot()
                            }
                            .controlSize(.mini)
                            Button("«") {
                                vm.leftPaneOpen = false
                            }
                            .controlSize(.mini)
                        }

                        if vm.mode == .importPsd {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Active Character Preset (.psd)")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundColor(.secondary)
                                Picker("", selection: Binding(
                                    get: { vm.selectedPreset },
                                    set: { vm.loadPreset(id: $0) }
                                )) {
                                    Text("Astral Forge.psd").tag("astral-forge")
                                    Text("Sands of Solara.psd").tag("sands-of-solara")
                                }
                                .labelsHidden()

                                Button("Import Art (.PNG / .WebP / .PSD)...") {
                                    vm.importArtDialog()
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(.cyan)
                                .controlSize(.small)

                                Button("Open Saved Project…") {
                                    vm.openProjectDialog()
                                }
                                .controlSize(.small)

                                Button("Reveal Projects Folder") {
                                    vm.revealProjectsInFinder()
                                }
                                .controlSize(.mini)
                            }
                            .padding(10)
                            .background(Color.black.opacity(0.28))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        } else if vm.mode == .weights {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("GPU Weight Paint Brush (B)")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(.green)
                                Picker("", selection: $vm.brushMode) {
                                    Text("Add").tag("add")
                                    Text("Subtract").tag("subtract")
                                    Text("Replace").tag("replace")
                                }
                                .pickerStyle(.segmented)
                                .labelsHidden()

                                Toggle("Single-Bone Thermal Ramp", isOn: $vm.singleBoneThermalHeatmap)
                                    .font(.system(size: 11))

                                Text("Brush Radius: \(Int(vm.brushRadius)) px")
                                    .font(.system(size: 10))
                                Slider(value: $vm.brushRadius, in: 15...180)

                                Text("Brush Strength: \(Int(vm.brushStrength * 100))%")
                                    .font(.system(size: 10))
                                Slider(value: $vm.brushStrength, in: 0.05...1.0)
                            }
                            .padding(10)
                            .background(Color.black.opacity(0.28))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        } else if vm.mode == .mesh {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Delaunay Contour Mesher (\(vm.selectedPart))")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(.cyan)
                                Picker("", selection: Binding(
                                    get: { vm.meshDensity },
                                    set: { vm.setPartMeshDensity($0) }
                                )) {
                                    Text("Low").tag("low")
                                    Text("Med").tag("medium")
                                    Text("High").tag("high")
                                    Text("Ultra").tag("ultra")
                                }
                                .pickerStyle(.segmented)
                                .labelsHidden()

                                HStack {
                                    Button("GPU Capsule Weights") { vm.dispatchGpuComputeAutoWeights(mode: 0) }
                                        .controlSize(.small)
                                    Button("GPU Heat Weights") { vm.dispatchGpuComputeAutoWeights(mode: 1) }
                                        .controlSize(.small)
                                }
                            }
                            .padding(10)
                            .background(Color.black.opacity(0.28))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        } else {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Famous Slot & Game Actions (14)")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(.yellow)
                                ScrollView {
                                    VStack(alignment: .leading, spacing: 4) {
                                        ForEach(vm.project.animations.keys.sorted(), id: \.self) { clipName in
                                            Button(action: { vm.activeClip = clipName }) {
                                                HStack {
                                                    Text(clipName.capitalized)
                                                        .font(.system(size: 11, weight: .semibold))
                                                    Spacer()
                                                    Text(String(format: "%.1fs", vm.project.animations[clipName]?.duration ?? 2.0))
                                                        .font(.system(size: 9, design: .monospaced))
                                                }
                                            }
                                            .buttonStyle(.borderedProminent)
                                            .tint(vm.activeClip == clipName ? .cyan : .gray.opacity(0.25))
                                            .controlSize(.small)
                                        }
                                    }
                                }
                                .frame(maxHeight: 240)
                            }
                            .padding(10)
                            .background(Color.black.opacity(0.28))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        }
                    }
                    .padding(12)
                    .frame(width: 260)
                    .liquidGlass(cornerRadius: 26)
                    }

                    Spacer()

                    // 3. Right-Center Dock: Global Actions + Photoshop Properties + Layers / Bones Stack
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 6) {
                            Button(action: { vm.bakeAndExportOnMetal(revealInFinder: true) }) {
                                Label("Export Unity", systemImage: "bolt.fill")
                                    .font(.system(size: 10.5, weight: .bold))
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(.green)
                            .controlSize(.small)

                            Toggle("AI Copilot", isOn: $vm.showAiCopilot)
                                .toggleStyle(.button)
                                .controlSize(.small)

                            Button("?") {
                                vm.showUserManualSheet = true
                            }
                            .controlSize(.small)
                        }
                        // Top: Properties Card
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Label("PROPERTIES (\(vm.selectedBone))", systemImage: "slider.horizontal.3")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundColor(.cyan)
                                Spacer()
                                Text(vm.gpuDeviceName)
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundColor(.secondary)
                            }

                            if let boneIdx = vm.project.bones.firstIndex(where: { $0.name == vm.selectedBone }) {
                                let bone = vm.project.bones[boneIdx]
                                Text(String(format: "Pivot: (%.3f, %.3f) · Parent: %@", bone.x, bone.y, bone.parent ?? "root"))
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(.secondary)

                                Toggle("Spring Secondary Physics", isOn: Binding(
                                    get: { vm.project.bones[boneIdx].spring != nil },
                                    set: { enabled in
                                        vm.project.bones[boneIdx].spring = enabled ? SfSpringConfig() : nil
                                        vm.renderer?.solver.project = vm.project
                                    }
                                ))
                                .font(.system(size: 11))
                            }

                            if !vm.project.ikConstraints.isEmpty {
                                ForEach(vm.project.ikConstraints.indices, id: \.self) { i in
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack {
                                            Text("IK Pin: \(vm.project.ikConstraints[i].name)")
                                                .font(.system(size: 10, weight: .semibold))
                                            Spacer()
                                            Text("\(Int(vm.project.ikConstraints[i].mix * 100))%")
                                                .font(.system(size: 10, design: .monospaced))
                                                .foregroundColor(.cyan)
                                        }
                                        Slider(value: Binding(
                                            get: { vm.project.ikConstraints[i].mix },
                                            set: {
                                                vm.project.ikConstraints[i].mix = $0
                                                vm.renderer?.solver.project = vm.project
                                            }
                                        ), in: 0...1)
                                    }
                                }
                            }
                        }
                        .padding(10)
                        .background(Color.black.opacity(0.28))
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                        // Bottom: Photoshop Layers & Bones Stack
                        Picker("", selection: $vm.outlinerTab) {
                            Text("Layers (\(vm.project.parts.count))").tag(MacStudioViewModel.OutlinerTab.layers)
                            Text("Bones (\(vm.project.bones.count))").tag(MacStudioViewModel.OutlinerTab.bones)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()

                        if vm.outlinerTab == .layers {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 5) {
                                    ForEach(vm.project.parts.reversed()) { part in
                                        let isSel = (part.name == vm.selectedPart)
                                        let isSkinned = (part.skin?.count ?? 0) > 1
                                        let vCount = vm.renderer?.parts[part.name]?.vertexCount ?? 4
                                        HStack {
                                            Image(systemName: "eye.fill")
                                                .font(.system(size: 10))
                                                .foregroundColor(.cyan)
                                            VStack(alignment: .leading, spacing: 1) {
                                                Text(part.name)
                                                    .font(.system(size: 12, weight: .semibold))
                                                Text("\(vCount)v · \(isSkinned ? "Mesh (\(part.skin!.count)B)" : (part.bone ?? "root"))")
                                                    .font(.system(size: 9))
                                                    .foregroundColor(.secondary)
                                            }
                                            Spacer()
                                            Button("↑") { vm.movePartOrder(partName: part.name, up: true) }
                                                .controlSize(.mini)
                                            Button("↓") { vm.movePartOrder(partName: part.name, up: false) }
                                                .controlSize(.mini)
                                        }
                                        .padding(8)
                                        .background(isSel ? Color.white.opacity(0.18) : Color.white.opacity(0.04))
                                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                        .onTapGesture {
                                            vm.selectedPart = part.name
                                        }
                                    }
                                }
                            }
                        } else {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(vm.project.bones) { bone in
                                        let isSel = (bone.name == vm.selectedBone)
                                        HStack {
                                            Circle()
                                                .fill(isSel ? Color.white : Color.cyan)
                                                .frame(width: 7, height: 7)
                                            Text(bone.name)
                                                .font(.system(size: 12, weight: isSel ? .semibold : .regular, design: .monospaced))
                                            Spacer()
                                            if bone.spring != nil {
                                                Text("Spring")
                                                    .font(.system(size: 9, weight: .semibold))
                                                    .padding(.horizontal, 5)
                                                    .background(Color.orange.opacity(0.25))
                                                    .foregroundColor(.orange)
                                                    .clipShape(Capsule())
                                            }
                                        }
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 5)
                                        .background(isSel ? Color.white.opacity(0.18) : Color.clear)
                                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                        .onTapGesture {
                                            vm.selectedBone = bone.name
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .padding(12)
                    .frame(width: 255)
                    .liquidGlass(cornerRadius: 26)

                    // 4. EXTREME-RIGHT DOCK: AI Agent Copilot Window (Cursor, Claude, ChatGPT, Grok)
                    if vm.showAiCopilot {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Circle()
                                    .fill(Color.green)
                                    .frame(width: 8, height: 8)
                                Text("AI Rigging Copilot")
                                    .font(.system(size: 12, weight: .bold))
                                Spacer()
                                Text("Live Tool Engine")
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundColor(.cyan)
                            }

                            Picker("", selection: $vm.aiProvider) {
                                ForEach(MacStudioViewModel.AiProvider.allCases, id: \.self) { p in
                                    Text(p.rawValue).tag(p)
                                }
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()

                            // Quick Action Chips
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    Button("Auto-Mesh & Heat Weights") {
                                        vm.runAiAgentPrompt("Generate high-density Delaunay mesh and solve geodesic heat weights")
                                    }
                                    .controlSize(.small)
                                    Button("Tune Cape Springs") {
                                        vm.runAiAgentPrompt("Configure flowing spring physics and wind on cape and hair")
                                    }
                                    .controlSize(.small)
                                    Button("Enable 2-Bone IK") {
                                        vm.runAiAgentPrompt("Enable 2-bone IK pin on weapon arm")
                                    }
                                    .controlSize(.small)
                                    Button("Export Unity Bundle") {
                                        vm.runAiAgentPrompt("Export complete Unity and Spine 4.2 bundle")
                                    }
                                    .controlSize(.small)
                                }
                            }

                            // Chat Message Stream
                            ScrollView {
                                VStack(alignment: .leading, spacing: 8) {
                                    ForEach(vm.aiMessages) { msg in
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(msg.role == "user" ? "YOU" : "\(msg.provider.uppercased()) AGENT")
                                                .font(.system(size: 9, weight: .bold))
                                                .foregroundColor(.cyan)
                                            Text(msg.text)
                                                .font(.system(size: 11))
                                                .fixedSize(horizontal: false, vertical: true)
                                            ForEach(msg.toolCalls, id: \.self) { tc in
                                                Text("⚡ \(tc)")
                                                    .font(.system(size: 9, design: .monospaced))
                                                    .foregroundColor(.green)
                                                    .padding(4)
                                                    .background(Color.green.opacity(0.12))
                                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                            }
                                        }
                                        .padding(9)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .background(msg.role == "user" ? Color.cyan.opacity(0.16) : Color.black.opacity(0.32))
                                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                    }
                                }
                            }

                            // Prompt Composer
                            HStack(spacing: 6) {
                                TextField("Ask \(vm.aiProvider.rawValue) to rig, weight, or export...", text: $vm.aiPrompt)
                                    .textFieldStyle(.roundedBorder)
                                    .onSubmit {
                                        vm.runAiAgentPrompt(vm.aiPrompt)
                                    }
                                Button("Run") {
                                    vm.runAiAgentPrompt(vm.aiPrompt)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(.cyan)
                            }
                        }
                        .padding(12)
                        .frame(width: 295)
                        .liquidGlass(cornerRadius: 26)
                    }
                }

                // BOTTOM ROW (When timelineAtTop == false)
                if !vm.timelineAtTop {
                    timelineDockView
                }
            }
            .padding(14)

            if vm.showUserManualSheet {
                ZStack {
                    Color.black.opacity(0.6)
                        .ignoresSafeArea()
                        .onTapGesture { vm.showUserManualSheet = false }

                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("INTERACTIVE USER MANUAL & QUICK-START TOUR")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundColor(.cyan)
                                Text("How to Use Kinetic Pro — From Artwork to Unity in 3 Clicks")
                                    .font(.system(size: 18, weight: .bold))
                            }
                            Spacer()
                            Button("Close Guide") { vm.showUserManualSheet = false }
                                .buttonStyle(.borderedProminent)
                                .tint(.cyan)
                        }

                        Divider()

                        HStack(spacing: 14) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Step 1 · 1-Click Auto-Rig")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundColor(.cyan)
                                Text("Click '1-Click Auto-Rig' to detect pose landmarks via Apple Vision, build high-density Delaunay meshes, solve 4-bone weights on the Metal GPU, and synthesize all 14 animations.")
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                                Button("▶ Run Auto-Rig Now") {
                                    vm.runAppleVisionAutoRig()
                                    vm.showUserManualSheet = false
                                }
                                .controlSize(.small)
                            }
                            .padding(12)
                            .background(Color.black.opacity(0.3))
                            .clipShape(RoundedRectangle(cornerRadius: 16))

                            VStack(alignment: .leading, spacing: 6) {
                                Text("Step 2 · Photoshop Tools (V, P, M, B)")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundColor(.yellow)
                                Text("Use V (Free Transform Pose), P (Bone Pin), M (Puppet Delaunay Mesh), and B (GPU Weight Brush) on the left tool rail, or ask the AI Copilot on the extreme right.")
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                                Button("▶ Try GPU Weight Brush") {
                                    vm.mode = .weights
                                    vm.showUserManualSheet = false
                                }
                                .controlSize(.small)
                            }
                            .padding(12)
                            .background(Color.black.opacity(0.3))
                            .clipShape(RoundedRectangle(cornerRadius: 16))

                            VStack(alignment: .leading, spacing: 6) {
                                Text("Step 3 · Export 3-Way Unity Bundle")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundColor(.green)
                                Text("Click 'Export Unity' (⌘E) to output .sfrig.json (Zero-Dependency Unity C# Runtime), .spine.json + .atlas.txt (Spine 4.2), and Metal-baked flipbook sprite sheets.")
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                                Button("▶ Export Unity Bundle") {
                                    vm.showUserManualSheet = false
                                    vm.bakeAndExportOnMetal(revealInFinder: true)
                                }
                                .controlSize(.small)
                            }
                            .padding(12)
                            .background(Color.black.opacity(0.3))
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                        }

                        Text("Full documentation available at /Users/amit.tayal/Kinetic/USER_MANUAL.md")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.cyan)
                    }
                    .padding(24)
                    .frame(width: 860)
                    .liquidGlass(cornerRadius: 32)
                }
            }
        }
        .frame(minWidth: 1280, minHeight: 800)
        .preferredColorScheme(.dark)
    }

    private var timelineDockView: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                Button(action: { vm.isPlaying.toggle() }) {
                    Text(vm.isPlaying ? "Pause" : "Play")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 52)
                }
                .keyboardShortcut(.space, modifiers: [])
                .buttonStyle(.borderedProminent)
                .tint(vm.isPlaying ? .orange : .cyan)
                .controlSize(.small)

                Button(vm.timelineAtTop ? "↓ Stack Bottom" : "↑ Stack Top") {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                        vm.timelineAtTop.toggle()
                    }
                }
                .controlSize(.small)
                .help("Stack Timeline Bar on Top or Bottom of Application")

                Picker("", selection: $vm.activeClip) {
                    ForEach(vm.project.animations.keys.sorted(), id: \.self) { clipName in
                        Text(clipName.capitalized).tag(clipName)
                    }
                }
                .labelsHidden()
                .frame(width: 125)

                Slider(
                    value: $vm.currentTime,
                    in: 0...(max(0.1, vm.project.animations[vm.activeClip]?.duration ?? 2.4))
                )

                Text(String(format: "%.2fs / %.1fs", vm.currentTime, vm.project.animations[vm.activeClip]?.duration ?? 2.4))
                    .font(.system(size: 11, design: .monospaced))
                    .frame(width: 95, alignment: .trailing)

                Button(vm.dopeSheetExpanded ? "Hide Dope Sheet" : "Dope Sheet") {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                        vm.dopeSheetExpanded.toggle()
                    }
                }
                .controlSize(.small)

                Button(vm.timelineAtTop ? "↓ Bottom" : "↑ Top") {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                        vm.timelineAtTop.toggle()
                    }
                }
                .controlSize(.small)
                .help("Stack Timeline Bar at Top or Bottom of Screen")

                Divider().frame(height: 16)

                Text(vm.statusMessage)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.cyan)
                    .lineLimit(1)
                    .frame(maxWidth: 240, alignment: .leading)
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, vm.dopeSheetExpanded ? 4 : 10)

            if vm.dopeSheetExpanded {
                Divider().opacity(0.3)
                ScrollView {
                    VStack(alignment: .leading, spacing: 5) {
                        let clip = vm.project.animations[vm.activeClip]
                        let dur = max(0.1, clip?.duration ?? 2.4)
                        ForEach(vm.project.bones) { bone in
                            let keys = clip?.boneTracks[bone.name] ?? []
                            HStack(spacing: 10) {
                                Text(bone.name)
                                    .font(.system(size: 10, design: .monospaced))
                                    .frame(width: 95, alignment: .leading)
                                    .foregroundColor(bone.name == vm.selectedBone ? .cyan : .secondary)

                                GeometryReader { geo in
                                    ZStack(alignment: .leading) {
                                        Capsule()
                                            .fill(Color.black.opacity(0.35))
                                            .frame(height: 10)
                                        Rectangle()
                                            .fill(Color.cyan.opacity(0.8))
                                            .frame(width: 2, height: 14)
                                            .offset(x: CGFloat(vm.currentTime / dur) * max(1, geo.size.width - 6))

                                        ForEach(keys.indices, id: \.self) { kIdx in
                                            let kt = keys[kIdx].time
                                            Rectangle()
                                                .fill(Color.yellow)
                                                .frame(width: 7, height: 7)
                                                .rotationEffect(.degrees(45))
                                                .offset(x: CGFloat(kt / dur) * max(1, geo.size.width - 8))
                                                .onTapGesture {
                                                    vm.isPlaying = false
                                                    vm.currentTime = kt
                                                    vm.selectedBone = bone.name
                                                }
                                        }
                                    }
                                }
                                .frame(height: 14)
                            }
                            .padding(.horizontal, 18)
                        }
                    }
                    .padding(.bottom, 10)
                }
                .frame(height: 130)
            }
        }
        .liquidGlass(cornerRadius: 28, isPill: !vm.dopeSheetExpanded)
    }
}

@main
struct KineticProMacApplication: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var vm = MacStudioViewModel()

    var body: some Scene {
        WindowGroup("Kinetic Pro") {
            SpineForgeMainStudioView(vm: vm)
                .onAppear { appDelegate.viewModel = vm }
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Import Art…") { vm.importArtDialog() }
                    .keyboardShortcut("o", modifiers: [])
                Button("Open Project…") { vm.openProjectDialog() }
                    .keyboardShortcut("o", modifiers: [.command])
                Button("Save Project") { _ = vm.saveProject() }
                    .keyboardShortcut("s", modifiers: [.command])
                Button("Save Project As…") { _ = vm.saveProjectAs() }
                    .keyboardShortcut("s", modifiers: [.command, .shift])
            }
            CommandMenu("Rig & Mesh") {
                Button("Move / Free Transform Pose (V)") { vm.mode = .animate }
                    .keyboardShortcut("1", modifiers: [.command])
                Button("Bone & IK Pin Tool (P)") { vm.mode = .rig }
                    .keyboardShortcut("2", modifiers: [.command])
                Button("Puppet Warp Delaunay Mesh (M)") { vm.mode = .mesh }
                    .keyboardShortcut("3", modifiers: [.command])
                Button("GPU Weight Paint Brush (B)") { vm.mode = .weights }
                    .keyboardShortcut("4", modifiers: [.command])
                Button("1-Click Auto Rig (Vision)") {
                    vm.runAppleVisionAutoRig()
                    vm.pushHistorySnapshot()
                }
                .keyboardShortcut("a", modifiers: [.shift])
                Divider()
                Button("Toggle AI Copilot") { vm.showAiCopilot.toggle() }
                    .keyboardShortcut("k", modifiers: [.command])
                Button("Export Unity + Spine 4.2 Bundle…") {
                    vm.bakeAndExportOnMetal(revealInFinder: true)
                }
                .keyboardShortcut("e", modifiers: [.command])
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var viewModel: MacStudioViewModel?
    private var performanceActivity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hold interactive + latency-critical QoS so Metal keeps max GPU/RAM headroom.
        performanceActivity = MetalMaxPerformance.beginProcessBoost()
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        NSApp.windows.first?.title = "Kinetic Pro"
        if let device = viewModel?.renderer?.device {
            let quota = MetalMaxPerformance.quota(for: device)
            viewModel?.gpuQuotaLine = quota.statusLine
            viewModel?.statusMessage = "Max GPU/RAM · \(quota.statusLine)"
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MetalMaxPerformance.endProcessBoost(performanceActivity)
        performanceActivity = nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first, let vm = viewModel else { return }
        let ext = url.pathExtension.lowercased()
        if ext == "json" {
            vm.openProject(at: url)
        } else {
            vm.importArt(from: url)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let vm = viewModel, vm.isDirty else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "Save changes to “\(vm.project.title)”?"
        alert.informativeText = "Your Metal rig, weights, and clips have unsaved edits."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Don't Save")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            return vm.saveProject() ? .terminateNow : .terminateCancel
        case .alertSecondButtonReturn:
            return .terminateNow
        default:
            return .terminateCancel
        }
    }
}
