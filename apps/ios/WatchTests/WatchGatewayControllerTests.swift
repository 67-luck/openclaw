import Foundation
import OpenClawProtocol
import SQLite3
import Testing
@testable import OpenClawKit
@testable import OpenClawWatchApp

@MainActor
@Suite(.serialized)
struct WatchGatewayControllerTests {
    @Test func `ordinary RPC failure after hello joins the operator connection cleanup`() async throws {
        try await Self.withUnconfiguredWatch { controller, _ in
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#,
                sentAtMs: Int64(Date().timeIntervalSince1970 * 1000))
            let configuration = try #require(controller.configuration)
            let fixture = try GatewayOperatorHTTPFixture(gatewayID: configuration.gatewayID)
            do {
                let response = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                    #"{"sessionToken":"node-session","deviceToken":"node-fixture"}"#.utf8))
                try await controller.acceptNodeHandshake(
                    response, configuration: configuration, identity: fixture.identity, usedBootstrap: false)
                controller.setEnabled(false)
                controller.connectForForeground()
                controller.setEnabled(true)
                // Retire the subordinate node before its queued startup; this test owns only operator HTTP.
                controller.node.disconnectForBackground()
                let conversations = WatchDirectConversations(gateway: controller) { _, _ in fixture.session }
                conversations.appear()
                let refresh = Task { await conversations.refresh() }
                let repeatedRefresh = Task { await conversations.refresh() }
                let begin = try await fixture.next()
                #expect(begin.request.url?.lastPathComponent == "connections")
                try begin.respond(status: 201, body: GatewayOperatorHTTPFixture.beginBody())
                let connect = try await fixture.next()
                #expect(try connect.frame.method == "connect")
                connect.accept(1)
                let hello = try await fixture.next()
                try hello.respond(body: GatewayOperatorHTTPFixture.hello(requestID: connect.frame.id))
                var request = try await fixture.next()
                if request.request.url?.lastPathComponent == "poll" {
                    request = try await fixture.next()
                }
                #expect(try request.frame.method == "agents.list")
                request.accept(2)
                let poll = try await fixture.next()
                try poll.respond(body: JSONSerialization.data(withJSONObject: [
                    "acceptedClientSeq": 2,
                    "frames": [[
                        "cursor": 2,
                        "frame": [
                            "type": "res", "id": request.frame.id, "ok": false,
                            "error": ["code": "UNAVAILABLE", "message": "Agents unavailable"],
                        ],
                    ]],
                ]))
                await refresh.value
                await repeatedRefresh.value
                #expect(!conversations.connected)
                #expect(conversations.status == "Agents unavailable")
                #expect(!controller.recoveryRequired)
                #expect(fixture.snapshot.filter { $0.request.httpMethod == "DELETE" }.count == 1)
                #expect(fixture.snapshot.filter { $0.request.url?.lastPathComponent == "connections" }.count == 1)
            } catch {
                await fixture.stop()
                throw error
            }
            await fixture.stop()
        }
    }

    @Test(arguments: ["disabled", "background", "hidden"])
    func `disabled background and hidden refresh never create an operator transport`(_ state: String) async throws {
        try await Self.withUnconfiguredWatch { controller, _ in
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#,
                sentAtMs: Int64(Date().timeIntervalSince1970 * 1000))
            let configuration = try #require(controller.configuration)
            let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .primary))
            let response = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                #"""
                {"sessionToken":"node-session","deviceToken":"node-fixture","deviceTokens":[
                  {"role":"operator","deviceToken":"operator-fixture","scopes":["operator.read","operator.talk"]}
                ]}
                """#.utf8))
            try await controller.acceptNodeHandshake(
                response, configuration: configuration, identity: identity, usedBootstrap: true)
            if state != "background" {
                controller.setEnabled(false)
                controller.connectForForeground()
                if state == "hidden" {
                    controller.setEnabled(true)
                    controller.node.disconnectForBackground()
                }
            }
            #expect(controller.isForeground == (state != "background"))
            #expect(controller.isEnabled == (state != "disabled"))
            #expect(!controller.setupIncomplete)
            var attempts = 0
            let conversations = WatchDirectConversations(gateway: controller) { _, _ in
                attempts += 1
                throw GatewayOperatorHTTPError.invalidContract
            }
            if state != "hidden" { conversations.appear() }
            let status = conversations.status
            await conversations.refresh()
            #expect(attempts == 0)
            #expect(conversations.status == status)
            #expect(!conversations.connected)
            #expect(!controller.recoveryRequired)
        }
    }

    @Test(arguments: ["agent", "session"])
    func `selection suspended at unsubscribe cannot restore IDs after setup replacement`(_ kind: String) async throws {
        try await Self.withConnectedConversations { controller, conversations, fixture in
            let first = try #require(conversations.sessions.first)
            let initialSelection = Task { await conversations.selectSession(first) }
            try await Self.reply(
                fixture, method: "sessions.messages.subscribe", sequence: 4, cursor: 4,
                payload: AnyCodable(["subscribed": true, "key": first.key]))
            try await Self.reply(
                fixture, method: "chat.history", sequence: 5, cursor: 5,
                payload: AnyCodable(["messages": [String]()]))
            await initialSelection.value
            #expect(conversations.route?.sessionKey == first.key)
            let second = try #require(conversations.sessions.last)
            let selection = Task {
                if kind == "agent" {
                    await conversations.selectAgent("second-agent")
                } else {
                    await conversations.selectSession(second)
                }
            }
            let unsubscribe = try await Self.nextFrame(fixture, method: "sessions.messages.unsubscribe")
            unsubscribe.accept(6)
            let poll = try await fixture.next()
            #expect(poll.request.url?.lastPathComponent == "poll")
            try await Self.replaceSetup(controller)
            await selection.value
            #expect(conversations.route == nil)
            #expect(conversations.selectedAgentID == nil)
            #expect(conversations.sessions.isEmpty)
            #expect(!controller.recoveryRequired)
            #expect(fixture.snapshot.filter { $0.request.httpMethod == "DELETE" }.count == 1)
        }
    }

    @Test(arguments: ["create", "upgrade", "refresh", "send"])
    func `retired operations cannot overwrite replacement setup presentation or require recovery`(_ kind: String)
        async throws
    {
        let scopes = kind == "upgrade" ? GatewayOperatorHTTPFixture.scopes
            : ["operator.read", "operator.talk", "operator.write", "operator.approvals"]
        try await Self.withConnectedConversations(scopes: scopes) { controller, conversations, fixture in
            var sequence = 4
            if kind == "send" {
                let session = try #require(conversations.sessions.first)
                let selecting = Task { await conversations.selectSession(session) }
                try await Self.reply(
                    fixture, method: "sessions.messages.subscribe", sequence: sequence, cursor: sequence,
                    payload: AnyCodable(["subscribed": true, "key": session.key]))
                sequence += 1
                try await Self.reply(
                    fixture, method: "chat.history", sequence: sequence, cursor: sequence,
                    payload: AnyCodable(["messages": [String]()]))
                sequence += 1
                await selecting.value
            }
            let route = conversations.route
            let operation = Task {
                switch kind {
                case "create": await conversations.createSession()
                case "upgrade": await conversations.requestUpgrade()
                case "send":
                    if let route { await conversations.send("one message", route: route) }
                default: await conversations.refresh()
                }
            }
            if kind == "upgrade" {
                try await Self.reply(
                    fixture, method: "device.scopes.requestUpgrade", sequence: sequence, cursor: sequence,
                    payload: AnyCodable(["requestId": "upgrade-one"]))
                sequence += 1
            }
            let method = switch kind {
            case "create": "sessions.create"
            case "upgrade": "device.scopes.waitUpgrade"
            case "send": "chat.send"
            default: "sessions.list"
            }
            let held = try await Self.nextFrame(fixture, method: method)
            held.accept(sequence)
            let poll = try await fixture.next()
            #expect(poll.request.url?.lastPathComponent == "poll")
            if kind == "send" {
                controller.disconnectForBackground()
                #expect(conversations.deliveryStatus?.contains("uncertain") == true)
            }
            try await Self.replaceSetup(controller)
            let status = conversations.status
            await operation.value
            #expect(conversations.status == status)
            #expect(conversations.deliveryStatus == nil)
            #expect(conversations.route == nil)
            #expect(!conversations.busy)
            #expect(!conversations.upgrading)
            #expect(!controller.recoveryRequired)
            #expect(fixture.snapshot.filter { $0.request.url?.lastPathComponent == "connections" }.count == 1)
        }
    }

    @Test(arguments: ["configure", "forget"])
    func `setup teardown blocks refresh and cannot end a newer voice presentation`(_ kind: String) async throws {
        try await Self.withConnectedConversations { controller, _, fixture in
            let stamp = try #require(controller.configuration?.setupSentAtMs)
            let consumer = GatewayOperatorHTTPGate()
            defer { consumer.release() }
            let read = Task {
                try await fixture.session.request(method: "chat.history") { _, _ in await consumer.wait() }
            }
            try await Self.reply(
                fixture, method: "chat.history", sequence: 4, cursor: 4,
                payload: AnyCodable(["messages": [String]()]))
            try await consumer.waitUntilEntered()
            let obsolete = Task {
                if kind == "configure" {
                    await controller.configure(
                        setupCode: #"{"url":"wss://gateway.example.invalid/older","bootstrapToken":"older-setup"}"#,
                        sentAtMs: stamp + 1)
                } else {
                    await controller.forget()
                }
            }
            let deletion = try await fixture.next()
            try #require(deletion.request.httpMethod == "DELETE")
            let installed = try #require(controller.configuration)
            #expect(controller.isEnabled && controller.isForeground)
            #expect(!controller.setupIncomplete && !controller.recoveryRequired)
            #expect(!controller.isInstalled(installed))
            var attempts = 0
            let refresh = WatchDirectConversations(gateway: controller) { _, _ in
                attempts += 1
                throw GatewayOperatorHTTPError.invalidContract
            }
            refresh.appear()
            await refresh.refresh()
            #expect(attempts == 0)
            refresh.disappear()
            // The first teardown is joining an awaited old consumer. The newer setup has no such session.
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/newer","bootstrapToken":"newer-setup"}"#,
                sentAtMs: stamp + 2)
            controller.node.disconnectForBackground()
            let voice = try #require(controller.configuration?.voiceConnection)
            // A rejected new start changes the real voice owner's presentation without opening audio or sockets.
            controller.voiceCall.start(connection: voice, isCurrent: { false })
            #expect(controller.voiceCall.state == .failed)
            consumer.release()
            await obsolete.value
            await #expect(throws: GatewayOperatorHTTPError.self) { try await read.value }
            #expect(controller.configuration?.setupSentAtMs == stamp + 2)
            #expect(controller.voiceCall.state == .failed)
        }
    }

    @Test(arguments: ["rejected", "uncertain", "created"])
    func `creating the first conversation records an outcome without an existing route`(_ outcome: String)
        async throws
    {
        try await Self.withConnectedConversations(
            scopes: ["operator.read", "operator.talk", "operator.write", "operator.approvals"])
        { _, conversations, fixture in
            #expect(conversations.route == nil)
            let create = Task { await conversations.createSession() }
            let request = try await Self.nextFrame(fixture, method: "sessions.create")
            #expect(conversations.deliveryStatus == "Creating conversation...")
            request.accept(4)
            let poll = try await fixture.next()
            if outcome == "uncertain" {
                try poll.respond(status: 409, body: JSONSerialization.data(withJSONObject: [
                    "error": ["code": "ingress_changed", "message": "Ingress changed", "resyncRequired": true],
                ]))
            } else if outcome == "rejected" {
                try poll.respond(body: JSONSerialization.data(withJSONObject: [
                    "acceptedClientSeq": 4,
                    "frames": [[
                        "cursor": 4,
                        "frame": [
                            "type": "res", "id": request.frame.id, "ok": false,
                            "error": ["code": "UNAVAILABLE", "message": "Conversation could not be created"],
                        ],
                    ]],
                ]))
            } else {
                try poll.respond(body: GatewayOperatorHTTPFixture.delivery(
                    requestID: request.frame.id,
                    payload: AnyCodable(["ok": true, "key": "new-session"]),
                    cursor: 4, accepted: 4))
                // A concurrent list update can omit the new session; success must still be visible.
                try await Self.reply(
                    fixture, method: "sessions.list", sequence: 5, cursor: 5,
                    payload: AnyCodable(["sessions": [String]()]))
            }
            await create.value
            #expect(!conversations.busy)
            #expect(conversations.route == nil)
            let status = try #require(conversations.deliveryStatus)
            if outcome == "rejected" {
                #expect(status == "Conversation could not be created")
            } else if outcome == "created" {
                #expect(status == "Conversation created")
            } else {
                #expect(status.contains("unknown") || status.contains("uncertain"))
                #expect(!conversations.connected)
            }
            let creates = try fixture.snapshot.filter {
                $0.request.url?.lastPathComponent == "frames" && $0.frame.method == "sessions.create"
            }
            #expect(creates.count == 1)
        }
    }

    @Test func `operator write failure preserves redeemed node and leaves fallback setup incomplete`() async throws {
        try await Self.withUnconfiguredWatch { controller, stateDirectory in
            let sentAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#,
                sentAtMs: sentAtMs)
            let configuration = try #require(controller.configuration)
            let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .primary))
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId, role: "node", token: "previous-node",
                gatewayID: configuration.gatewayID, profile: .primary))

            let databaseURL = stateDirectory.appendingPathComponent("state/openclaw.sqlite")
            // Fail only the second durable handoff, using the real store's write boundary.
            try Self.execute(databaseURL, """
            CREATE TRIGGER reject_operator_grant BEFORE INSERT ON device_auth_tokens
            WHEN NEW.token = 'rejected-operator'
            BEGIN SELECT RAISE(ABORT, 'simulated operator write failure'); END;
            """)
            let response = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                #"""
                {"sessionToken":"node-session","deviceToken":"redeemed-node","deviceTokens":[
                  {"role":"operator","deviceToken":"rejected-operator",
                   "scopes":["operator.read","operator.talk"]}
                ]}
                """#.utf8))
            do {
                try await controller.acceptNodeHandshake(
                    response, configuration: configuration, identity: identity, usedBootstrap: true)
                Issue.record("Failed operator write completed setup")
            } catch GatewayOperatorHTTPError.pairingRequired {}

            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "node",
                gatewayID: configuration.gatewayID, profile: .primary)?.token == "redeemed-node")
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "operator",
                gatewayID: configuration.gatewayID, profile: .primary) == nil)
            #expect(controller.configuration?.link.bootstrapToken == "one-time-setup")
            #expect(controller.recoveryRequired)
            #expect(controller.voiceConnection == nil)

            // This is the response after the consumed bootstrap gets 401 and the node token reconnects.
            let fallback = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                #"{"sessionToken":"fallback-session","deviceToken":"redeemed-node"}"#.utf8))
            try await controller.acceptNodeHandshake(
                fallback, configuration: configuration, identity: identity, usedBootstrap: false)
            #expect(controller.configuration?.link.bootstrapToken == nil)
            #expect(controller.setupIncomplete)
            #expect(controller.recoveryRequired)
            #expect(controller.voiceConnection == nil)
        }
    }

    @Test func `fresh setup clears operator authority and rejects older handoffs without touching phone tokens`()
        async throws
    {
        try await Self.withUnconfiguredWatch { controller, _ in
            let code = #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#
            let sentAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            await controller.configure(setupCode: code, sentAtMs: sentAtMs)
            let original = try #require(controller.configuration)
            let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .primary))
            for gatewayID in [original.gatewayID, "phone-snapshot-gateway"] {
                #expect(DeviceAuthStore.storeTokenPersisted(
                    deviceId: identity.deviceId, role: "operator", token: "existing-operator",
                    scopes: ["operator.read", "operator.talk", "operator.write", "operator.approvals"],
                    gatewayID: gatewayID, profile: .primary))
            }
            await controller.configure(setupCode: code, sentAtMs: sentAtMs + 1)
            #expect(controller.configuration?.setupSentAtMs == sentAtMs + 1)
            #expect(controller.storedOperatorScopes().isEmpty)
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "operator",
                gatewayID: "phone-snapshot-gateway", profile: .primary)?.token == "existing-operator")
            await controller.configure(setupCode: code, sentAtMs: sentAtMs)
            #expect(controller.configuration?.setupSentAtMs == sentAtMs + 1)

            let obsolete = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                #"{"sessionToken":"old-session","deviceToken":"obsolete-node"}"#.utf8))
            do {
                try await controller.acceptNodeHandshake(
                    obsolete, configuration: original, identity: identity, usedBootstrap: true)
                Issue.record("An obsolete handoff changed the replacement setup")
            } catch is CancellationError {}
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "node",
                gatewayID: original.gatewayID, profile: .primary) == nil)
        }
    }

    private static func withUnconfiguredWatch(
        operation: @MainActor (WatchGatewayController, URL) async throws -> Void) async throws
    {
        let service = "ai.openclaw.watch.direct-node"
        let account = "gateway"
        // Run on a clean test Watch. Never replace an installed user's Keychain setup.
        try #require(GenericPasswordKeychainStore.loadString(service: service, account: account) == nil)
        let defaults = UserDefaults.standard
        let keys = ["watch.directNode.enabled", "watch.directNode.lastSetupSentAtMs"]
        let savedDefaults = keys.map { defaults.object(forKey: $0) }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("watch-gateway-\(UUID().uuidString)", isDirectory: true)
        defer {
            _ = GenericPasswordKeychainStore.delete(service: service, account: account)
            for (key, value) in zip(keys, savedDefaults) {
                if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
            }
            try? FileManager.default.removeItem(at: directory)
        }
        for key in keys {
            defaults.removeObject(forKey: key)
        }
        try await DeviceIdentityStore.withStateDirectory(directory) {
            let controller = WatchGatewayController()
            do {
                try await operation(controller, directory)
            } catch {
                await controller.forget()
                throw error
            }
            await controller.forget()
        }
    }

    private static func withConnectedConversations(
        scopes: [String] = GatewayOperatorHTTPFixture.scopes,
        operation: @MainActor (WatchGatewayController, WatchDirectConversations, GatewayOperatorHTTPFixture)
        async throws -> Void) async throws
    {
        try await self.withUnconfiguredWatch { controller, _ in
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#,
                sentAtMs: Int64(Date().timeIntervalSince1970 * 1000))
            let configuration = try #require(controller.configuration)
            let fixture = try GatewayOperatorHTTPFixture(gatewayID: configuration.gatewayID, scopes: scopes)
            do {
                let response = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                    #"{"sessionToken":"node-session","deviceToken":"node-fixture"}"#.utf8))
                try await controller.acceptNodeHandshake(
                    response, configuration: configuration, identity: fixture.identity, usedBootstrap: false)
                let conversations = WatchDirectConversations(gateway: controller) { _, _ in fixture.session }
                controller.conversations = conversations
                controller.setEnabled(false)
                controller.connectForForeground()
                controller.setEnabled(true)
                controller.node.disconnectForBackground()
                conversations.appear()
                let connecting = Task { await conversations.refresh() }
                let begin = try await fixture.next()
                #expect(begin.request.url?.lastPathComponent == "connections")
                try begin.respond(status: 201, body: GatewayOperatorHTTPFixture.beginBody())
                let connect = try await Self.nextFrame(fixture, method: "connect")
                connect.accept(1)
                let poll = try await fixture.next()
                try poll.respond(body: GatewayOperatorHTTPFixture.hello(requestID: connect.frame.id, scopes: scopes))
                try await Self.reply(
                    fixture, method: "agents.list", sequence: 2, cursor: 2, payload: AnyCodable([
                        "defaultId": "first-agent", "mainKey": "main", "scope": "per-sender",
                        "agents": [["id": "first-agent"], ["id": "second-agent"]],
                    ]))
                try await Self.reply(
                    fixture, method: "sessions.list", sequence: 3, cursor: 3,
                    payload: AnyCodable(["sessions": [["key": "session-one"], ["key": "session-two"]]]))
                await connecting.value
                #expect(conversations.connected)
                try await operation(controller, conversations, fixture)
                await conversations.disconnect(clear: true)
            } catch {
                await fixture.stop()
                throw error
            }
            await fixture.stop()
        }
    }

    private static func nextFrame(_ fixture: GatewayOperatorHTTPFixture, method: String)
        async throws -> GatewayOperatorHTTPExchange
    {
        var exchange = try await fixture.next()
        while exchange.request.url?.lastPathComponent == "poll" {
            exchange = try await fixture.next()
        }
        try #require(exchange.request.url?.lastPathComponent == "frames")
        try #require(exchange.frame.method == method)
        return exchange
    }

    private static func reply(
        _ fixture: GatewayOperatorHTTPFixture, method: String, sequence: Int, cursor: Int, payload: AnyCodable)
        async throws
    {
        let frame = try await Self.nextFrame(fixture, method: method)
        frame.accept(sequence)
        let poll = try await fixture.next()
        try #require(poll.request.url?.lastPathComponent == "poll")
        try poll.respond(body: GatewayOperatorHTTPFixture.delivery(
            requestID: frame.frame.id, payload: payload, cursor: cursor, accepted: sequence))
    }

    private static func replaceSetup(_ controller: WatchGatewayController) async throws {
        let previous = try #require(controller.configuration?.setupSentAtMs)
        // Stop transport startup while the replacement is installed; the original HTTP RPC is still pending.
        controller.disconnectForBackground()
        await controller.configure(
            setupCode: #"{"url":"wss://gateway.example.invalid/replacement","bootstrapToken":"replacement-setup"}"#,
            sentAtMs: previous + 1)
        #expect(controller.configuration?.setupSentAtMs == previous + 1)
    }

    private static func execute(_ url: URL, _ sql: String) throws {
        var database: OpaquePointer?
        let status = sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READWRITE, nil)
        defer { if let database { sqlite3_close(database) } }
        try #require(status == SQLITE_OK)
        let opened = try #require(database)
        try #require(sqlite3_exec(opened, sql, nil, nil, nil) == SQLITE_OK)
    }
}
