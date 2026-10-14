// Faktury.app – vlastní okno aplikace. Spustí lokální server (spustit.sh) a zobrazí ho ve WebKitu.
// Sestavuje ho instalovat.sh. Složku projektu najde v Info.plist pod klíčem FakturyFolder.
import AppKit
import WebKit

/// Spustí server přes spustit.sh, pokud ještě neběží. Vrátí popis chyby, nebo nil.
/// Běží mimo hlavní vlákno: první přístup do Dokumentů může čekat na povolení od macOS.
func startServer(folder: String) -> String? {
    let launcher = URL(fileURLWithPath: folder).appendingPathComponent("spustit.sh")
    guard !folder.isEmpty, FileManager.default.isExecutableFile(atPath: launcher.path) else {
        return "Složka aplikace není na svém místě:\n\(folder)\n\n"
            + "Pokud se přesunula, spusť v ní znovu instalovat.sh. "
            + "Pokud mají Faktury zakázaný přístup ke složce, povol ho v Nastavení systému → "
            + "Soukromí a zabezpečení → Soubory a složky."
    }
    let process = Process()
    process.executableURL = launcher
    do {
        try process.run()
    } catch {
        return error.localizedDescription
    }
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        return "Server se nepodařilo spustit. Podrobnosti jsou v souboru data/server.log ve složce aplikace."
    }
    return nil
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let url = URL(string: "http://localhost:8765/")!
    let zoomSteps: [CGFloat] = [0.5, 0.67, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 1.75, 2]
    var window: NSWindow!
    var webView: WKWebView!
    var titleObservation: NSKeyValueObservation?
    var canClose = false  // neuložené změny už jsou potvrzené (nebo žádné nebyly)

    // ---------- spuštění ----------

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false

        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        let zoom = UserDefaults.standard.double(forKey: "zoom")
        webView.pageZoom = zoom > 0 ? CGFloat(zoom) : 1
        webView.isHidden = true  // ukáže se až načtená stránka, ať okno nebliká bíle
        titleObservation = webView.observe(\.title) { [weak self] webView, _ in
            let title = (webView.title ?? "").replacingOccurrences(of: " – Faktury", with: "")
            self?.window.title = title.isEmpty ? "Faktury" : title
        }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.title = "Faktury"
        // Barva pozadí stránky z app.css (--bg), než se stránka načte.
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? .black : NSColor(srgbRed: 245 / 255, green: 245 / 255, blue: 247 / 255, alpha: 1)
        }
        window.minSize = NSSize(width: 480, height: 400)
        window.contentView = webView
        window.center()
        _ = window.setFrameAutosaveName("Faktury")

        NSApp.mainMenu = makeMainMenu()
        window.makeKeyAndOrderFront(nil)
        connect()
    }

    /// Spustí server (pokud neběží) a načte do okna appku.
    func connect() {
        let folder = Bundle.main.object(forInfoDictionaryKey: "FakturyFolder") as? String ?? ""
        DispatchQueue.global(qos: .userInitiated).async {
            let error = startServer(folder: folder)
            DispatchQueue.main.async {
                if let error = error {
                    self.fail(error)
                } else {
                    self.webView.load(URLRequest(url: self.url))
                }
            }
        }
    }

    /// Ukáže chybu a nabídne nový pokus, nebo ukončení.
    func fail(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Faktury nejdou spustit"
        alert.informativeText = message
        alert.addButton(withTitle: "Zkusit znovu")
        alert.addButton(withTitle: "Ukončit")
        if alert.runModal() == .alertFirstButtonReturn {
            connect()
        } else {
            canClose = true
            NSApp.terminate(nil)
        }
    }

    // ---------- zavření ----------

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if canClose { return true }
        confirmLeave { leave in
            guard leave else { return }
            self.canClose = true
            sender.close()
        }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if canClose { return .terminateNow }
        confirmLeave { leave in
            self.canClose = leave
            sender.reply(toApplicationShouldTerminate: leave)
        }
        return .terminateLater
    }

    /// Jako prohlížeč: při neuložených změnách ve formuláři (leaveGuard v app.js) se zeptá.
    func confirmLeave(_ done: @escaping (Bool) -> Void) {
        webView.evaluateJavaScript("typeof leaveGuard === 'function' && !!leaveGuard()") { result, _ in
            guard (result as? Bool) == true else { return done(true) }
            let alert = NSAlert()
            alert.messageText = "Máš neuložené změny. Opravdu odejít?"
            alert.addButton(withTitle: "Odejít")
            alert.addButton(withTitle: "Zrušit")
            alert.beginSheetModal(for: self.window) { done($0 == .alertFirstButtonReturn) }
        }
    }

    // ---------- navigace ----------

    /// Adresy appky. Ostatní odkazy se otevřou v prohlížeči.
    func isOwn(_ target: URL) -> Bool {
        switch target.scheme ?? "" {
        case "http", "https":
            return target.host == url.host && target.port == url.port
        case "about", "blob", "data":
            return true
        default:
            return false
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let target = navigationAction.request.url, !isOwn(target) {
            NSWorkspace.shared.open(target)
            decisionHandler(.cancel)
        } else {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let http = navigationResponse.response as? HTTPURLResponse
        let disposition = http?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let download = !navigationResponse.canShowMIMEType || disposition.hasPrefix("attachment")
        decisionHandler(download ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.isHidden {
            webView.isHidden = false
            window.makeFirstResponder(webView)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        let error = error as NSError
        // Zrušené načtení (třeba když se z odkazu stane stahování) není chyba.
        guard error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled else { return }
        fail("Server Faktur neodpovídá (\(error.localizedDescription)).")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // ---------- dialogy z JavaScriptu ----------

    /// Text „Otázka?\n\nPodrobnosti“ rozdělí na nadpis dialogu a popis pod ním.
    func makeAlert(_ message: String) -> NSAlert {
        let parts = message.components(separatedBy: "\n\n")
        let alert = NSAlert()
        alert.messageText = parts[0]
        alert.informativeText = parts.dropFirst().joined(separator: "\n\n")
        return alert
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        makeAlert(message).beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = makeAlert(message)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Zrušit")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    /// Odkazy s target="_blank" (třeba doklad k příjmu) otevře v prohlížeči.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let target = navigationAction.request.url {
            NSWorkspace.shared.open(target)
        }
        return nil
    }

    // ---------- stahování (PDF faktury, záloha dat) ----------

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let target = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: target)  // přepsání už potvrdil dialog
            completionHandler(target)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        NSAlert(error: error).beginSheetModal(for: window, completionHandler: nil)
    }

    // ---------- menu ----------

    @objc func actualSize(_ sender: Any?) { setZoom(1) }
    @objc func zoomIn(_ sender: Any?) { setZoom(zoomSteps.first { $0 > webView.pageZoom + 0.01 } ?? webView.pageZoom) }
    @objc func zoomOut(_ sender: Any?) { setZoom(zoomSteps.last { $0 < webView.pageZoom - 0.01 } ?? webView.pageZoom) }

    func setZoom(_ zoom: CGFloat) {
        webView.pageZoom = zoom
        UserDefaults.standard.set(Double(zoom), forKey: "zoom")
    }

    func makeMainMenu() -> NSMenu {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector, _ key: String,
                  _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
            menuItem.keyEquivalentModifierMask = modifiers
            menuItem.target = target
            return menuItem
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            menu.items = items
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = menu
            main.addItem(holder)
            return menu
        }

        _ = submenu("Faktury", [
            item("O aplikaci Faktury", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            item("Skrýt aplikaci Faktury", #selector(NSApplication.hide(_:)), "h"),
            item("Skrýt ostatní", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Zobrazit vše", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            item("Ukončit aplikaci Faktury", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu("Úpravy", [
            item("Odvolat", Selector(("undo:")), "z"),
            item("Znovu", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Vyjmout", #selector(NSText.cut(_:)), "x"),
            item("Kopírovat", #selector(NSText.copy(_:)), "c"),
            item("Vložit", #selector(NSText.paste(_:)), "v"),
            item("Vybrat vše", #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = submenu("Zobrazení", [
            item("Zpět", #selector(WKWebView.goBack(_:)), "[", target: webView),
            item("Vpřed", #selector(WKWebView.goForward(_:)), "]", target: webView),
            item("Načíst znovu", #selector(WKWebView.reload(_:)), "r", target: webView),
            .separator(),
            item("Skutečná velikost", #selector(actualSize(_:)), "0", target: self),
            item("Zvětšit", #selector(zoomIn(_:)), "+", target: self),
            item("Zmenšit", #selector(zoomOut(_:)), "-", target: self),
        ])
        NSApp.windowsMenu = submenu("Okno", [
            item("Minimalizovat", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zavřít", #selector(NSWindow.performClose(_:)), "w"),
        ])
        return main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
