import CryptoKit
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
private enum AccessRestartProof {
    struct Receipt: Codable {
        let nonce: String
        let source: String
        let processID: Int32
        let bundleID: String
        let container: String
        let executableSHA256: String
        let expiresAt: Date
    }

    static func environment(_ key: String) throws -> String {
        try #require(ProcessInfo.processInfo.environment["OPENCLAW_ACCESS_RESTART_" + key])
    }

    static func nonce() throws -> String {
        let value = try self.environment("NONCE")
        try #require(UUID(uuidString: value) != nil)
        return value
    }

    static func origin(control: Bool = false) throws -> CloudflareAccessOrigin {
        let prefix = control ? "control" : "signed-out"
        return try CloudflareAccessOrigin(#require(URL(string: "https://\(prefix)-\(self.nonce()).example.test")))
    }

    static func stableID() throws -> String {
        try "manual|\(#require(self.origin().url.host))|443"
    }

    static func receiptURL() throws -> URL {
        let directory = try #require(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first)
        return try directory.appendingPathComponent("access-restart-\(self.nonce()).plist")
    }

    static func executableDigest() throws -> String {
        let executable = try #require(Bundle.main.executableURL)
        return try SHA256.hash(data: Data(contentsOf: executable)).map { String(format: "%02x", $0) }.joined()
    }

    static func session(control: Bool, expires: Date) throws -> CloudflareAccessSession {
        let issuer = try #require(URL(string: "https://example.cloudflareaccess.com"))
        let application = try CloudflareAccessApplication(
            origin: self.origin(control: control),
            issuer: issuer,
            audience: "restart-test")
        let subject = control ? "untouched-control" : "acknowledged-sign-out"
        let token = try CloudflareAccessTestTokens().token([
            "iss": issuer.absoluteString, "aud": [application.audience],
            "type": "app", "sub": subject, "exp": expires.timeIntervalSince1970,
        ])
        return CloudflareAccessSession(application: application, subject: subject, token: token, expiresAt: expires)
    }

    static func checkPairingAndProfile() throws {
        let id = try self.stableID()
        let entry = try #require(GatewaySettingsStore.loadGatewayRegistry().entries.first { $0.stableID == id })
        #expect(try entry.accessOrigin == (self.origin()))
        #expect(entry.useTLS && entry.port == 443 && entry.name == "Access restart fixture")
        #expect(entry.lastConnectedAtMs == 1_700_000_000_123)
        let credentials = try GatewaySettingsStore.loadGatewayCredentials(instanceId: self.nonce(), gatewayStableID: id)
        #expect(credentials.token == "restart-pairing-token")
        #expect(credentials.password == "restart-pairing-password")
        #expect(credentials.bootstrapToken == nil && credentials.suppressStoredDeviceAuth)
        #expect(GatewaySettingsStore
            .loadGatewayCustomHeaders(gatewayStableID: id) == ["X-Existing-Ingress": "preserved"])
    }

    static func cleanup() throws {
        let persistence = CloudflareAccessSessionStore.Persistence.keychain
        #expect(try persistence.delete(self.origin()))
        #expect(try persistence.delete(self.origin(control: true)))
        let id = try self.stableID()
        _ = GatewaySettingsStore.saveGatewayCustomHeaders([:], gatewayStableID: id)
        try GatewaySettingsStore.deleteGatewayCredentials(instanceId: self.nonce(), stableID: id)
        _ = GatewaySettingsStore.removeGatewayRegistryEntry(stableID: id)
        try FileManager.default.removeItem(at: self.receiptURL())
    }
}

