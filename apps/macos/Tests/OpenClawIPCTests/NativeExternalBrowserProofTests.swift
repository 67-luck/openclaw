import AppKit
import CoreGraphics
import Foundation
import Testing
import WebKit
@testable import OpenClaw

// One-shot proof branch only: real native app window, real WebKit bridge, real OS browser.
// The fixture mocks Gateway data, not the native handoff. It is not part of per-PR CI.
@MainActor
struct NativeExternalBrowserProofTests {
    private struct Configuration: Decodable {
        let uiUrl: URL
        let targetUrl: URL
        let artifactDir: URL
        let sourceSha: String
    }

    @Test(.timeLimit(.minutes(3)))
    func externalPreferenceOpensTheSystemBrowser() async throws {
        _ = AppKitTestSupport.application
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf:
            root.appendingPathComponent(".artifacts/native-link-proof/current.json")))
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        func wait(_ stage: String) async throws -> Data {
            let url = config.uiUrl.appendingPathComponent("__native-proof__/wait/" + stage)
            let (data, response) = try await session.data(from: url)
            try #require((response as? HTTPURLResponse)?.statusCode == 200)
            return data
        }
        let browserURL = try #require(NSWorkspace.shared.urlForApplication(toOpen: config.targetUrl))
        let browserBundle = try #require(Bundle(url: browserURL)?.bundleIdentifier)
        let priorBrowserPIDs = Set(NSRunningApplication.runningApplications(withBundleIdentifier: browserBundle)
            .map(\.processIdentifier))
        defer {
            for browser in NSRunningApplication.runningApplications(withBundleIdentifier: browserBundle)
                where !priorBrowserPIDs.contains(browser.processIdentifier)
            { browser.terminate() }
        }
        let auth = DashboardWindowAuth(
            gatewayUrl: config.uiUrl.absoluteString.replacingOccurrences(of: "http://", with: "ws://"),
            token: nil, password: nil)
        let controller = DashboardWindowController(
            url: config.uiUrl,
            auth: auth,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.update(
            url: config.uiUrl, auth: auth,
            restoringRoute: config.uiUrl.appendingPathComponent("settings/appearance"))
        controller.show()
        controller.window?.setContentSize(NSSize(width: 1280, height: 900))
        _ = try await wait("settings")
        try #require(try await controller.webView.evaluateJavaScript("""
        Boolean(window.webkit?.messageHandlers?.openclawLink && window.webkit?.messageHandlers?.openclawBrowser)
        """) as? Bool == true)
        let enabled = try await controller.webView.callAsyncJavaScript("""
        const row = [...document.querySelectorAll('.settings-row')].find(e =>
          e.querySelector('.settings-row__title')?.textContent.trim() === 'Open links outside OpenClaw');
        const toggle = row.querySelector('wa-switch');
        if (toggle.checked) throw new Error('Preference must start off');
        row.click();
        await document.querySelector('openclaw-config-page').updateComplete;
        await toggle.updateComplete;
        await document.fonts.ready;
        document.querySelector('#settings-appearance-chat').scrollIntoView();
        return toggle.checked;
        """, in: nil, contentWorld: .page) as? Bool
        try #require(enabled == true)
        try await self.capture(controller.webView, to: config.artifactDir.appendingPathComponent("native-setting-enabled.png"))
        controller.webView.load(URLRequest(url: config.uiUrl.appendingPathComponent("chat")))
        do {
            _ = try await wait("chat")
        } catch {
            let diagnostic = try? await controller.webView.evaluateJavaScript("""
            JSON.stringify({url:location.href,ready:document.readyState,body:document.body.innerText,
              errors:window.__nativeProofErrors,
              sockets:window.openclawControlUiE2eGateway?.socketStates(),
              requests:window.openclawControlUiE2eGateway?.requests.map(request => ({method:request.method,sessionKey:request.params?.sessionKey})),
              route:document.querySelector('openclaw-app')?.runtime?.router.getState()})
            """) as? String
            if let diagnostic {
                try diagnostic.write(to: config.artifactDir.appendingPathComponent("chat-failure.json"),
                                     atomically: true, encoding: .utf8)
            }
            try? await self.capture(controller.webView, to: config.artifactDir.appendingPathComponent("chat-failure.png"))
            throw error
        }
        let (beforeData, _) = try await session.data(from: config.uiUrl.appendingPathComponent("__native-proof__/state"))
        let before = try #require(JSONSerialization.jsonObject(with: beforeData) as? [String: Any])
        try #require(before["opened"] == nil)
        try #require(!controller.nativeBrowser.hasTabs)
        try await self.capture(controller.webView, to: config.artifactDir.appendingPathComponent("native-chat-before-click.png"))
        let consumed = try await controller.webView.callAsyncJavaScript("""
        const link = [...document.querySelectorAll('a')].find(a => a.href === target);
        if (!link) throw new Error('Proof link missing');
        let consumed = false;
        window.addEventListener('click', event => {
          if (event.composedPath().includes(link)) consumed = event.defaultPrevented;
        }, {once: true});
        link.click();
        return consumed;
        """, arguments: ["target": config.targetUrl.absoluteString], in: nil, contentWorld: .page) as? Bool
        try #require(consumed == true)
        let receiptData = try await wait("opened")
        let receipt = try #require(JSONSerialization.jsonObject(with: receiptData) as? [String: Any])
        try #require(receipt["url"] as? String == config.targetUrl.absoluteString)
        try #require(!controller.nativeBrowser.hasTabs)
        let browsers = NSRunningApplication.runningApplications(withBundleIdentifier: browserBundle)
        try #require(!browsers.isEmpty)
        var desktopCapture = "unavailable: screen-recording permission not granted"
        if CGPreflightScreenCaptureAccess() {
            let screenshot = Process()
            screenshot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            screenshot.arguments = ["-x", config.artifactDir.appendingPathComponent("mac-desktop-after-click.png").path]
            try screenshot.run()
            screenshot.waitUntilExit()
            desktopCapture = "exit \(screenshot.terminationStatus)"
        }
        let report: [String: Any] = [
            "sourceSha": config.sourceSha,
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "nativeHost": "Production DashboardWindowController and WKWebView in isolated Swift test process",
            "gateway": "Synthetic Gateway fixture; no native bridge mock",
            "defaultBrowserBundle": browserBundle,
            "browserProcessIds": browsers.map(\.processIdentifier),
            "browserRequest": receipt,
            "embeddedBrowserTabs": controller.nativeBrowser.hasTabs,
            "desktopCapture": desktopCapture,
            "passed": true,
        ]
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: config.artifactDir.appendingPathComponent("native-result.json"))
        print("Native external browser proof: \(browserBundle) received the exact dashboard link; no embedded tab was opened.")
    }

    private func capture(_ view: WKWebView, to url: URL) async throws {
        let image = try await view.takeSnapshot(configuration: nil)
        let tiff = try #require(image.tiffRepresentation)
        let bitmap = try #require(NSBitmapImageRep(data: tiff))
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: url)
    }
}
