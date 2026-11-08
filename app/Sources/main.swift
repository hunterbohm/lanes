// Lanes for macOS: a menu bar glyph of tiny lanes, one per machine, each as long as the number of CI jobs running
// there, with the total beside it. Click it (or open lanes://toggle) for the charts page that `lanes hub` serves.
// Right-click for Refresh, Open in Browser, Server Address… and Quit.
import Cocoa
import WebKit

let defaultServer = "http://127.0.0.1:8792/"
let failureShownFor: TimeInterval = 30 * 60      // a failed job puts a red dot by the count for this long
let panelWidth: CGFloat = 460

struct Job: Decodable {
    let state: String?
    let result: String?
    let finished: Double?
}

struct Machine: Decodable {
    let name: String
    let jobs: [Job]
}

struct Status: Decodable {
    let running: Int
    let machines: [Machine]
    let recent: [Job]
}

var server: URL {
    let text = UserDefaults.standard.string(forKey: "server") ?? defaultServer
    return URL(string: text.hasSuffix("/") ? text : text + "/") ?? URL(string: defaultServer)!
}

/// Up to four short horizontal lanes, one per machine, as a template image the menu bar tints for light or dark.
func lanesImage(_ counts: [Int]) -> NSImage {
    let rows = Array(counts.prefix(4))
    let lane = rows.count > 3 ? 2.0 : 2.5, gap = rows.count > 3 ? 1.5 : 2.0, width = 16.0
    let height = 16.0
    let total = Double(max(rows.count, 1)) * lane + Double(max(rows.count - 1, 0)) * gap
    let top = Double(max(4, rows.max() ?? 0))
    let image = NSImage(size: NSSize(width: width, height: height), flipped: true) { _ in
        var y = (height - total) / 2
        for count in rows.isEmpty ? [0] : rows {
            let w = count == 0 ? 3.0 : max(5.0, width * Double(count) / top)
            NSColor.black.withAlphaComponent(count == 0 ? 0.4 : 1).setFill()
            NSBezierPath(roundedRect: NSRect(x: 0, y: y, width: w, height: lane), xRadius: lane / 2, yRadius: lane / 2).fill()
            y += lane + gap
        }
        return true
    }
    image.isTemplate = true
    return image
}

