import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct GatewaySetupApplicationTests {
    private static func request(expiresAtMs: Int64? = nil) -> GatewaySetupApplication.Request {
        .init(
            link: GatewayConnectDeepLink(
                host: "gateway-b.example.com",
                port: 443,
                tls: true,
                expiresAtMs: expiresAtMs,
                bootstrapToken: "fixture-bootstrap-b",
                token: nil,
                password: nil),
            source: .scan)
    }

    /// These are orchestration tests. They do not exercise SwiftUI callers or real storage failures.
    @Test func `failed preparation retains the candidate for a successful retry`() async throws {
        let message = "Fixture preparation unavailable"
        let application = GatewaySetupApplication()
        let request = Self.request()
        var writes = 0
        var applied = false

        await application.apply(
            request,
            prepare: { _ in message },
            save: { _ in
                writes += 1
                return true
            },
            isCurrent: { true },
            onReady: { _ in applied = true })

        #expect(writes == 0)
        #expect(!applied)
        #expect(application.failure?.message == message)
        #expect(application.failure?.allowsRetry == true)
        #expect(application.pendingRequest?.link == request.link)
        #expect(!application.isApplying)

        // Retry from the owner-held candidate; no new scan or reconstructed credentials.
        let retry = try #require(application.pendingRequest)
        var retriedTarget: String?
        await application.apply(
            retry,
            prepare: { auth in
                retriedTarget = auth.targetStableID
                return nil
            },
            save: { auth in
                writes += 1
                #expect(auth.token.isEmpty)
                #expect(auth.password.isEmpty)
                #expect(auth.bootstrapToken == "fixture-bootstrap-b")
                return true
            },
            isCurrent: { true },
            onReady: { _ in applied = true })

        #expect(retriedTarget == "manual|gateway-b.example.com|443")
        #expect(writes == 1)
        #expect(applied)
        #expect(application.failure == nil)
        #expect(application.pendingRequest == nil)
    }

    @Test func `failed credential save retains the candidate without invoking onReady`() async {
        let application = GatewaySetupApplication()
        let request = Self.request()
        var events: [String] = []
        await application.apply(
            request,
            prepare: { _ in
                events.append("prepare")
                return nil
            },
            save: { _ in
                events.append("save")
                return false
            },
            isCurrent: { true },
            onReady: { _ in events.append("ready") })

        #expect(events == ["prepare", "save"])
        #expect(application.failure == .credentialSave)
        #expect(application.pendingRequest?.link == request.link)
    }

    @Test func `expired setup stops before preparation and retains no retry candidate`() async {
        let application = GatewaySetupApplication()
        var effects = 0
        await application.apply(
            Self.request(expiresAtMs: 1),
            prepare: { _ in
                effects += 1
                return nil
            },
            save: { _ in
                effects += 1
                return true
            },
            isCurrent: { true },
            onReady: { _ in effects += 1 })

        #expect(effects == 0)
        #expect(application.failure?.allowsRetry == false)
        #expect(application.failure?.message == String(
            localized: "This setup code has expired. Generate and scan a new code."))
        #expect(application.pendingRequest == nil)
    }

    @Test func `late cancelled preparation cannot replace the newer failure or retry candidate`() async {
        let application = GatewaySetupApplication()
        let (started, signalStarted) = AsyncStream<Void>.makeStream()
        let (resume, signalResume) = AsyncStream<Void>.makeStream()
        defer {
            signalStarted.finish()
            signalResume.finish()
        }
        var oldPreparationEntered = false
        var oldSaveCalls = 0
        var oldReadyCalls = 0
        let oldAttempt = Task { @MainActor in
            defer { signalStarted.finish() }
            await application.apply(
                Self.request(),
                prepare: { _ in
                    oldPreparationEntered = true
                    signalStarted.yield()
                    for await _ in resume {
                        break
                    }
                    return "Old preparation failed"
                },
                save: { _ in
                    oldSaveCalls += 1
                    return true
                },
                isCurrent: { true },
                onReady: { _ in oldReadyCalls += 1 })
        }
        for await _ in started {
            break
        }
        #expect(oldPreparationEntered)
        application.cancel()

        let replacement = GatewaySetupApplication.Request(
            link: GatewayConnectDeepLink(
                host: "gateway-c.example.com",
                port: 443,
                tls: true,
                bootstrapToken: "fixture-bootstrap-c",
                token: nil,
                password: nil),
            source: .setupLink)
        var replacementReadyCalls = 0
        await application.apply(
            replacement,
            prepare: { _ in nil },
            save: { _ in false },
            isCurrent: { true },
            onReady: { _ in replacementReadyCalls += 1 })

        signalResume.yield()
        signalResume.finish()
        await oldAttempt.value

        #expect(oldSaveCalls == 0)
        #expect(oldReadyCalls == 0)
        #expect(replacementReadyCalls == 0)
        #expect(application.failure == GatewaySetupApplication.Failure.credentialSave)
        #expect(application.pendingRequest?.link == replacement.link)
        #expect(!application.isApplying)
    }

    @Test func `caller invalidated during preparation cannot save or invoke onReady`() async {
        let application = GatewaySetupApplication()
        let (started, signalStarted) = AsyncStream<Void>.makeStream()
        let (resume, signalResume) = AsyncStream<Void>.makeStream()
        defer {
            signalStarted.finish()
            signalResume.finish()
        }
        var callerIsCurrent = true
        var preparationEntered = false
        var saveCalls = 0
        var readyCalls = 0
        let attempt = Task { @MainActor in
            defer { signalStarted.finish() }
            await application.apply(
                Self.request(),
                prepare: { _ in
                    preparationEntered = true
                    signalStarted.yield()
                    for await _ in resume {
                        break
                    }
                    return nil
                },
                save: { _ in
                    saveCalls += 1
                    return true
                },
                isCurrent: { callerIsCurrent },
                onReady: { _ in readyCalls += 1 })
        }
        for await _ in started {
            break
        }
        #expect(preparationEntered)
        // The view's attempt ID can become stale independently of application.cancel().
        callerIsCurrent = false
        signalResume.yield()
        signalResume.finish()
        await attempt.value

        #expect(saveCalls == 0)
        #expect(readyCalls == 0)
        #expect(application.failure == nil)
        #expect(!application.isApplying)
    }
}
