// Faktury.app – vlastní okno aplikace. Spustí lokální server (spustit.sh) a zobrazí ho ve WebKitu.
// Sestavuje ho macos/sestavit.sh ve dvou podobách:
// - vývojová (instalovat.sh): spouští Faktury ze složky projektu, cestu má v Info.plist (FakturyFolder),
// - ke stažení z GitHubu: kód nese v Resources/app a při spuštění ho nakopíruje do Application Support,
//   kde žijí i data a vlastní Python. Aktualizace pak mění jen tu složku, samotná aplikace zůstává.
import AppKit
import WebKit

/// Složka s kódem a daty Faktur.
func fakturyFolder() -> URL {
    if let path = Bundle.main.object(forInfoDictionaryKey: "FakturyFolder") as? String {
        return URL(fileURLWithPath: path)
    }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("Faktury")
}

/// Verze ze souboru VERSION, třeba [1, 2, 0]. Prázdná, když soubor chybí.
func fakturyVersion(_ folder: URL) -> [Int] {
    let text = (try? String(contentsOf: folder.appendingPathComponent("VERSION"), encoding: .utf8)) ?? ""
    return text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".").map { Int($0) ?? 0 }
}

/// Spustí program a vrátí jeho návratový kód a chybový výstup.
func runTool(_ path: String, _ arguments: [String], environment: [String: String]? = nil) -> (status: Int32, error: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    if let environment = environment {
        process.environment = environment
    }
    let pipe = Pipe()
    process.standardError = pipe
    do {
        try process.run()
    } catch {
        return (-1, error.localizedDescription)
    }
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
}

/// Připraví složku Faktur a spustí server přes spustit.sh, pokud ještě neběží. Vrátí popis chyby, nebo nil.
/// Běží mimo hlavní vlákno: při prvním spuštění se stahuje Python a přístup ke složkám může čekat na macOS.
func startServer(folder: URL) -> String? {
    var environment = ProcessInfo.processInfo.environment
    let launcher = folder.appendingPathComponent("spustit.sh")
    if Bundle.main.object(forInfoDictionaryKey: "FakturyFolder") != nil {
        guard FileManager.default.isReadableFile(atPath: launcher.path) else {
            return "Složka aplikace není na svém místě:\n\(folder.path)\n\n"
                + "Pokud se přesunula, spusť v ní znovu instalovat.sh. "
                + "Pokud mají Faktury zakázaný přístup ke složce, povol ho v Nastavení systému → "
                + "Soukromí a zabezpečení → Soubory a složky."
        }
    } else {
        // Aplikace z GitHubu přinesla novější kód, než je ve složce (nebo složka ještě není): nakopíruje ho tam.
        let bundled = Bundle.main.resourceURL!.appendingPathComponent("app")
        if fakturyVersion(folder).lexicographicallyPrecedes(fakturyVersion(bundled)) {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = runTool("/usr/bin/ditto", ["--noqtn", bundled.path, folder.path])
            if copy.status != 0 {
                return "Nepodařilo se připravit složku \(folder.path). \(copy.error)"
            }
        }
        environment["FAKTURY_APP"] = Bundle.main.bundlePath
    }
    let result = runTool("/bin/bash", [launcher.path], environment: environment)
    if result.status != 0 {
        let detail = result.error.isEmpty ? "Podrobnosti jsou v souboru data/server.log ve složce Faktur." : result.error
        return "Server se nepodařilo spustit. \(detail)"
    }
    return nil
}

/// Co je v okně vidět, než naběhne server. Text se ukáže, až když spuštění trvá déle.
let startPage = """
    <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
    <style>
    body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
           font: 15px/1.5 -apple-system, sans-serif; background: #f5f5f7; color: #6e6e73; text-align: center; }
    @media (prefers-color-scheme: dark) { body { background: #000; color: #98989d; } }
    p { opacity: 0; animation: show 0.3s 1s forwards; }
    b { color: CanvasText; font-weight: 600; }
    @keyframes show { to { opacity: 1; } }
    </style>
    <p><b>Spouštím Faktury…</b><br>Při prvním spuštění se stahují potřebné součásti, může to minutu trvat.</p>
    """

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let url = URL(string: "http://localhost:8765/")!
    let folder = fakturyFolder()
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
        webView.loadHTMLString(startPage, baseURL: nil)
        window.makeKeyAndOrderFront(nil)
        connect()
    }

    /// Spustí server (pokud neběží) a načte do okna appku.
    func connect() {
        let folder = self.folder
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
        window.makeFirstResponder(webView)
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

    /// O aplikaci: verze kódu ze složky Faktur (aktualizace mění jen ji, ne aplikaci).
    @objc func showAbout(_ sender: Any?) {
        let version = fakturyVersion(folder).map(String.init).joined(separator: ".")
        NSApp.orderFrontStandardAboutPanel(options: [.applicationVersion: version, .version: ""])
    }

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
            item("O aplikaci Faktury", #selector(showAbout(_:)), "", target: self),
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
