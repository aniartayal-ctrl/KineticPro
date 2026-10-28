import AppKit
import WebKit
import Foundation
import UniformTypeIdentifiers

/// Native macOS shell for the Claude Kinetic Pro studio (Next.js on 127.0.0.1:3460).
/// Menu bar shortcuts (Undo/Redo/Save/Quit/Fullscreen) and Finder drag-drop land here,
/// then bridge into the WKWebView studio.
@main
enum KineticProStudioMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}

/// Fills the window; hosts the WKWebView and accepts Finder file drops on the chrome.
final class StudioHostView: NSView {
    weak var owner: AppDelegate?
    private let webView: WKWebView

    init(frame: NSRect, webView: WKWebView) {
        self.webView = webView
        super.init(frame: frame)
        wantsLayer = true
        addSubview(webView)
        registerForDraggedTypes([.fileURL])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        webView.frame = bounds
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        owner?.canAcceptDrop(sender) == true ? .copy : []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        owner?.canAcceptDrop(sender) == true ? .copy : []
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true
        ]) as? [URL], !urls.isEmpty else { return false }
        owner?.importURLs(urls)
        return true
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var hostView: StudioHostView!
    var studioProcess: Process?
    var pollTimer: Timer?
    let studioURL = URL(string: "http://127.0.0.1:3460")!
    let workspaceRoot: URL = {
        if let env = ProcessInfo.processInfo.environment["KINETIC_ROOT"], !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        return Bundle.main.bundleURL.deletingLastPathComponent()
    }()

    private let importExtensions: Set<String> = ["png", "webp", "psd", "jpg", "jpeg"]

    func applicationDidFinishLaunching(_ notification: Notification) {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let frame = NSRect(
            x: screen.midX - 720,
            y: screen.midY - 450,
            width: min(1440, screen.width),
            height: min(900, screen.height)
        )

        // Standard titlebar (not fullSizeContentView) so traffic lights never overlap the studio chrome.
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Kinetic Pro"
        window.titlebarAppearsTransparent = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(calibratedRed: 0.02, green: 0.03, blue: 0.07, alpha: 1)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("KineticProStudioMain")
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.center()

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false

        hostView = StudioHostView(frame: .zero, webView: webView)
        hostView.owner = self
        window.contentView = hostView

        buildMainMenu()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        ensureStudioRunningThenLoad()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func application(_ application: NSApplication, open urls: [URL]) {
        importURLs(urls)
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        if let proc = studioProcess, proc.isRunning {
            proc.terminate()
            proc.waitUntilExit()
        }
    }

    // MARK: - Menu

    private func buildMainMenu() {
        let mainMenu = NSMenu()

        // Application
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        let about = NSMenuItem(title: "About Kinetic Pro", action: #selector(menuAbout(_:)), keyEquivalent: "")
        about.target = self
        appMenu.addItem(about)
        appMenu.addItem(.separator())
        let prefs = NSMenuItem(title: "Preferences…", action: #selector(menuPreferences(_:)), keyEquivalent: ",")
        prefs.target = self
        appMenu.addItem(prefs)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Kinetic Pro", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(
            title: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthers.keyEquivalentModifierMask = [.option, .command]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Kinetic Pro", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        // File
        let fileItem = NSMenuItem()
        fileItem.title = "File"
        let fileMenu = NSMenu(title: "File")
        let open = NSMenuItem(title: "Open…", action: #selector(menuOpen(_:)), keyEquivalent: "o")
        open.target = self
        fileMenu.addItem(open)
        let recentRoot = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        let recentMenu = NSMenu(title: "Open Recent")
        let refreshRecent = NSMenuItem(title: "Refresh List", action: #selector(menuRefreshRecent(_:)), keyEquivalent: "")
        refreshRecent.target = self
        recentMenu.addItem(refreshRecent)
        recentRoot.submenu = recentMenu
        fileMenu.addItem(recentRoot)
        let importItem = NSMenuItem(title: "Import Character…", action: #selector(menuImportCharacter(_:)), keyEquivalent: "i")
        importItem.keyEquivalentModifierMask = [.command, .shift]
        importItem.target = self
        fileMenu.addItem(importItem)
        fileMenu.addItem(.separator())
        let save = NSMenuItem(title: "Save", action: #selector(menuSave(_:)), keyEquivalent: "s")
        save.target = self
        fileMenu.addItem(save)
        let exportItem = NSMenuItem(title: "Export…", action: #selector(menuExport(_:)), keyEquivalent: "e")
        exportItem.target = self
        fileMenu.addItem(exportItem)
        fileItem.submenu = fileMenu
        mainMenu.addItem(fileItem)
        // Populate recent after the webview can answer.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.menuRefreshRecent(nil)
        }

        // Edit
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        let undo = NSMenuItem(title: "Undo", action: #selector(menuUndo(_:)), keyEquivalent: "z")
        undo.target = self
        editMenu.addItem(undo)
        let redo = NSMenuItem(title: "Redo", action: #selector(menuRedo(_:)), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        redo.target = self
        editMenu.addItem(redo)
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        // View
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let fullScreen = NSMenuItem(
            title: "Enter Full Screen",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        )
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        fullScreen.target = window
        viewMenu.addItem(fullScreen)
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        // Window
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func menuAbout(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Kinetic Pro"
        alert.informativeText = "Visual Physics studio\nBuilt by Amit Tayal"
        alert.alertStyle = .informational
        alert.runModal()
    }

    @objc private func menuPreferences(_ sender: Any?) { runStudioCommand("panel.preferences") }
    @objc private func menuOpen(_ sender: Any?) { runStudioCommand("file.open") }
    @objc private func menuSave(_ sender: Any?) { runStudioCommand("file.save") }
    @objc private func menuExport(_ sender: Any?) { runStudioCommand("file.export") }
    @objc private func menuUndo(_ sender: Any?) { runStudioCommand("edit.undo") }
    @objc private func menuRedo(_ sender: Any?) { runStudioCommand("edit.redo") }

    @objc private func menuRefreshRecent(_ sender: Any?) {
        let js = """
        (function(){
          try {
            var raw = localStorage.getItem('kinetic.preferences.v1');
            if (!raw) return [];
            var p = JSON.parse(raw);
            return Array.isArray(p.recentProjects) ? p.recentProjects.slice(0,8) : [];
          } catch(e) { return []; }
        })()
        """
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            guard let self else { return }
            let items = (result as? [[String: Any]]) ?? []
            DispatchQueue.main.async {
                guard let fileMenu = NSApp.mainMenu?.item(withTitle: "File")?.submenu,
                      let recentRoot = fileMenu.item(withTitle: "Open Recent"),
                      let recentMenu = recentRoot.submenu else { return }
                recentMenu.removeAllItems()
                if items.isEmpty {
                    let empty = NSMenuItem(title: "No Recent Projects", action: nil, keyEquivalent: "")
                    empty.isEnabled = false
                    recentMenu.addItem(empty)
                } else {
                    for (idx, row) in items.enumerated() {
                        let title = (row["title"] as? String) ?? (row["id"] as? String) ?? "Project"
                        let id = (row["id"] as? String) ?? ""
                        let item = NSMenuItem(title: title, action: #selector(self.menuOpenRecent(_:)), keyEquivalent: "")
                        item.target = self
                        item.representedObject = id
                        if idx < 9 { item.keyEquivalent = "\(idx + 1)"; item.keyEquivalentModifierMask = [.command, .option] }
                        recentMenu.addItem(item)
                    }
                }
                recentMenu.addItem(.separator())
                let refresh = NSMenuItem(title: "Refresh List", action: #selector(self.menuRefreshRecent(_:)), keyEquivalent: "")
                refresh.target = self
                recentMenu.addItem(refresh)
            }
        }
    }

    @objc private func menuOpenRecent(_ sender: Any?) {
        guard let item = sender as? NSMenuItem, let id = item.representedObject as? String, !id.isEmpty else { return }
        let escaped = id.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        let js = "window.dispatchEvent(new CustomEvent('kinetic:open-recent',{detail:{id:'\(escaped)'}}));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    @objc private func menuImportCharacter(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [
            .png, .webP, .jpeg,
            UTType(filenameExtension: "psd") ?? .image
        ].compactMap { $0 }
        panel.message = "Import a character PSD, PNG, WebP, or JPEG"
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.importURLs([url])
        }
    }

    private func runStudioCommand(_ id: String) {
        let escaped = id.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        let js = "window.dispatchEvent(new CustomEvent('kinetic:command',{detail:{id:'\(escaped)'}}));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Drag / open files

    func canAcceptDrop(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true
        ]) as? [URL] else { return false }
        return urls.contains { isImportable($0) }
    }

    func importURLs(_ urls: [URL]) {
        guard let url = urls.first(where: { isImportable($0) }) else {
            showBootError("Drop a .png, .webp, .jpg, or .psd character.")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let data = try Data(contentsOf: url)
                let b64 = data.base64EncodedString()
                let name = url.lastPathComponent
                let mime = self.mimeType(for: url)
                // Keep payload in a JS string; large PSDs are still fine for typical character art.
                let jsName = self.jsString(name)
                let jsMime = self.jsString(mime)
                let js = """
                window.dispatchEvent(new CustomEvent('kinetic:import-file',{detail:{name:\(jsName),mime:\(jsMime),base64:'\(b64)'}}));
                """
                DispatchQueue.main.async {
                    self.webView.evaluateJavaScript(js, completionHandler: { _, error in
                        if let error {
                            self.showBootError("Could not hand file to studio:\n\(error.localizedDescription)")
                        }
                    })
                }
            } catch {
                DispatchQueue.main.async {
                    self.showBootError("Could not read \(url.lastPathComponent):\n\(error.localizedDescription)")
                }
            }
        }
    }

    private func isImportable(_ url: URL) -> Bool {
        importExtensions.contains(url.pathExtension.lowercased())
    }

    private func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "png": return "image/png"
        case "webp": return "image/webp"
        case "jpg", "jpeg": return "image/jpeg"
        case "psd": return "image/vnd.adobe.photoshop"
        default: return "application/octet-stream"
        }
    }

    private func jsString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "'\(escaped)'"
    }

    // MARK: - Studio server

    private func ensureStudioRunningThenLoad() {
        if isStudioUp() {
            loadStudio()
            return
        }
        startStudioServer()
        var attempts = 0
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            attempts += 1
            if self.isStudioUp() {
                timer.invalidate()
                self.loadStudio()
            } else if attempts > 75 {
                timer.invalidate()
                self.showBootError(
                    "Studio did not start on port 3460.\n\nFrom Terminal:\n  cd \(self.workspaceRoot.path)\n  npm run dev\n\nThen reopen Kinetic Pro."
                )
            }
        }
    }

    private func isStudioUp() -> Bool {
        var request = URLRequest(url: studioURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 0.6)
        request.httpMethod = "HEAD"
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, (200..<500).contains(http.statusCode) {
                ok = true
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 0.8)
        return ok
    }

    private func startStudioServer() {
        let packageJSON = workspaceRoot.appendingPathComponent("package.json")
        guard FileManager.default.fileExists(atPath: packageJSON.path) else {
            showBootError("Could not find package.json next to Kinetic Pro.app.\nExpected repo at:\n\(workspaceRoot.path)")
            return
        }

        let hasBuild = FileManager.default.fileExists(
            atPath: workspaceRoot.appendingPathComponent(".next").path
        )
        let script = hasBuild ? "start" : "dev"
        let pathEnv = "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.local/node/bin:/usr/bin:/bin"

        let proc = Process()
        proc.currentDirectoryURL = workspaceRoot
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-lc", "export PATH=\"\(pathEnv):$PATH\"; npm run \(script)"]
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "PATH": pathEnv,
            "PORT": "3460",
            "HOSTNAME": "127.0.0.1"
        ]) { _, new in new }

        let log = FileManager.default.temporaryDirectory.appendingPathComponent("kinetic-pro-studio.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: log) {
            proc.standardOutput = fh
            proc.standardError = fh
        }

        do {
            try proc.run()
            studioProcess = proc
        } catch {
            showBootError("Failed to start studio server:\n\(error.localizedDescription)")
        }
    }

    private func loadStudio() {
        webView.load(URLRequest(url: studioURL))
    }

    private func showBootError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Kinetic Pro"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.loadStudio()
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let host = url.host?.lowercased() ?? ""
        let isLocalStudio = (host == "127.0.0.1" || host == "localhost") && (url.port == 3460 || url.port == nil)
        if navigationAction.navigationType == .linkActivated, !isLocalStudio {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}
