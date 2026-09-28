import Foundation
import OpenClawKit

/// Bounds admitted payload bytes separately from the original messages held by waiting callers.
/// At most 64 application writes, one acknowledged relay, and 64 small controls retain queue slots.
final class SidecarWriteQueue: @unchecked Sendable {
    enum Lane: Sendable { case application, transport, control }
    typealias Prepared = (data: Data, cancellation: Data?)

    private final class Request: @unchecked Sendable {
        let id = UUID()
        let data: Data
        let lane: Lane
        let chargedBytes: Int
        let lifetime: WebSocketRequestLifetime?
        let prepare: @Sendable (Data) throws -> Prepared
        let write: @Sendable (Data) throws -> Void
        var continuation: CheckedContinuation<Void, Error>?
        var admitted = false
        var cancelled = false

        init(
            data: Data, lane: Lane, envelopeBytes: Int, lifetime: WebSocketRequestLifetime?,
            continuation: CheckedContinuation<Void, Error>?,
            prepare: @escaping @Sendable (Data) throws -> Prepared,
            write: @escaping @Sendable (Data) throws -> Void)
        {
            self.data = data
            self.lane = lane
            self.chargedBytes = data.count + envelopeBytes
            self.lifetime = lifetime
            self.continuation = continuation
            self.prepare = prepare
            self.write = write
        }
    }

    let queue = DispatchQueue(label: "ai.openclaw.sidecar.write")
    private let lock = NSLock()
    private var failure: Error?
    private var requests: [UUID: Request] = [:]
    private var waiting: [UUID] = []
    private var payloadBytes = 0
    private var controlBytes = 0

    func enqueue(
        _ data: Data,
        lane: Lane,
        envelopeBytes: Int = 0,
        lifetime: WebSocketRequestLifetime? = nil,
        continuation: CheckedContinuation<Void, Error>? = nil,
        prepare: @escaping @Sendable (Data) throws -> Prepared = { ($0, nil) },
        write: @escaping @Sendable (Data) throws -> Void,
        failed: @escaping @Sendable (Error) -> Void)
    {
        let request = Request(
            data: data, lane: lane, envelopeBytes: envelopeBytes, lifetime: lifetime,
            continuation: continuation, prepare: prepare, write: write)
        let register = {
            self.lock.lock()
            let count = self.requests.values.filter { $0.lane == lane }.count
            let limit = lane == .transport ? 1 : 64
            let byteLimit = lane == .control ? 64 * 1024 : 64 * 1024 * 1024
            guard self.failure == nil, count < limit, request.chargedBytes <= byteLimit else {
                let error = self.failure ?? URLError(.dataLengthExceedsMaximum)
                self.lock.unlock()
                continuation?.resume(throwing: error)
                failed(error)
                return
            }
            self.requests[request.id] = request
            self.waiting.append(request.id)
            let ready = self.admitLocked()
            self.lock.unlock()
            self.schedule(ready, failed: failed)
        }
        if let lifetime {
            let id = request.id
            if !lifetime.performIfActive(register, onFinish: { self.cancelWaiting(id) }) {
                continuation?.resume(throwing: CancellationError())
            }
        } else { register() }
    }

    private func admitLocked() -> [Request] {
        var ready: [Request] = []
        // A full application lane must not starve the one acknowledged native relay
        // message, or its receipts. Their bounded owners have separate count allowances.
        for lane in [Lane.control, .transport, .application] {
            if lane == .application, self.waiting.contains(where: { self.requests[$0]?.lane == .transport }) {
                break
            }
            var blocked = false
            self.waiting.removeAll { id in
                guard let request = self.requests[id] else { return true }
                guard request.lane == lane, !blocked else { return false }
                let control = lane == .control
                let used = control ? self.controlBytes : self.payloadBytes
                let limit = control ? 64 * 1024 : 64 * 1024 * 1024
                guard used + request.chargedBytes <= limit else {
                    blocked = true
                    return false
                }
                request.admitted = true
                if control { self.controlBytes += request.chargedBytes }
                else { self.payloadBytes += request.chargedBytes }
                ready.append(request)
                return true
            }
        }
        return ready
    }

    private func schedule(_ ready: [Request], failed: @escaping @Sendable (Error) -> Void) {
        for request in ready {
            self.queue.async {
                do {
                    try self.lock.withLock { if let failure = self.failure { throw failure } }
                    if self.lock.withLock({ request.cancelled }) {
                        self.complete(request.id, error: CancellationError(), failed: failed)
                        return
                    }
                    // Only admitted messages allocate parsed JSON and the IPC envelope.
                    let prepared = try request.prepare(request.data)
                    guard prepared.data.count <= request.chargedBytes else {
                        throw URLError(.dataLengthExceedsMaximum)
                    }
                    let send = {
                        self.queue.async {
                            do {
                                try self.lock.withLock { if let failure = self.failure { throw failure } }
                                try request.write(prepared.data)
                                self.complete(request.id, error: nil, failed: failed)
                            } catch {
                                self.complete(request.id, error: error, failed: failed)
                                failed(error)
                            }
                        }
                    }
                    if let lifetime = request.lifetime {
                        // The completion hook must retain only the tiny cancellation frame,
                        // not the original payload, prepared envelope, or request lifetime.
                        let cancellation = prepared.cancellation
                        let write = request.write
                        let active = lifetime.performIfActive(send, onFinish: {
                            guard let cancellation else { return }
                            self.enqueue(cancellation, lane: .control, write: write, failed: failed)
                        })
                        if !active { self.complete(request.id, error: CancellationError(), failed: failed) }
                    } else { send() }
                } catch {
                    self.complete(request.id, error: error, failed: failed)
                    failed(error)
                }
            }
        }
    }

    private func cancelWaiting(_ id: UUID) {
        self.lock.lock()
        guard let request = self.requests[id] else { self.lock.unlock()
            return
        }
        let continuation = request.continuation
        request.continuation = nil
        request.cancelled = true
        // Admitted closures retain their credit until drained, bounding cancelled work too.
        if !request.admitted {
            self.requests.removeValue(forKey: id)
            self.waiting.removeAll { $0 == id }
        }
        self.lock.unlock()
        continuation?.resume(throwing: CancellationError())
    }

    private func complete(_ id: UUID, error: Error?, failed: @escaping @Sendable (Error) -> Void) {
        self.lock.lock()
        guard let request = self.requests.removeValue(forKey: id) else { self.lock.unlock()
            return
        }
        if request.lane == .control { self.controlBytes -= request.chargedBytes }
        else { self.payloadBytes -= request.chargedBytes }
        let continuation = request.continuation
        request.continuation = nil
        let ready = self.admitLocked()
        self.lock.unlock()
        if let error { continuation?.resume(throwing: error) } else { continuation?.resume() }
        self.schedule(ready, failed: failed)
    }

    func close(_ error: Error) {
        self.lock.lock()
        guard self.failure == nil else { self.lock.unlock()
            return
        }
        self.failure = error
        let continuations = self.requests.values.compactMap(\.continuation)
        self.requests.removeAll()
        self.waiting.removeAll()
        self.payloadBytes = 0
        self.controlBytes = 0
        self.lock.unlock()
        for continuation in continuations {
            continuation.resume(throwing: error)
        }
    }
}
