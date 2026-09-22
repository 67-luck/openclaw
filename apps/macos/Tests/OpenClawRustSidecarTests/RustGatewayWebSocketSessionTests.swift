import Foundation
import Testing
@testable import OpenClawRustSidecar

struct RustGatewayWebSocketSessionTests {
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
