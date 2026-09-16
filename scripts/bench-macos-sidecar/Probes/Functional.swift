import Foundation
import OpenClawKit
import OpenClawProtocol
import OpenClawRustSidecar

actor InputInbox {
    var waiting: [String: CheckedContinuation<String, Never>] = [:]
    var buffered: [String: String] = [:]
    func take(_ id: String) async -> String {
        if let value = buffered.removeValue(forKey: id) { return value }
        return await withCheckedContinuation { self.waiting[id] = $0 }
    }

    func deliver(_ input: NodeInvokeInputEvent) {
        if let pending = waiting.removeValue(forKey: input.id) { pending.resume(returning: input.payloadjson) }
        else { self.buffered[input.id] = input.payloadjson }
    }
}

@main struct FunctionalProbe {
    static func main() async throws {
        let url = URL(string: CommandLine.arguments[1])!
        let session = GatewayNodeSession()
        let inbox = InputInbox()
        let transport: any WebSocketSessioning = CommandLine
            .arguments[2] == "baseline" ? URLSession(configuration: .ephemeral) :
            RustGatewayWebSocketSession(executableURL: URL(fileURLWithPath: CommandLine.arguments[2]))
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["benchmark"],
            commands: ["benchmark.echo", "benchmark.raw", "system.echo", "benchmark.duplex", "system.notify"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "RFC54 functional probe",
            includeDeviceIdentity: false,
            allowStoredDeviceAuth: false)
        try await session.connect(
            url: url,
            token: "benchmark-token",
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: transport),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                if req.command == "benchmark.duplex" || req.command == "system.notify" {
                    do {
                        _ = try await session.request(
                            method: "node.invoke.progress",
                            params: [
                                "invokeId": AnyCodable(req.id),
                                "nodeId": AnyCodable(req.nodeId!),
                                "seq": AnyCodable(0),
                                "chunk": AnyCodable("native-start"),
                            ])
                        if req.command == "benchmark.duplex" {
                            let payload = await inbox.take(req.id)
                            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
                        }
                        try await Task.sleep(for: .seconds(30))
                        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: "{}")
                    } catch {
                        print("{\"nativeCancelled\":\"\(req.id)\"}")
                        fflush(stdout)
                        return BridgeInvokeResponse(
                            id: req.id,
                            ok: false,
                            error: OpenClawNodeError(code: .unavailable, message: "native operation cancelled"))
                    }
                }
                if req.command == "benchmark.raw" { return BridgeInvokeResponse(
                    id: req.id,
                    ok: true,
                    payload: AnyCodable(["present": req.paramsJSON != nil, "raw": req.paramsJSON ?? "missing"])) }
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: req.paramsJSON)
            },
            onInvokeInput: { event in await inbox.deliver(event) },
            onInvokeCancel: { id in
                print("{\"nativeCancelEvent\":\"\(id)\"}")
                fflush(stdout)
            })
        print("{\"ready\":true,\"pid\":\(ProcessInfo.processInfo.processIdentifier)}")
        fflush(stdout)
        while readLine() != nil {}
        await session.disconnect()
    }
}
