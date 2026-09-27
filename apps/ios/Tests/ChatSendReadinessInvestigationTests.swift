import Foundation
import Observation
import XCTest
@testable import OpenClaw
@testable import OpenClawChatUI
@testable import OpenClawKit

private actor ChatSendReadinessGateway {
    private struct SentMessage {
        let id: String
        let text: String
        let runID: String
    }

    private var holdNextHealth = false
    private var healthReleased = false
    private var heldHealth: (GatewayTestWebSocketTask, String)?
    private var healthEntered: CheckedContinuation<Void, Never>?
    private var messages: [SentMessage] = []

    func armHealth() {
        self.holdNextHealth = true
    }

    func waitForHeldHealth() async {
        if self.heldHealth != nil { return }
        await withCheckedContinuation { self.healthEntered = $0 }
    }

    func releaseHealth() throws {
        self.healthReleased = true
        guard let (socket, id) = self.heldHealth else { return }
        self.heldHealth = nil
        try self.respond(socket: socket, id: id, payload: ["ok": true])
    }

    func sentTexts() -> [String] {
        self.messages.map(\.text)
    }

    func receive(socket: GatewayTestWebSocketTask, message: URLSessionWebSocketTask.Message) throws {
        let data: Data = switch message {
        case let .data(value): value
        case let .string(value): Data(value.utf8)
        @unknown default: throw URLError(.cannotParseResponse)
        }
        let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let method = try XCTUnwrap(frame["method"] as? String)
        if method == "connect" { return }
        let id = try XCTUnwrap(frame["id"] as? String)
        let params = frame["params"] as? [String: Any] ?? [:]
        let payload: [String: Any]
        switch method {
        case "health":
            if self.holdNextHealth {
                self.holdNextHealth = false
                self.heldHealth = (socket, id)
                self.healthEntered?.resume()
                self.healthEntered = nil
                return
            }
            payload = ["ok": self.healthReleased]
        case "chat.history":
            payload = [
                "sessionKey": params["sessionKey"] as? String ?? "main",
                "sessionId": "readiness-session",
                "messages": self.messages.map { message in
                    [
                        "id": message.id,
                        "role": "user",
                        "content": [["type": "text", "text": message.text]],
                        "idempotencyKey": message.runID + ":user",
                        "timestamp": 1,
                    ] as [String: Any]
                },
            ]
        case "chat.send":
            let text = try XCTUnwrap(params["message"] as? String)
            let runID = try XCTUnwrap(params["idempotencyKey"] as? String)
            self.messages.append(SentMessage(id: UUID().uuidString, text: text, runID: runID))
            payload = ["runId": runID, "status": "ok"]
        case "sessions.list":
            payload = ["sessions": []]
        case "models.list":
            payload = ["models": []]
        case "question.list":
            payload = ["questions": []]
        case "tasks.list":
            payload = ["tasks": []]
        default:
            payload = [:]
        }
        try self.respond(socket: socket, id: id, payload: payload)
    }

    private func respond(socket: GatewayTestWebSocketTask, id: String, payload: [String: Any]) throws {
        let frame: [String: Any] = ["type": "res", "id": id, "ok": true, "payload": payload]
        try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: frame)))
    }
}

@MainActor
private final class ChatSendReadinessObservation {
    private let condition: @MainActor () -> Bool
    private var continuation: CheckedContinuation<Void, Never>?

    private init(condition: @escaping @MainActor () -> Bool) {
        self.condition = condition
    }

    static func wait(until condition: @escaping @MainActor () -> Bool) async {
        let observation = ChatSendReadinessObservation(condition: condition)
        await withCheckedContinuation { continuation in
            observation.continuation = continuation
            observation.observe()
        }
        withExtendedLifetime(observation) {}
    }

    private func observe() {
        guard self.continuation != nil else { return }
        if self.condition() {
            let continuation = self.continuation
            self.continuation = nil
            continuation?.resume()
            return
        }
        withObservationTracking {
            _ = self.condition()
        } onChange: { [weak self] in
            Task { @MainActor in self?.observe() }
        }
    }
}

