import Foundation
import OpenClawKit
import Testing
@testable import OpenClawRustSidecar

struct NativeGatewayTransportTests {
    @Test func `incoming backpressure does not block outgoing write receipts`() async throws {
        let socket = RelaySocket()
        let (writes, capture) = AsyncStream<Data>.makeStream()
        let transport = NativeGatewayTransport(
            socket: WebSocketTaskBox(task: socket),
            write: { data, _ in
                capture.yield(data)
            }, failed: { _ in })
        defer { transport.close()
            capture.finish()
        }
        transport.start()
        socket.provide(.string("challenge"))
        var iterator = writes.makeAsyncIterator()
        let first = try #require(await iterator.next())
        #expect(try Self.message(first)["type"] as? String == "transport-frame")
        #expect(socket.receiveCount == 1)
        // Incoming consumption is paused, but an independent native send/receipt can finish.
        try transport.send(id: 1, kind: "text", encoded: Data("connect".utf8).base64EncodedString())
        let receipt = try #require(await iterator.next())
        #expect(try Self.message(receipt)["type"] as? String == "transport-sent")
        #expect(socket.receiveCount == 1)
        #expect(socket.sent == ["connect"])
        try transport.received()
        socket.provide(.string("hello"))
        let second = try #require(await iterator.next())
        #expect(try Self.message(second)["type"] as? String == "transport-frame")
        #expect(socket.receiveCount == 2)
        transport.close()
        #expect(throws: (any Error).self) {
            try transport.send(id: 2, kind: "text", encoded: Data("retired".utf8).base64EncodedString())
        }
        #expect(socket.sent == ["connect"])
    }

    @Test func `ping submission lets inbound messages progress before real Pong`() async throws {
        let socket = RelaySocket(holdPong: true)
        let writes = RelayWrites()
        let transport = NativeGatewayTransport(
            socket: WebSocketTaskBox(task: socket),
            write: { data, lane in
                writes.append(data, lane: lane)
            }, failed: { _ in })
        defer { transport.close() }
        transport.start()
        socket.provide(.string("tick"))
        try await writes.waitForCount(1)
        try transport.send(id: 1, kind: "ping", encoded: "")
        try await writes.waitForCount(2)
        #expect(try writes.types() == ["transport-frame", "transport-sent"])
        #expect(socket.receiveCount == 1)
        #expect(throws: (any Error).self) { try transport.send(id: 2, kind: "ping", encoded: "") }
        // Application writes remain available while the single Ping awaits its actual Pong.
        try transport.send(id: 3, kind: "text", encoded: Data("result".utf8).base64EncodedString())
        try await writes.waitForCount(3)
        #expect(socket.sent == ["result"])
        try transport.received()
        socket.provide(.string("next tick"))
        try await writes.waitForCount(4)
        socket.completePong()
        try await writes.waitForCount(5)
        let pong = try Self.message(#require(writes.values.last?.0))
        #expect(pong["type"] as? String == "transport-pong")
        #expect(pong["id"] as? UInt64 == 1)
        #expect(pong["ok"] as? Bool == true)
        #expect(writes.values.last?.1 == .pong)
    }

    @Test func `retired native route drops a previously installed late Pong callback`() async throws {
        let socket = RelaySocket(holdPong: true)
        let writes = RelayWrites()
        let transport = NativeGatewayTransport(
            socket: WebSocketTaskBox(task: socket),
            write: { data, lane in
                writes.append(data, lane: lane)
            }, failed: { _ in })
        transport.start()
        try transport.send(id: 1, kind: "ping", encoded: "")
        try await writes.waitForCount(1)
        try await waitForCondition { socket.pongPending }
        transport.close()
        socket.completePong()
        try await Task.sleep(for: .milliseconds(50))
        #expect(try writes.types() == ["transport-sent"])
    }

    @Test func `full gateway binary payload fits authenticated envelope even with all slashes`() async throws {
        let socket = RelaySocket()
        let (writes, capture) = AsyncStream<Data>.makeStream()
        let transport = NativeGatewayTransport(
            socket: WebSocketTaskBox(task: socket),
            write: { data, _ in
                capture.yield(data)
            }, failed: { _ in })
        defer { transport.close()
            capture.finish()
        }
        transport.start()
        let bytes = Data(repeating: 255, count: 25 * 1024 * 1024)
        socket.provide(.data(bytes))
        var iterator = writes.makeAsyncIterator()
        let frame = try #require(await iterator.next())
        let message = try Self.message(frame)
        let encoded = try #require(message["data"] as? String)
        #expect(Data(base64Encoded: encoded) == bytes)
        let channel = try AuthenticatedSidecarChannel(
            key: Data(repeating: 1, count: 32), sessionID: "media", generation: 1)
        let authenticated = try channel.seal(frame)
        #expect(authenticated.count <= channel.maxFrameBytes + 4)
    }

    private static func message(_ data: Data) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private final class RelaySocket: WebSocketTasking, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: CheckedContinuation<URLSessionWebSocketTask.Message, any Error>?
    private var buffered: [URLSessionWebSocketTask.Message] = []
    private var closed = false
    private var reads = 0
    private var writes: [String] = []
    private let holdPong: Bool
    private var pong: (@Sendable ((any Error)?) -> Void)?

    init(holdPong: Bool = false) {
        self.holdPong = holdPong
    }

    var pongPending: Bool {
        self.lock.withLock { self.pong != nil }
    }

    func completePong() {
        let callback = self.lock.withLock {
            defer { self.pong = nil }
            return self.pong
        }
        callback?(nil)
    }

    var receiveCount: Int {
        self.lock.withLock { self.reads }
    }

    var sent: [String] {
        self.lock.withLock { self.writes }
    }

    var state: URLSessionTask.State {
        self.lock.withLock { self.closed ? .completed : .running }
    }

    func resume() {}
    func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {
        let pending = self.lock.withLock {
            self.closed = true
            defer { self.pending = nil }
            return self.pending
        }
        pending?.resume(throwing: URLError(.cancelled))
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try self.lock.withLock {
            guard !self.closed else { throw URLError(.cancelled) }
            if case let .string(text) = message { self.writes.append(text) }
        }
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable ((any Error)?) -> Void) {
        if self.holdPong { self.lock.withLock { self.pong = pongReceiveHandler } } else { pongReceiveHandler(nil) }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            self.lock.withLock {
                self.reads += 1
                if self.closed { continuation.resume(throwing: URLError(.cancelled)) } else if !self.buffered.isEmpty {
                    continuation.resume(returning: self.buffered.removeFirst())
                } else { self.pending = continuation }
            }
        }
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, any Error>) -> Void) {
        Task {
            do { try await completionHandler(.success(self.receive())) } catch { completionHandler(.failure(error)) }
        }
    }

    func provide(_ message: URLSessionWebSocketTask.Message) {
        self.lock.withLock {
            if let pending = self.pending { self.pending = nil
                pending.resume(returning: message)
            } else { self.buffered.append(message) }
        }
    }
}

private final class RelayWrites: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [(Data, SidecarWriteQueue.Lane)] = []
    var values: [(Data, SidecarWriteQueue.Lane)] {
        self.lock.withLock { self.stored }
    }

    func append(_ data: Data, lane: SidecarWriteQueue.Lane) {
        self.lock.withLock { self.stored.append((data, lane)) }
    }

    func types() throws -> [String] {
        try self.values
            .map { try #require((JSONSerialization.jsonObject(with: $0.0) as? [String: Any])?["type"] as? String) }
    }

    func waitForCount(_ count: Int) async throws {
        try await waitForCondition { self.values.count >= count }
    }
}

private func waitForCondition(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(1)
    while !condition() {
        guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
        try await Task.sleep(for: .milliseconds(5))
    }
}
