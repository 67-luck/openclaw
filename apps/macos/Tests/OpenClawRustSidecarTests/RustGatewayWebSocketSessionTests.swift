import Foundation
import Testing
@testable import OpenClawRustSidecar

struct RustGatewayWebSocketSessionTests {
    @Test func `IPC framing preserves native UTF8 JSON bytes within the charged envelope`() throws {
        let original = Data(#"  {"id":"receipt","number":1.234567890123456789e+30,"text":"\u0061 / 😀"}  "#.utf8)
        for callerOwnsLifetime in [false, true] {
            let prefix = RustGatewayWebSocketSession.framePrefix(callerOwnsLifetime: callerOwnsLifetime)
            let prepared = try RustGatewayWebSocketSession.prepareGatewayFrame(original, prefix: prefix)
            #expect(prepared.data.count == original.count + prefix.count + 1)
            #expect(prepared.data.dropFirst(prefix.count).dropLast() == original)
            let envelope = try #require(JSONSerialization.jsonObject(with: prepared.data) as? [String: Any])
            #expect(envelope["type"] as? String == "frame")
            #expect(envelope["callerOwnsLifetime"] as? Bool == callerOwnsLifetime)
            #expect((envelope["frame"] as? [String: Any])?["text"] as? String == "a / 😀")
        }
    }

    @Test func `IPC framing rejects non UTF8 objects and trailing JSON`() {
        let object = "{\"id\":\"receipt\"}"
        let invalid = [
            Data("[]".utf8),
            Data("{}{}".utf8),
            Data("{} trailing".utf8),
            Data([0xEF, 0xBB, 0xBF]) + Data(object.utf8),
            Data([0x7B, 0x22, 0x78, 0x22, 0x3A, 0x22, 0xFF, 0x22, 0x7D]),
        ] +
            [String.Encoding.utf16, .utf16LittleEndian, .utf16BigEndian, .utf32, .utf32LittleEndian, .utf32BigEndian]
            .compactMap { object.data(using: $0) }
        for input in invalid {
            #expect(throws: (any Error).self) {
                try RustGatewayWebSocketSession.prepareGatewayFrame(
                    input, prefix: RustGatewayWebSocketSession.framePrefix(callerOwnsLifetime: false))
            }
        }
    }

    @Test func `commandless connect retains identity with an empty manifest`() throws {
        let commandlessConnect = try Self.frame([
            "type": "req",
            "id": "connect-without-commands",
            "method": "connect",
            "params": ["role": "node"],
        ])

        let metadata = RustGatewayWebSocketSession._testConnectMetadata(commandlessConnect)
        #expect(metadata?.id == "connect-without-commands")
        #expect(metadata?.commands.isEmpty == true)
    }

    @Test func `finish retains only terminal connect failures`() throws {
        let connectID = "connect-1"
        let failedConnect = try Self.frame([
            "type": "res",
            "id": connectID,
            "ok": false,
            "error": ["message": "UNAUTHORIZED"],
        ])
        let successfulConnect = try Self.frame([
            "type": "res",
            "id": connectID,
            "ok": true,
        ])
        let invocationEvent = try Self.frame([
            "type": "event",
            "event": "node.invoke.request",
            "params": ["invokeId": "late-native-work"],
        ])
        let ordinaryResponse = try Self.frame([
            "type": "res",
            "id": "ordinary-request",
            "ok": false,
        ])

        #expect(RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            failedConnect, connectID: connectID))
        #expect(!RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            successfulConnect, connectID: connectID))
        #expect(!RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            invocationEvent, connectID: connectID))
        #expect(!RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            ordinaryResponse, connectID: connectID))
        #expect(!RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            failedConnect, connectID: nil))
    }

    @Test func `late delivery after finish is rejected`() throws {
        let invocationEvent = try Self.frame([
            "type": "event",
            "event": "node.invoke.request",
            "params": ["invokeId": "retired-native-work"],
        ])

        #expect(RustGatewayWebSocketSession._testRejectsDeliveryAfterFinish(invocationEvent))
    }

    private static func frame(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