/// Temporary controlled reproduction; the real owner and iOS transport handle the send.
@MainActor
final class ChatSendReadinessInvestigationTests: XCTestCase {
    func testDelayedHealthWithoutHydrationDelivers() async throws {
        try await self.checkSend(hydratesAgent: false)
    }

    func testDelayedHealthAcrossInitialAgentHydrationDelivers() async throws {
        try await self.checkSend(hydratesAgent: true)
    }

    private func checkSend(hydratesAgent: Bool) async throws {
        let appModel = NodeAppModel()
        let gateway = ChatSendReadinessGateway()
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            try await gateway.receive(socket: socket, message: message)
        })
        let session = GatewayTestWebSocketSession(taskFactory: { socket })
        let stableID = "send-readiness-\(UUID().uuidString)"
        let url = try XCTUnwrap(URL(string: "ws://send-readiness.invalid"))
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        options.deviceAuthGatewayID = stableID
        appModel.activeGatewayConnectConfig = GatewayConnectConfig(
            url: url,
            stableID: stableID,
            tls: nil,
            token: "synthetic-readiness-account",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options)
        let owner = appModel.chatPresentation
        do {
            try await appModel.operatorSession.connect(
                url: url,
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            owner.sync(appModel: appModel)
            let original = try XCTUnwrap(owner.viewModel)
            defer { original.detachTransport() }
            await ChatSendReadinessObservation.wait {
                !original.isLoading && original.hasRestoredOutboxMessages
            }
            XCTAssertNil(appModel.chatDeliveryAgentId)
            XCTAssertFalse(original.healthOK, "The real bootstrap must record the fixture's stale health.")
            let text = "Deliver this accepted send while the default agent resolves"
            let resolveComposer = owner.composerModelResolver()
            let composer = try XCTUnwrap(resolveComposer())
            composer.input = text
            XCTAssertTrue(composer.canSend)
            await gateway.armHealth()
            composer.send()
            await gateway.waitForHeldHealth()
            XCTAssertTrue(original.isSending)
            XCTAssertTrue(original.isSubmittingDraft)
            XCTAssertTrue(original.messages.isEmpty)
            let before = await gateway.sentTexts()
            XCTAssertTrue(before.isEmpty)

            let ownerID = appModel.chatViewModelOwnerID
            let sessionKey = appModel.chatSessionKey
            if hydratesAgent {
                appModel.gatewayDefaultAgentId = "main"
                owner.sync(appModel: appModel)
                XCTAssertEqual(appModel.chatViewModelOwnerID, ownerID)
                XCTAssertEqual(appModel.chatSessionKey, sessionKey)
                XCTAssertEqual(owner.viewModel?.input, text)
            }
            try await gateway.releaseHealth()
            // Observe the old send's actual defer, rather than declaring loss after a timeout.
            await ChatSendReadinessObservation.wait {
                !original.isSending && !original.isSubmittingDraft
            }
            let current = try XCTUnwrap(owner.viewModel)
            await ChatSendReadinessObservation.wait { !current.isLoading }
            let sent = await gateway.sentTexts()
            let userRows = current.messages.filter { message in
                message.role == "user" && message.content.contains { $0.text == text }
            }
            print(
                "IOS_SEND_READINESS_PROBE hydration=\(hydratesAgent) oldSendCompleted=true " +
                    "modelReplaced=\(original !== current) requests=\(sent.count) " +
                    "userRows=\(userRows.count) draftRetained=\(current.input == text)")
            XCTAssertEqual(sent, [text], "An accepted Send must not disappear during same-conversation hydration.")
            XCTAssertEqual(userRows.count, 1)
            XCTAssertEqual(current.input, "")
            owner.viewModel?.detachTransport()
            await appModel.operatorSession.disconnect()
        } catch {
            try? await gateway.releaseHealth()
            owner.viewModel?.detachTransport()
            await appModel.operatorSession.disconnect()
            throw error
        }
    }
}
