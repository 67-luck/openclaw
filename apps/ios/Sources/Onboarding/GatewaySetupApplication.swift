import Foundation
import Observation
import OpenClawKit

/// Owns the preparation boundary shared by scan, paste, setup-link and retry actions.
/// UI adapters only commit fields, navigate and connect in onReady, never after apply returns.
@MainActor
@Observable
final class GatewaySetupApplication {
    enum Source: Equatable {
        case scan
        case setupCode
        case setupLink
    }

    struct Request {
        let link: GatewayConnectDeepLink
        let source: Source
    }

    struct Failure: Equatable {
        let message: String
        let allowsRetry: Bool

        static var credentialSave: Self {
            Self(
                message: String(localized: "Your connection details couldn't be saved on this iPhone. Try again."),
                allowsRetry: true)
        }
    }

    private(set) var pendingRequest: Request?
    private(set) var failure: Failure?
    private(set) var isApplying = false
    private var generation: UInt64 = 0

    func cancel() {
        self.generation &+= 1
        self.pendingRequest = nil
        self.failure = nil
        self.isApplying = false
    }

    func apply(
        _ request: Request,
        appModel: NodeAppModel,
        disconnectExistingGatewayForBootstrap: Bool = true,
        isCurrent: () -> Bool,
        onReady: (GatewayConnectionController.ManualAuthOverride.SetupAuth) async -> Void) async
    {
        let instanceId = GatewaySettingsStore.currentInstanceID()
        await self.apply(
            request,
            prepare: { auth in
                guard !instanceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return String(localized: "Could not access this iPhone's connection identity. Try again.")
                }
                guard isCurrent(), !Task.isCancelled else { return nil }
                if !disconnectExistingGatewayForBootstrap {
                    // Setup links must quiesce live sessions before replacing their offline state.
                    await appModel.resetGatewaySessionsForTargetSwitch()
                    guard isCurrent(), !Task.isCancelled else { return nil }
                }
                if auth.hasBootstrapToken {
                    guard await GatewayOnboardingReset.prepareForBootstrapPairing(
                        appModel: appModel,
                        instanceId: instanceId,
                        gatewayStableID: auth.targetStableID,
                        disconnectGateway: disconnectExistingGatewayForBootstrap)
                    else {
                        // Preserve the preparation owner's specific, credential-free failure reason.
                        return appModel.gatewayStatusText
                    }
                }
                return nil
            },
            save: { auth in
                GatewaySettingsStore.saveGatewayCredentials(
                    token: auth.token,
                    bootstrapToken: auth.bootstrapToken,
                    password: auth.password,
                    gatewayStableID: auth.targetStableID,
                    suppressStoredDeviceAuth: true,
                    instanceId: instanceId)
            },
            isCurrent: isCurrent,
            onReady: onReady)
    }

    func apply(
        _ request: Request,
        prepare: (GatewayConnectionController.ManualAuthOverride.SetupAuth) async -> String?,
        save: (GatewayConnectionController.ManualAuthOverride.SetupAuth) -> Bool,
        isCurrent: () -> Bool,
        onReady: (GatewayConnectionController.ManualAuthOverride.SetupAuth) async -> Void) async
    {
        guard !self.isApplying, isCurrent(), !Task.isCancelled else { return }
        self.generation &+= 1
        let generation = self.generation
        self.pendingRequest = request
        self.isApplying = true
        defer {
            if self.generation == generation { self.isApplying = false }
        }
        guard self.validate(request.link) else { return }
        let auth = GatewayConnectionController.ManualAuthOverride.setupAuth(from: request.link)
        let preparationFailure = await prepare(auth)
        guard self.generation == generation, isCurrent(), !Task.isCancelled else { return }
        if let preparationFailure {
            self.failure = Failure(message: preparationFailure, allowsRetry: true)
            return
        }
        // Preparation may have waited for offline storage; never persist an expired code.
        guard self.validate(request.link) else { return }
        guard save(auth) else {
            self.failure = .credentialSave
            return
        }
        self.pendingRequest = nil
        self.failure = nil
        await onReady(auth)
    }

    private func validate(_ link: GatewayConnectDeepLink) -> Bool {
        // Endpoint validity also rejects expiry; preserve the more useful recovery reason first.
        if let expiresAtMs = link.expiresAtMs,
           expiresAtMs <= Int64(Date().timeIntervalSince1970 * 1000)
        {
            self.pendingRequest = nil
            self.failure = Failure(
                message: String(localized: "This setup code has expired. Generate and scan a new code."),
                allowsRetry: false)
            return false
        }
        guard link.isValidEndpoint else {
            self.pendingRequest = nil
            self.failure = Failure(
                message: String(localized: "This setup code has an invalid gateway address. Scan a new code."),
                allowsRetry: false)
            return false
        }
        return true
    }
}
