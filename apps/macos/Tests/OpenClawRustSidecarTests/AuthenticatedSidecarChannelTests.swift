import CryptoKit
import Foundation
import Testing
@testable import OpenClawRustSidecar

struct AuthenticatedSidecarChannelTests {
    @Test func `owned UTF8 segments authenticate exact bytes and respect byte limits`() throws {
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        var text = #"{"text":"🦞 café / \""}"#
        let expected = Data("[\"native-result\",{},".utf8) + Data(text.utf8) + Data([0x5D])
        let payload = SidecarPayload(
            body: .utf8(text), prefix: Data("[\"native-result\",{},".utf8), suffix: Data([0x5D]))
        text.removeAll()
        #expect(payload.count == expected.count)
        #expect(payload.bytes == expected)
        let channel = try Self.channel(session)
        let reference = try Self.channel(session)
        #expect(try channel.seal(payload).bytes == reference.seal(SidecarPayload(expected)).bytes)
        try channel.lowerFrameLimit(128)
        let tooLarge = SidecarPayload(body: .utf8(String(repeating: "🦞", count: channel.maxPayloadBytes / 4 + 1)))
        #expect(tooLarge.count > channel.maxPayloadBytes)
        #expect(throws: AuthenticatedSidecarChannel.Failure.frameTooLarge) { try channel.seal(tooLarge) }
    }

