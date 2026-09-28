import Foundation
import OpenClawKit
import Testing
@testable import OpenClawRustSidecar

struct SidecarWriteQueueTests {
    @Test func `full application count and bytes preserve relay and control delivery`() async {
        let queue = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { gate.signal()
            queue.close(URLError(.cancelled))
            received.finish()
        }
        let first = Data(repeating: 1, count: 40 * 1024 * 1024)
        queue.enqueue(first, lane: .application, write: { _ in
            received.yield(1)
            gate.wait()
        }, failed: { _ in received.yield(-1) })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        let waiting = Data(repeating: 2, count: 40 * 1024 * 1024)
        for _ in 0..<63 {
            queue.enqueue(waiting, lane: .application, write: { _ in received.yield(2) }, failed: { _ in
                received.yield(-1)
            })
        }
        // All 64 application slots are occupied. Neither native relay nor receipts can wait for a count slot.
        queue.enqueue(Data(repeating: 3, count: 34 * 1024 * 1024), lane: .transport, write: { _ in
            received.yield(3)
        }, failed: { _ in received.yield(-1) })
        queue.enqueue(Data([4]), lane: .control, write: { _ in received.yield(4) }, failed: { _ in
            received.yield(-1)
        })
        gate.signal()
        #expect(await iterator.next() == 4)
        #expect(await iterator.next() == 3)
        for _ in 0..<63 {
            #expect(await iterator.next() == 2)
        }
        queue.enqueue(Data([5]), lane: .application, write: { _ in received.yield(5) }, failed: { _ in
            received.yield(-1)
        })
        #expect(await iterator.next() == 5)
    }

    @Test(arguments: [SidecarWriteQueue.Lane.transport, .application])
    func `waiting large writer reserves the next released payload credit`(lane: SidecarWriteQueue.Lane) async {
        let queue = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { gate.signal()
            queue.close(URLError(.cancelled))
            received.finish()
        }
        queue.enqueue(Data(repeating: 1, count: 30 * 1024 * 1024), lane: .application, write: { _ in
            received.yield(1)
            gate.wait()
        }, failed: { _ in received.yield(-1) })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        for (value, bytes, lane) in [
            (2, 30 * 1024 * 1024, SidecarWriteQueue.Lane.application),
            (3, 10 * 1024 * 1024, lane),
            (4, 1, .application),
        ] {
            queue.enqueue(Data(repeating: UInt8(value), count: bytes), lane: lane, write: { _ in
                received.yield(value)
            }, failed: { _ in received.yield(-1) })
        }
        gate.signal()
        #expect(await iterator.next() == 2)
        #expect(await iterator.next() == 3)
        #expect(await iterator.next() == 4)
    }

    @Test func `successful request orders lifetime cancellation after its frame`() async throws {
        let queue = SidecarWriteQueue()
        let lifetime = WebSocketRequestLifetime()
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { queue.close(URLError(.cancelled))
            received.finish()
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.enqueue(
                Data([1]),
                lane: .application,
                lifetime: lifetime,
                continuation: continuation,
                prepare: { ($0, Data([2])) },
                write: { data in received.yield(Int(data[0])) },
                failed: { _ in received.yield(-1) })
        }
        lifetime.finish()
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        #expect(await iterator.next() == 2)
        lifetime.finish()
        queue.enqueue(Data([3]), lane: .control, write: { _ in received.yield(3) }, failed: { _ in received.yield(-1) })
        #expect(await iterator.next() == 3)
    }

    @Test func `cancelled waiting and admitted requests never reach the pipe`() async {
        let queue = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { gate.signal()
            queue.close(URLError(.cancelled))
            received.finish()
        }
        queue.enqueue(Data(repeating: 1, count: 40 * 1024 * 1024), lane: .application, write: { _ in
            received.yield(1)
            gate.wait()
        }, failed: { _ in received.yield(-1) })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        let waitingLifetime = WebSocketRequestLifetime()
        let admittedLifetime = WebSocketRequestLifetime()
        for (byte, size, lifetime) in [(2, 40, waitingLifetime), (3, 10, admittedLifetime)] {
            queue.enqueue(
                Data(repeating: UInt8(byte), count: size * 1024 * 1024), lane: .application, lifetime: lifetime,
                prepare: { data in (data, Data([99])) },
                write: { _ in received.yield(byte) }, failed: { _ in received.yield(-1) })
        }
        waitingLifetime.finish()
        admittedLifetime.finish()
        queue.enqueue(Data([4]), lane: .application, write: { _ in received.yield(4) }, failed: { _ in
            received.yield(-1)
        })
        gate.signal()
        #expect(await iterator.next() == 4)
    }

    @Test func `retirement wakes a byte blocked writer before the pipe drains`() async {
        let queue = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { gate.signal()
            received.finish()
        }
        queue.enqueue(Data(repeating: 1, count: 40 * 1024 * 1024), lane: .application, write: { _ in
            received.yield(1)
            gate.wait()
        }, failed: { _ in })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        let waiting = Task {
            do {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    queue.enqueue(
                        Data(repeating: 2, count: 40 * 1024 * 1024), lane: .application,
                        continuation: continuation, write: { _ in received.yield(-1) }, failed: { _ in })
                    received.yield(2)
                }
                return false
            } catch { return (error as? URLError)?.code == .cancelled }
        }
        #expect(await iterator.next() == 2)
        queue.close(URLError(.cancelled))
        #expect(await waiting.value)
        // The first injected pipe write is still blocked: retirement cannot rely on its completion.
        gate.signal()
    }
}