/// A borderless panel that can take keys (Esc closes it) without making Lanes the active app.
final class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
    var item: NSStatusItem!
    var panel: Panel!
    var web: WKWebView!
    var status: Status?
    var reachable = true
    var pageFailed = false
    var closedAt = Date.distantPast
    var outsideClicks: Any?

    // Registered before launch finishes, so the lanes:// link that launched the app isn't lost.
    func applicationWillFinishLaunching(_ note: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(openURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.imagePosition = .imageLeading
        item.button?.target = self
        item.button?.action = #selector(clicked)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        item.button?.setAccessibilityTitle("Lanes")

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "lanes")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: 600), configuration: config)
        web.setValue(false, forKey: "drawsBackground")      // the panel's material shows through
        web.uiDelegate = self
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]

        let material = NSVisualEffectView(frame: web.frame)
        material.material = .popover
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = 14
        material.layer?.cornerCurve = .continuous
        material.layer?.masksToBounds = true
        material.layer?.borderWidth = 0.5
        material.layer?.borderColor = NSColor.separatorColor.cgColor
        material.addSubview(web)

        panel = Panel(contentRect: material.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.contentView = material
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        loadPage()

        draw()
        fetch()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.fetch() }
    }

    func loadPage() {
        web.load(URLRequest(url: URL(string: "?in=menubar", relativeTo: server)!))
    }

    // MARK: menu bar glyph

    func fetch() {
        let request = URLRequest(url: URL(string: "status.json", relativeTo: server)!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let decoded = data.flatMap { try? JSONDecoder().decode(Status.self, from: $0) }
            DispatchQueue.main.async {
                self.reachable = decoded != nil
                if let decoded { self.status = decoded }
                self.draw()
            }
        }.resume()
    }

    func draw() {
        guard let button = item.button else { return }
        let machines = status?.machines ?? []
        let counts = machines.map { $0.jobs.filter { ($0.state ?? "running") == "running" }.count }
        button.image = lanesImage(reachable ? counts : [])
        let running = status?.running ?? 0
        let now = Date().timeIntervalSince1970
        let failed = status?.recent.contains { $0.result == "failure" && now - ($0.finished ?? 0) < failureShownFor } ?? false
        let title = NSMutableAttributedString(string: reachable ? " \(running)" : " –", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .medium)])
        if failed && reachable {
            title.append(NSAttributedString(string: " ●", attributes: [
                .font: NSFont.systemFont(ofSize: 7), .foregroundColor: NSColor.systemRed, .baselineOffset: 2.5]))
        }
        button.attributedTitle = title
        let perMachine = zip(machines.map(\.name), counts).map { "\($0) \($1)" }.joined(separator: ", ")
        button.toolTip = !reachable ? "Lanes: can't reach \(server.absoluteString)"
            : "\(running) CI job\(running == 1 ? "" : "s") running\(perMachine.isEmpty ? "" : " (\(perMachine))")\(failed ? "\nA job failed in the last 30 minutes" : "")"
    }

    // MARK: clicks

    @objc func clicked() {
        if NSApp.currentEvent?.type == .rightMouseUp { return showMenu() }
        toggle()
    }

    func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Refresh", action: #selector(refresh), keyEquivalent: "r").target = self
        menu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o").target = self
        menu.addItem(withTitle: "Server Address…", action: #selector(askServer), keyEquivalent: ",").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Lanes", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
        item.button?.performClick(nil)
        item.menu = nil
    }

    func toggle() {
        if panel.isVisible { return close() }
        // The click that closed the panel (outside it) also lands on the glyph; don't reopen at once.
        if Date().timeIntervalSince(closedAt) < 0.3 { return }
        show()
    }

    /// Where the panel's top-center goes. Under the glyph when the click came from the macOS menu bar. Otherwise (a
    /// custom bar pressed the hidden menu bar item through Accessibility, or lanes://toggle came from a hotkey) under
    /// the pointer if it is near the top of a screen, else at the top-right of the pointer's screen.
    func anchor() -> NSPoint {
        let mouse = NSEvent.mouseLocation
        if let event = NSApp.currentEvent, event.type == .leftMouseUp, let button = item.button, let window = button.window,
           window.frame.contains(mouse) {
            let frame = window.convertToScreen(button.convert(button.bounds, to: nil))
            return NSPoint(x: frame.midX, y: frame.minY - 6)
        }
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
        if mouse.y > screen.frame.maxY - 64 { return NSPoint(x: mouse.x, y: min(mouse.y - 16, screen.frame.maxY - 30)) }
        return NSPoint(x: screen.visibleFrame.maxX - panelWidth / 2 - 12, y: screen.visibleFrame.maxY - 8)
    }

    func show() {
        if pageFailed || web.url == nil { loadPage() }
        place(height: panel.frame.height > 100 ? panel.frame.height : 640)
        panel.orderFrontRegardless()
        panel.makeKey()
        outsideClicks = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in self?.close() }
    }

    func place(height wanted: CGFloat, at point: NSPoint? = nil) {
        let top = point ?? (panel.isVisible ? NSPoint(x: panel.frame.midX, y: panel.frame.maxY) : anchor())
        let screen = NSScreen.screens.first { NSMouseInRect(top, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
        let room = screen.visibleFrame
        let height = min(wanted, top.y - room.minY - 12)
        var x = top.x - panelWidth / 2
        x = max(room.minX + 8, min(x, room.maxX - panelWidth - 8))
        panel.setFrame(NSRect(x: x, y: top.y - height, width: panelWidth, height: height), display: true)
    }

    func close() {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        closedAt = Date()
        if let monitor = outsideClicks { NSEvent.removeMonitor(monitor) }
        outsideClicks = nil
    }

    func windowDidResignKey(_ notification: Notification) { close() }

    @objc func openURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let url = URL(string: text) else { return }
        switch url.host {
        case "show": if !panel.isVisible { show() }
        case "hide": close()
        default: toggle()
        }
    }

    @objc func refresh() {
        fetch()
        loadPage()
    }

    @objc func openInBrowser() { NSWorkspace.shared.open(server) }

    @objc func askServer() {
        let alert = NSAlert()
        alert.messageText = "Lanes server address"
        alert.informativeText = "Where `lanes hub` serves its page. Through an SSH tunnel it is usually \(defaultServer)"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = server.absoluteString
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn, URL(string: field.stringValue)?.scheme?.hasPrefix("http") == true else { return }
        UserDefaults.standard.set(field.stringValue, forKey: "server")
        refresh()
    }

    // MARK: the page

    /// The page reports its height (the panel fits it) and asks to close on Esc.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["close"] != nil { close() }
        if let height = body["height"] as? Double, abs(panel.frame.height - CGFloat(height)) > 2 {
            if panel.isVisible { place(height: CGFloat(height)) } else { panel.setContentSize(NSSize(width: panelWidth, height: CGFloat(height))) }
        }
    }

    // Links (a job's GitHub page) open in the default browser, never inside the panel. Only web links: the page's
    // data comes from agents and sources, so anything else (file:, other apps' schemes) is ignored.
    func openWebLink(_ url: URL?) {
        guard let url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
        close()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        openWebLink(action.request.url)
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .linkActivated, let url = action.request.url, url.host != server.host {
            openWebLink(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.scheme?.hasPrefix("http") == true { pageFailed = false }    // not the error page
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }     // a newer load replaced this one
        pageFailed = true
        let address = server.absoluteString.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        webView.loadHTMLString("""
            <body style="font:13px -apple-system;color:#888;text-align:center;padding:48px 24px;margin:0">
            <b style="color:CanvasText;display:block;margin-bottom:6px">Can't reach the Lanes hub</b>
            Nothing answers at \(address).<br>Is <code>lanes hub</code> running, and the tunnel to it up?
            <script>webkit.messageHandlers.lanes.postMessage({height: document.documentElement.scrollHeight})</script>
            </body>
            """, baseURL: nil)
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