    @Test(arguments: ["", "AP+A", #"\u002f\u002f8="#])
    func `authenticated transport tuples decode exact binary data`(encoded: String) throws {
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        let payload = Data("[\"transport-send\",18446744073709551615,\"binary\",\"\(encoded)\"]".utf8)
        let channel = try Self.channel(session)
        let message = try channel.open(Self.runtimeFrame(payload, fixture: fixture), decode: SidecarRuntimeMessage.init)
        guard case let .transport(write) = message else {
            Issue.record("Expected decoded transport tuple")
            return
        }
        #expect(write.id == UInt64.max)
        #expect(write.kind == "binary")
        #expect(write.data == (encoded.isEmpty ? Data() : encoded == "AP+A" ? Data([0, 255, 128]) : Data([255, 255])))
        #expect(!channel.isRetired)
    }

    @Test(arguments: [
        #"["other",1,"binary",""]"#,
        #"["transport-send",1,"binary"]"#,
        #"["transport-send",1,"binary","",0]"#,
        #"["transport-send",1,"binary","",{"ignored":"\q"}]"#,
        #"["transport-send",true,"binary",""]"#,
        #"["transport-send","1","binary",""]"#,
        #"["transport-send",-1,"binary",""]"#,
        #"["transport-send",18446744073709551616,"binary",""]"#,
        #"["transport-send",01,"binary",""]"#,
        #"["transport-send",1e,"binary",""]"#,
        #"["transport-send",1e309,"binary",""]"#,
        #"["transport-send",1.5,"binary",""]"#,
        #"["\q",1,"binary",""]"#,
        #"["\uD800",1,"binary",""]"#,
        #"["transport-send",1,{},""]"#,
        #"["transport-send",1,"\q",""]"#,
        #"["transport-send",1,"\uD800",""]"#,
        #"["transport-send",1,"binary",null]"#,
        #"["transport-send",1,"binary",[]]"#,
        #"["transport-send",1,"binary","%%%"]"#,
        #"["transport-send",1,"binary","\q"]"#,
        #"["transport-send",1,"binary","\uZZZZ"]"#,
        #"["transport-send",1,"binary","\uD800"]"#,
        #"["transport-send",1,"binary",""]{}"#,
        #"{"type":"transport-send","id":1,"kind":"binary","data":""}"#,
        #"{"type":"pong","ignored":"\q"}"#,
    ])
    func `malformed authenticated transport tuples retire before delivery`(input: String) throws {
        try Self.rejectRuntimePayload(Data(input.utf8))
    }

    @Test func `invalid UTF8 in every transport string retires before delivery`() throws {
        for payload in [
            Data("[\"".utf8) + Data([255]) + Data("\",1,\"binary\",\"\"]".utf8),
            Data("[\"transport-send\",1,\"".utf8) + Data([255]) + Data("\",\"\"]".utf8),
            Data("[\"transport-send\",1,\"binary\",\"".utf8) + Data([255]) + Data("\"]".utf8),
        ] {
            try Self.rejectRuntimePayload(payload)
        }
        let tuple = #"["transport-send",1,"binary",""]"#
        for encoding in [
            String.Encoding.utf16,
            .utf16LittleEndian,
            .utf16BigEndian,
            .utf32,
            .utf32LittleEndian,
            .utf32BigEndian,
        ] {
            try Self.rejectRuntimePayload(#require(tuple.data(using: encoding)))
        }
        try Self.rejectRuntimePayload(Data([0xEF, 0xBB, 0xBF]) + Data(tuple.utf8))
    }

    @Test func `control messages enforce the same UTF8 wire contract as tuples`() throws {
        let control = #"{"type":"pong","id":"ping-1","ok":true}"#
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        let valid = try Self.channel(session).open(
            Self.runtimeFrame(Data(control.utf8), fixture: fixture), decode: SidecarRuntimeMessage.init)
        guard case let .control(message) = valid else {
            Issue.record("Expected control message")
            return
        }
        #expect(message["type"] as? String == "pong")
        for encoding in [
            String.Encoding.utf16,
            .utf16LittleEndian,
            .utf16BigEndian,
            .utf32,
            .utf32LittleEndian,
            .utf32BigEndian,
        ] {
            try Self.rejectRuntimePayload(#require(control.data(using: encoding)))
        }
        try Self.rejectRuntimePayload(Data([0xEF, 0xBB, 0xBF]) + Data(control.utf8))
    }

    @Test(arguments: [false, true])
    func `shared wire vectors are byte exact`(segmented: Bool) throws {
        let probe = try Self.fixture("protocol")
        let session = try #require(probe["session"] as? [String: Any])
        let supervisorProbe = try #require(probe["supervisorProbe"] as? [String: Any])
        let payload = try JSONSerialization.data(
            withJSONObject: #require(supervisorProbe["payload"]),
            options: .sortedKeys)
        let channel = try Self.channel(session)
        let expected = try Self.frame(supervisorProbe, "frameBase64")
        let outgoing = segmented ? SidecarPayload(
            payload.dropFirst().dropLast(), prefix: payload.prefix(1), suffix: payload.suffix(1)) :
            SidecarPayload(payload)
        let sealed = try channel.seal(outgoing).bytes
        #expect(sealed.dropFirst(4) == expected)
        #expect(sealed.prefix(4).reduce(0) { ($0 << 8) | Int($1) } == expected.count)

        let handshake = try Self.fixture("handshake")
        let handshakeSession = try #require(handshake["session"] as? [String: Any])
        let handshakeChannel = try Self.channel(handshakeSession)
        let offer = try Self.frame(handshake, "offerFrameBase64")
        let sessionID = try #require(handshakeSession["id"] as? String)
        let offerPayload = Data(offer.dropFirst(31 + sessionID.utf8.count).dropLast(32))
        #expect(try handshakeChannel.seal(SidecarPayload(offerPayload)).bytes.dropFirst(4) == offer)
        let accepted = try handshakeChannel.open(Self.frame(handshake, "acceptFrameBase64"))
        let message = try #require(accepted as? [String: Any])
        #expect(message["type"] as? String == "accept")
        #expect(try JSONSerialization.data(withJSONObject: #require(message["selection"]), options: .sortedKeys) ==
            JSONSerialization.data(withJSONObject: #require(handshake["selection"]), options: .sortedKeys))
    }

    @Test(arguments: ["mac", "magic", "version", "direction", "generation", "sequence", "session", "length", "json"])
    func `invalid inbound frame permanently retires channel`(mutation: String) throws {
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        let channel = try Self.channel(session)
        let valid = try Self.frame(fixture, "acceptFrameBase64")
        var invalid = valid
        let offsets = [
            "magic": 0,
            "version": 5,
            "direction": 8,
            "generation": 16,
            "sequence": 24,
            "session": 31,
            "length": 30,
        ]
        if mutation == "mac" {
            invalid[invalid.count - 1] ^= 1
        } else {
            let sessionID = try #require(session["id"] as? String)
            try invalid[mutation == "json" ? 31 + sessionID.utf8.count : #require(offsets[mutation])] ^= 1
            invalid = try Self.resign(invalid, session: session)
        }
        #expect(throws: (any Error).self) { try channel.open(invalid) }
        #expect(channel.isRetired)
        #expect(throws: AuthenticatedSidecarChannel.Failure.retired) { try channel.open(valid) }
        #expect(throws: AuthenticatedSidecarChannel.Failure.retired) {
            try channel.seal(SidecarPayload(Data("{}".utf8))).bytes
        }
    }

    @Test func `sequences survive negotiation and replay is terminal`() throws {
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        let channel = try Self.channel(session)
        let acceptance = try Self.frame(fixture, "acceptFrameBase64")
        _ = try channel.seal(SidecarPayload(Data("{}".utf8))).bytes
        _ = try channel.open(acceptance)
        try channel.lowerFrameLimit(2048)
        channel.lockFrameLimit()
        #expect(throws: AuthenticatedSidecarChannel.Failure.frameLimitLocked) { try channel.lowerFrameLimit(1024) }
        let next = try channel.seal(SidecarPayload(Data("{}".utf8))).bytes.dropFirst(4)
        #expect(next.dropFirst(17).prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } == 2)
        #expect(throws: AuthenticatedSidecarChannel.Failure.wrongSequence) { try channel.open(acceptance) }
        #expect(channel.isRetired)
    }

    @Test func `limits reject oversized frames without spending outgoing sequence`() throws {
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        let channel = try Self.channel(session)
        try channel.lowerFrameLimit(128)
        #expect(throws: AuthenticatedSidecarChannel.Failure.invalidConfiguration) { try channel.lowerFrameLimit(4096) }
        #expect(throws: AuthenticatedSidecarChannel.Failure.invalidConfiguration) { try channel.lowerFrameLimit(64) }
        #expect(throws: AuthenticatedSidecarChannel.Failure.frameTooLarge) {
            try channel.seal(SidecarPayload(
                Data(repeating: 0x20, count: channel.maxPayloadBytes - 1),
                prefix: Data([0x22]), suffix: Data([0x22, 0x20]))).bytes
        }
        let exact = Data(("\"" + String(repeating: "x", count: channel.maxPayloadBytes - 2) + "\"").utf8)
        let sealed = try channel.seal(SidecarPayload(
            exact.dropFirst().dropLast(), prefix: exact.prefix(1), suffix: exact.suffix(1))).bytes
        #expect(sealed.count == 132)
        #expect(sealed.dropFirst(4 + 17).prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } == 1)
        #expect(throws: AuthenticatedSidecarChannel.Failure.frameTooLarge) {
            try channel.open(Self.frame(fixture, "acceptFrameBase64"))
        }
        #expect(channel.isRetired)
    }

    @Test func `invalid bootstrap identity is rejected`() throws {
        for (keyBytes, sessionID, generation, limit) in [
            (31, "session", UInt64(1), 4096), (32, "", 1, 4096), (32, "session", 0, 4096),
            (32, "session", 1, 64), (32, "session", 1, Int(UInt32.max) + 1),
        ] {
            #expect(throws: AuthenticatedSidecarChannel.Failure.invalidConfiguration) {
                try AuthenticatedSidecarChannel(
                    key: Data(repeating: 0, count: keyBytes), sessionID: sessionID,
                    generation: generation, maxFrameBytes: limit)
            }
        }
    }

    @Test func `native result at Gateway payload limit fits authenticated IPC`() throws {
        // Screen capture permits this outer Gateway frame size. IPC adds an envelope;
        // it must not retire the connection for a result the Gateway accepts.
        let gatewayLimit = 25 * 1024 * 1024
        func result(_ payload: String) -> [String: Any] {
            [
                "type": "req", "id": "result-request", "method": "node.invoke.result",
                "params": ["id": "capture", "nodeId": "mac", "ok": true, "payloadJSON": payload],
            ]
        }
        let emptyBytes = try JSONSerialization.data(withJSONObject: result("\"\"")).count
        let frame = result("\"" + String(repeating: "x", count: gatewayLimit - emptyBytes) + "\"")
        #expect(try JSONSerialization.data(withJSONObject: frame).count == gatewayLimit)
        let payload = try JSONSerialization.data(withJSONObject: [
            "type": "frame", "frame": frame, "callerOwnsLifetime": false,
        ])
        let channel = try AuthenticatedSidecarChannel(
            key: Data(repeating: 0, count: 32), sessionID: String(repeating: "a", count: 32), generation: 1)
        let sealed = try channel.seal(SidecarPayload(payload)).bytes
        #expect(sealed.count <= channel.maxFrameBytes + 4)
        #expect(!channel.isRetired)
        #expect(throws: Never.self) { try channel.seal(SidecarPayload(Data("{}".utf8))).bytes }
    }

    private static func fixture(_ kind: String) throws -> [String: Any] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            root.deleteLastPathComponent()
        }
        let data = try Data(contentsOf: root.appendingPathComponent("test/fixtures/node-sidecar-\(kind)-v1.json"))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func rejectRuntimePayload(_ payload: Data) throws {
        let fixture = try Self.fixture("handshake")
        let session = try #require(fixture["session"] as? [String: Any])
        let channel = try Self.channel(session)
        #expect(throws: AuthenticatedSidecarChannel.Failure.invalidPayload) {
            try channel.open(Self.runtimeFrame(payload, fixture: fixture), decode: SidecarRuntimeMessage.init)
        }
        #expect(channel.isRetired)
        #expect(throws: AuthenticatedSidecarChannel.Failure.retired) {
            try channel.open(Self.frame(fixture, "acceptFrameBase64"))
        }
    }

    private static func runtimeFrame(_ payload: Data, fixture: [String: Any]) throws -> Data {
        let session = try #require(fixture["session"] as? [String: Any])
        let id = try #require(session["id"] as? String)
        var header = try Self.frame(fixture, "acceptFrameBase64").prefix(31 + id.utf8.count)
        var count = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &count) { header.replaceSubrange(27..<31, with: $0) }
        return try Self.resign(header + payload + Data(repeating: 0, count: 32), session: session)
    }

    private static func frame(_ fixture: [String: Any], _ name: String) throws -> Data {
        let encoded = try #require(fixture[name] as? String)
        return try #require(Data(base64Encoded: encoded))
    }

    private static func key(_ session: [String: Any]) throws -> Data {
        try self.frame(session, session["keyBase64"] == nil ? "sessionKeyBase64" : "keyBase64")
    }

    private static func channel(_ session: [String: Any]) throws -> AuthenticatedSidecarChannel {
        try AuthenticatedSidecarChannel(
            key: self.key(session), sessionID: #require(session["id"] as? String),
            generation: #require(session["generation"] as? UInt64), maxFrameBytes: 4096)
    }

    private static func resign(_ frame: Data, session: [String: Any]) throws -> Data {
        var authenticated = Data(frame.dropLast(32))
        try authenticated.append(contentsOf: HMAC<SHA256>.authenticationCode(
            for: authenticated, using: SymmetricKey(data: Self.key(session))))
        return authenticated
    }
}

/// Flatten only in assertions; production pipe writes retain the borrowed body.
extension SidecarPayload {
    var bytes: Data {
        self.segments.reduce(into: Data()) { bytes, segment in
            segment.withUnsafeBytes { bytes.append(contentsOf: $0) }
        }
    }
}

extension AuthenticatedSidecarChannel {
    func open(_ frame: Data) throws -> Any {
        try self.open(frame) { try JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) }
    }
}
