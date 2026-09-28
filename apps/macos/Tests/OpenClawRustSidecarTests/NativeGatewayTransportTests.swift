import Foundation
import OpenClawKit
import Testing
@testable import OpenClawRustSidecar

struct NativeGatewayTransportTests {
    @Test func `binary storage is released before a blocked receipt admits another send`() async throws {
        let lifetime = PayloadLifetime()
        let (sendReleases, releaseSend) = AsyncStream<Void>.makeStream()
        let (receiptReleases, releaseReceipt) = AsyncStream<Void>.makeStream()
        let writes = RelayWrites()
        let socket = RelaySocket(onSend: { message in
            guard case let .data(bytes) = message else {
                Issue.record("Expected binary message")
                return
            }
            #expect(bytes.count == 1024)
            #expect(bytes.first == 0x5A)
            #expect(!lifetime.isReleased)
            lifetime.enteredSend()
            var release = sendReleases.makeAsyncIterator()
            _ = await release.next()
        })
        let transport = NativeGatewayTransport(
            socket: WebSocketTaskBox(task: socket),
            write: { payload, lane in
                writes.append(payload, lane: lane)
                var release = receiptReleases.makeAsyncIterator()
                _ = await release.next()
            }, failed: { error in Issue.record("Unexpected transport failure: \(error)") })
        defer {
            releaseSend.yield(())
            releaseSend.finish()
            releaseReceipt.yield(())
            releaseReceipt.finish()
            transport.close()
        }
        try autoreleasepool {
            try transport.send(id: 1, kind: "binary", data: lifetime.makeData())
        }
        try await waitForCondition { lifetime.sendEntered }
        #expect(!lifetime.isReleased)
        #expect(throws: (any Error).self) {
            try transport.send(id: 2, kind: "binary", data: Data([0]))
        }
        releaseSend.yield(())
        try await writes.waitForCount(1)
        #expect(try writes.types() == ["transport-sent"])
        // The observer cannot fire while the fake socket owns its bytes. Once its send
        // returns, the adapter must release them even though the IPC receipt is blocked.
        #expect(lifetime.isReleased)
    }

    @Test func `typed writes reject unknown kind and oversized bytes before socket effects`() throws {
        let socket = RelaySocket()
        let transport = NativeGatewayTransport(
            socket: WebSocketTaskBox(task: socket), write: { _, _ in }, failed: { _ in })
        defer { transport.close() }
        #expect(throws: (any Error).self) {
            try transport.send(id: 1, kind: "unknown", data: Data())
        }
        #expect(throws: (any Error).self) {
            try transport.send(id: 2, kind: "binary", data: Data(
                repeating: 0, count: NativeGatewayTransport.maximumMessageBytes + 1))
        }
        #expect(socket.sent.isEmpty)
        #expect(socket.sentBinary.isEmpty)
        #expect(!socket.pongPending)
    }

    @Test(arguments: ["text", "binary"])
    func `incoming backpressure does not block outgoing write receipts`(kind: String) async throws {
        let socket = RelaySocket()
        let (writes, capture) = AsyncStream<SidecarPayload>.makeStream()
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
        let outgoing = kind == "text" ? Data("connect 🦞 café".utf8) : Data([0, 255, 128])
        try transport.send(id: 1, kind: kind, data: outgoing)
        let receipt = try #require(await iterator.next())
        #expect(try Self.message(receipt)["type"] as? String == "transport-sent")
        #expect(socket.receiveCount == 1)
        #expect(socket.sent == (kind == "text" ? ["connect 🦞 café"] : []))
        #expect(socket.sentBinary == (kind == "binary" ? [outgoing] : []))
        try transport.received()
        socket.provide(.string("hello"))
        let second = try #require(await iterator.next())
        #expect(try Self.message(second)["type"] as? String == "transport-frame")
        #expect(socket.receiveCount == 2)
        transport.close()
        #expect(throws: (any Error).self) {
            try transport.send(id: 2, kind: kind, data: Data("retired".utf8))
        }
        #expect(socket.sent == (kind == "text" ? ["connect 🦞 café"] : []))
        #expect(socket.sentBinary == (kind == "binary" ? [outgoing] : []))
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
        try transport.send(id: 1, kind: "ping", data: Data())
        try await writes.waitForCount(2)
        #expect(try writes.types() == ["transport-frame", "transport-sent"])
        #expect(socket.receiveCount == 1)
        #expect(throws: (any Error).self) { try transport.send(id: 2, kind: "ping", data: Data()) }
        // Application writes remain available while the single Ping awaits its actual Pong.
        try transport.send(id: 3, kind: "text", data: Data("result".utf8))
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
        try transport.send(id: 1, kind: "ping", data: Data())
        try await writes.waitForCount(1)
        try await waitForCondition { socket.pongPending }
        transport.close()
        socket.completePong()
        try await Task.sleep(for: .milliseconds(50))
        #expect(try writes.types() == ["transport-sent"])
    }

    @Test func `full gateway binary payload fits authenticated envelope even with all slashes`() async throws {
        let socket = RelaySocket()
        let (writes, capture) = AsyncStream<SidecarPayload>.makeStream()
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

    private static func message(_ data: SidecarPayload) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: data.bytes) as? [String: Any])
    }
}

private final class RelaySocket: WebSocketTasking, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: CheckedContinuation<URLSessionWebSocketTask.Message, any Error>?
    private var buffered: [URLSessionWebSocketTask.Message] = []
    private var closed = false
    private var reads = 0
    private var writes: [String] = []
    private var binaryWrites: [Data] = []
    private let holdPong: Bool
    private let onSend: (@Sendable (URLSessionWebSocketTask.Message) async throws -> Void)?
    private var pong: (@Sendable ((any Error)?) -> Void)?

    init(
        holdPong: Bool = false,
        onSend: (@Sendable (URLSessionWebSocketTask.Message) async throws -> Void)? = nil)
    {
        self.holdPong = holdPong
        self.onSend = onSend
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

    var sentBinary: [Data] {
        self.lock.withLock { self.binaryWrites }
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
        if let onSend {
            try await onSend(message)
            return
        }
        try self.lock.withLock {
            guard !self.closed else { throw URLError(.cancelled) }
            switch message {
            case let .string(text): self.writes.append(text)
            case let .data(bytes): self.binaryWrites.append(bytes)
            @unknown default: throw URLError(.cannotParseResponse)
            }
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
    private var stored: [(SidecarPayload, SidecarWriteQueue.Lane)] = []
    var values: [(SidecarPayload, SidecarWriteQueue.Lane)] {
        self.lock.withLock { self.stored }
    }

    func append(_ data: SidecarPayload, lane: SidecarWriteQueue.Lane) {
        self.lock.withLock { self.stored.append((data, lane)) }
    }

    func types() throws -> [String] {
        try self.values
            .map { try #require((JSONSerialization.jsonObject(with: $0.0.bytes) as? [String: Any])?["type"] as? String)
            }
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

private final class PayloadLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var released = false
    private var entered = false

    var isReleased: Bool {
        self.lock.withLock { self.released }
    }

    var sendEntered: Bool {
        self.lock.withLock { self.entered }
    }

    func enteredSend() {
        self.lock.withLock { self.entered = true }
    }

    func makeData() -> Data {
        let bytes = UnsafeMutableRawPointer.allocate(byteCount: 1024, alignment: 1)
        bytes.initializeMemory(as: UInt8.self, repeating: 0x5A, count: 1024)
        return Data(bytesNoCopy: bytes, count: 1024, deallocator: .custom { bytes, _ in
            bytes.deallocate()
            self.lock.withLock { self.released = true }
        })
    }
}