@Suite(.serialized)
struct GatewayAccessRestartSeedTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ACCESS_RESTART_PHASE"] == "seed"))
    @MainActor func `seed acknowledged sign out`() async throws {
        let nonce = try AccessRestartProof.nonce()
        let origin = try AccessRestartProof.origin()
        let control = try AccessRestartProof.origin(control: true)
        let stableID = try AccessRestartProof.stableID()
        let persistence = CloudflareAccessSessionStore.Persistence.keychain
        try #require(persistence.load(origin) == nil && persistence.load(control) == nil)
        try #require(!FileManager.default.fileExists(atPath: AccessRestartProof.receiptURL().path))
        try #require(!GatewaySettingsStore.loadGatewayRegistry().entries.contains { $0.stableID == stableID })
        let expires = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970) + 3600)
        for isControl in [false, true] {
            let session = try AccessRestartProof.session(control: isControl, expires: expires)
            let store = CloudflareAccessSessionStore(authenticate: { _, _ in session }, retireTransports: { _ in })
            let application = CloudflareAccessApplication(
                origin: session.origin,
                issuer: session.issuer,
                audience: session.audience)
            _ = try await store.signIn(application: application, openBrowser: { _ in }).value
            try #require(persistence.load(session.origin) != nil)
        }
        let entry = GatewaySettingsStore.GatewayRegistryEntry(
            stableID: stableID,
            kind: .manual,
            name: "Access restart fixture",
            host: origin.url.host,
            port: 443,
            useTLS: true,
            accessOrigin: origin,
            lastConnectedAtMs: 1_700_000_000_123)
        try #require(GatewaySettingsStore.upsertGatewayRegistryEntry(entry))
        try #require(GatewaySettingsStore.saveGatewayCredentials(
            token: "restart-pairing-token",
            bootstrapToken: nil,
            password: "restart-pairing-password",
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: true,
            instanceId: nonce))
        try #require(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Existing-Ingress": "preserved"],
            gatewayStableID: stableID))
        let owner = GatewayIngressController(retireTransports: { _ in })
        try #require(owner.hasSession(stableID: stableID))
        await owner.signOut(stableID: stableID)
        try #require(owner.attention?.message.hasPrefix("Cloudflare Access is signed out") == true)
        try #require(!owner.hasSession(stableID: stableID) && persistence.load(origin) == nil)
        try #require(persistence.load(control) != nil)
        try AccessRestartProof.checkPairingAndProfile()
        let receipt = try AccessRestartProof.Receipt(
            nonce: nonce,
            source: AccessRestartProof.environment("SOURCE"),
            processID: ProcessInfo.processInfo.processIdentifier,
            bundleID: #require(Bundle.main.bundleIdentifier),
            container: NSHomeDirectory(),
            executableSHA256: AccessRestartProof.executableDigest(),
            expiresAt: expires)
        let url = try AccessRestartProof.receiptURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try PropertyListEncoder().encode(receipt).write(to: url, options: .atomic)
        // Deliberately retain only this nonce's fixture until the separate process verifies it.
        // No state override or cleanup may turn process restart into object reconstruction.
        print(
            "ACCESS_RESTART seed pid=\(receipt.processID) source=\(receipt.source) sha256=\(receipt.executableSHA256)")
    }
}

@Suite(.serialized)
struct GatewayAccessRestartVerifyTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ACCESS_RESTART_PHASE"] == "verify"))
    @MainActor func `verify acknowledged sign out`() throws {
        let receipt = try PropertyListDecoder().decode(
            AccessRestartProof.Receipt.self, from: Data(contentsOf: AccessRestartProof.receiptURL()))
        defer {
            do { try AccessRestartProof.cleanup() } catch { Issue.record(error) }
        }
        let nonce = try AccessRestartProof.nonce()
        let source = try AccessRestartProof.environment("SOURCE")
        let executableDigest = try AccessRestartProof.executableDigest()
        try #require(receipt.nonce == nonce)
        try #require(receipt.source == source)
        try #require(receipt.processID != ProcessInfo.processInfo.processIdentifier)
        try #require(receipt.bundleID == Bundle.main.bundleIdentifier && receipt.container == NSHomeDirectory())
        try #require(receipt.executableSHA256 == executableDigest)
        let persistence = CloudflareAccessSessionStore.Persistence.keychain
        let origin = try AccessRestartProof.origin()
        try #require(persistence.load(origin) == nil)
        let store = CloudflareAccessSessionStore(retireTransports: { _ in })
        #expect(store.snapshot(for: origin) == nil)
        let control = try #require(store.snapshot(for: AccessRestartProof.origin(control: true)))
        #expect(control.session.subject == "untouched-control" && control.session.expiresAt == receipt.expiresAt)
        try AccessRestartProof.checkPairingAndProfile()
        print(
            "ACCESS_RESTART verify pid=\(ProcessInfo.processInfo.processIdentifier) " +
                "prior=\(receipt.processID) source=\(receipt.source)")
    }
}
