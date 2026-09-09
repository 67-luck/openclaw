import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawWatchApp

struct WatchDirectConversationTests {
    @Test func `direct send ownership distinguishes Unicode and companion namespaces`() {
        let direct = WatchDirectRoute(
            gatewayID: "watch-direct:https://gateway.example.invalid/team",
            setupSentAtMs: 1, agentID: "agent-e\u{301}", sessionKey: "chat-e\u{301}")
        #expect(direct != WatchDirectRoute(
            gatewayID: direct.gatewayID, setupSentAtMs: 1,
            agentID: "agent-\u{E9}", sessionKey: direct.sessionKey))
        #expect(direct != WatchDirectRoute(
            gatewayID: direct.gatewayID, setupSentAtMs: 1,
            agentID: direct.agentID, sessionKey: "chat-\u{E9}"))
        #expect(direct != WatchDirectRoute(
            gatewayID: "phone-gateway", setupSentAtMs: 1,
            agentID: direct.agentID, sessionKey: direct.sessionKey))
        #expect(direct != WatchDirectRoute(
            gatewayID: direct.gatewayID, setupSentAtMs: 2,
            agentID: direct.agentID, sessionKey: direct.sessionKey))
    }

    @Test func `approval controls use canonical decisions and freeze for readback`() throws {
        let pending = try Self.pending(expiresAtMs: Int(Date().timeIntervalSince1970 * 1000) + 60000)
        var record = WatchDirectApproval(snapshot: .pending(pending))
        #expect(record.kind == .exec)
        #expect(record.decisions == [.deny])
        #expect(record.rawID.utf8.elementsEqual("approval-e\u{301}".utf8))
        #expect(record.detail.contains("do not hide the warning"))
        record.needsReadback = true
        #expect(record.decisions.isEmpty)
        record.needsReadback = false
        record.resolving = true
        #expect(record.decisions.isEmpty)
        let expired = try WatchDirectApproval(snapshot: .pending(Self.pending(expiresAtMs: 1)))
        #expect(expired.decisions.isEmpty)
    }

    @Test func `already committed approval response remains terminal when applied is false`() throws {
        let pending = try Self.pending(expiresAtMs: 100)
        let terminal = DeniedApprovalSnapshot(
            id: pending.id, urlpath: pending.urlpath, createdatms: 0, expiresatms: 100,
            presentation: pending.presentation, resolvedatms: 10,
            status: "denied", decision: "deny", reason: .user)
        let response = ApprovalResolveResult(applied: false, approval: .denied(terminal))
        let decoded = try JSONDecoder().decode(
            ApprovalResolveResult.self, from: JSONEncoder().encode(response))
        #expect(!decoded.applied)
        let snapshot = try JSONDecoder().decode(
            ApprovalSnapshot.self, from: JSONEncoder().encode(decoded.approval))
        let record = WatchDirectApproval(snapshot: snapshot)
        #expect(record.decisions.isEmpty)
        #expect(record.id == WatchOpaqueUTF8Key(pending.id))
    }

    private static func pending(expiresAtMs: Int) throws -> PendingApprovalSnapshot {
        PendingApprovalSnapshot(
            id: "approval-e\u{301}", urlpath: "/approval/example", createdatms: 0,
            expiresatms: expiresAtMs,
            presentation: .exec(ExecApprovalPresentation(
                kind: "exec", commandtext: "echo example",
                warningtext: AnyCodable("do not hide the warning"), alloweddecisions: [.deny])),
            status: "pending")
    }
}
