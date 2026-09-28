import Foundation
import OpenClawKit

/// URLSession owns the real socket, system proxy/PAC routing, DNS and TLS challenge.
/// Rust owns the Gateway protocol and node execution; one acknowledged message per direction
/// bounds the relay without making the IPC reader wait for network or pipe writes.
final class NativeGatewayTransport: @unchecked Sendable {
    static let maximumMessageBytes = 25 * 1024 * 1024
    private let lock = NSLock()
    private let socket: WebSocketTaskBox
    private let write: @Sendable (Data) async throws -> Void
    private let failed: @Sendable (any Error) -> Void
    private var stopped = false
    private var sending = false
    private var receipt: CheckedContinuation<Void, any Error>?
    private var receiver: Task<Void, Never>?

    init(
        socket: WebSocketTaskBox,
        write: @escaping @Sendable (Data) async throws -> Void,
        failed: @escaping @Sendable (any Error) -> Void)
    {
        self.socket = socket
        self.write = write
        self.failed = failed
        // The Gateway admits native media up to 25 MiB. Preserve that limit before
        // URLSession allocates a message, independently of the larger IPC envelope.
        (socket.task as? URLSessionWebSocketTask)?.maximumMessageSize = Self.maximumMessageBytes
    }

    func start() {
        self.lock.withLock {
            guard !self.stopped, self.receiver == nil else { return }
            self.socket.resume()
            self.receiver = Task { [self] in
                do {
                    while !Task.isCancelled {
                        let message = try await self.socket.receive()
                        let kind: String
                        let data: Data
                        switch message {
                        case let .string(text): kind = "text"
                            data = Data(text.utf8)
                        case let .data(bytes): kind = "binary"
                            data = bytes
                        @unknown default: throw URLError(.cannotParseResponse)
                        }
                        guard data.count <= Self.maximumMessageBytes else {
                            throw URLError(.dataLengthExceedsMaximum)
                        }
                        let payload = try JSONSerialization.data(withJSONObject: [
                            "type": "transport-frame", "kind": kind, "data": data.base64EncodedString(),
                        ], options: [.withoutEscapingSlashes])
                        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<
                            Void,
                            any Error,
                        >) in
                            let accepted = self.lock.withLock {
                                guard !self.stopped, self.receipt == nil else { return false }
                                self.receipt = continuation
                                return true
                            }
                            guard accepted else { continuation.resume(throwing: URLError(.cancelled))
                                return
                            }
                            Task {
                                do { try await self.write(payload) } catch { self.fail(error) }
                            }
                        }
                    }
                } catch { self.fail(error) }
            }
        }
    }

    func received() throws {
        let receipt = self.lock.withLock { () -> CheckedContinuation<Void, any Error>? in
            defer { self.receipt = nil }
            return self.receipt
        }
        guard let receipt else { throw URLError(.cannotParseResponse) }
        receipt.resume()
    }

    func send(id: UInt64, kind: String, encoded: String) throws {
        guard encoded.utf8.count <= ((Self.maximumMessageBytes + 2) / 3) * 4,
              let data = Data(base64Encoded: encoded), data.count <= Self.maximumMessageBytes,
              ["text", "ping", "close"].contains(kind)
        else { throw URLError(.cannotParseResponse) }
        let accepted = self.lock.withLock {
            guard !self.stopped, !self.sending else { return false }
            self.sending = true
            return true
        }
        guard accepted else { throw URLError(.networkConnectionLost) }
        Task {
            do {
                guard !self.lock.withLock({ self.stopped }) else { throw URLError(.cancelled) }
                switch kind {
                case "text":
                    guard let text = String(data: data, encoding: .utf8) else {
                        throw URLError(.cannotParseResponse)
                    }
                    try await self.socket.send(.string(text))
                case "ping": try await self.socket.sendPing()
                case "close": self.socket.cancel(with: .normalClosure, reason: nil)
                default: throw URLError(.cannotParseResponse)
                }
                self.lock.withLock { self.sending = false }
                try await self.write(JSONSerialization.data(withJSONObject: [
                    "type": "transport-sent", "id": id, "ok": true,
                ]))
            } catch { self.fail(error) }
        }
    }

    func close() {
        let retired = self.lock.withLock { () -> (Task<Void, Never>?, CheckedContinuation<Void, any Error>?) in
            self.stopped = true
            defer { self.receiver = nil
                self.receipt = nil
            }
            return (self.receiver, self.receipt)
        }
        self.socket.cancel(with: .goingAway, reason: nil)
        retired.0?.cancel()
        retired.1?.resume(throwing: URLError(.cancelled))
    }

    private func fail(_ error: any Error) {
        let report = self.lock.withLock { !self.stopped }
        self.close()
        if report { self.failed(error) }
    }
}
