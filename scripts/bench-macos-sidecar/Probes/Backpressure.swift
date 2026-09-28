import Foundation
import OpenClawKit
import OpenClawRustSidecar

@main struct BackpressureProbe {
    static func send(_ task: WebSocketTaskBox, _ value: [String: Any]) async throws {
        try await task.send(.data(JSONSerialization.data(withJSONObject: value)))
    }

    static func read(_ task: WebSocketTaskBox) async throws -> [String: Any] {
        let data: Data
        switch try await task.receive() {
        case let .data(bytes): data = bytes
        case let .string(text): data = Data(text.utf8)
        @unknown default: throw URLError(.cannotParseResponse)
        }
        guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw URLError(.cannotParseResponse) }
        return frame
    }

    static func connect(_ session: RustGatewayWebSocketSession, _ url: URL) async throws -> WebSocketTaskBox {
        let task = session.makeWebSocketTask(url: url)
        task.resume()
        guard try await self.read(task)["event"] as? String == "connect.challenge"
        else { throw URLError(.badServerResponse) }
        try await self.send(task, ["type": "req", "id": "connect-native-probe", "method": "connect", "params": [
            "minProtocol": 4, "maxProtocol": 4, "role": "node", "commands": [],
            "client": ["id": "openclaw-macos", "mode": "node", "platform": "macos", "version": "probe"],
        ]])
        guard try await self.read(task)["ok"] as? Bool == true else { throw URLError(.badServerResponse) }
        return task
    }

    static func main() async {
        do {
            let url = URL(string: CommandLine.arguments[1])!
            let session = RustGatewayWebSocketSession(executableURL: URL(fileURLWithPath: CommandLine.arguments[2]))
            let stalled = try await connect(session, url)
            try await send(stalled, ["type": "req", "id": "flood", "method": "benchmark.flood", "params": [:]])
            // Deliberately never call receive while the Gateway sends 512 ordinary events.
            let started = ContinuousClock.now
            while stalled.state != .completed, started.duration(to: .now) < .seconds(8) {
                try await Task.sleep(for: .milliseconds(10))
            }
            guard stalled.state == .completed else { throw URLError(.timedOut) }
            var overflowCode = 0
            do {
                _ = try await self.read(stalled)
                throw URLError(.badServerResponse)
            } catch {
                overflowCode = (error as NSError).code
                guard (error as? URLError)?.code == .dataLengthExceedsMaximum else { throw error }
            }
            let recovered = try await connect(session, url)
            try await send(
                recovered,
                ["type": "req", "id": "after-overload", "method": "benchmark.echo", "params": ["recovered": true]])
            let response = try await read(recovered)
            guard (response["payload"] as? [String: Any])?["recovered"] as? Bool == true
            else { throw URLError(.badServerResponse) }
            recovered.cancel(with: .goingAway, reason: nil)
            let result: [String: Any] = [
                "passed": true,
                "blockedConsumer": true,
                "documentedBufferFrames": 256,
                "overflowCode": overflowCode,
                "freshSessionRecovered": true,
            ]
            try print(String(
                decoding: JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
                as: UTF8.self))
        } catch {
            let failure: [String: Any] = ["passed": false, "error": String(describing: error)]
            if let data = try? JSONSerialization.data(withJSONObject: failure, options: [.sortedKeys]) {
                print(String(decoding: data, as: UTF8.self))
            }
        }
    }
}
