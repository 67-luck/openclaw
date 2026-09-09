import Foundation
import OpenClawKit
import OpenClawProtocol

struct WatchDirectRoute: Equatable, Sendable {
    let gatewayID: String
    let setupSentAtMs: Int64?
    let agentID: String
    let sessionKey: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        GatewayStableIdentifier.matches(lhs.gatewayID, rhs.gatewayID)
            && lhs.setupSentAtMs == rhs.setupSentAtMs
            && lhs.agentID.utf8.elementsEqual(rhs.agentID.utf8)
            && lhs.sessionKey.utf8.elementsEqual(rhs.sessionKey.utf8)
    }
}

struct WatchDirectSession: Decodable, Identifiable, Sendable {
    let key: String
    let displayName: String?
    let derivedTitle: String?
    let label: String?
    var id: WatchOpaqueUTF8Key {
        WatchOpaqueUTF8Key(self.key)
    }

    var title: String {
        self.displayName ?? self.derivedTitle ?? self.label ?? self.key
    }
}

struct WatchDirectSessionList: Decodable, Sendable {
    let sessions: [WatchDirectSession]
}

struct WatchDirectHistory: Decodable, Sendable {
    let messages: [OpenClawProtocol.AnyCodable]
    let hasMore: Bool?
    let truncated: Bool?
}

struct WatchDirectMessage: Identifiable, Sendable {
    let id: WatchOpaqueUTF8Key
    let role: String
    let text: String

    init?(_ value: OpenClawProtocol.AnyCodable, fallbackID: String) {
        guard let object = value.dictionaryValue, let role = object["role"]?.stringValue else { return nil }
        let content = object["content"]
        let text = content?.stringValue ?? content?.arrayValue?.compactMap { part in
            guard part.dictionaryValue?["type"]?.stringValue == "text" else { return nil }
            return part.dictionaryValue?["text"]?.stringValue
        }.joined(separator: "\n") ?? ""
        guard !text.isEmpty else { return nil }
        let metadata = object["__openclaw"]?.dictionaryValue
        self.id = WatchOpaqueUTF8Key(metadata?["id"]?.stringValue ?? object["id"]?.stringValue ?? fallbackID)
        self.role = role
        self.text = String(text.prefix(20000))
    }
}

struct WatchDirectSubscription: Decodable, Sendable {
    let subscribed: Bool
    let key: String
    let approvalReplay: SessionApprovalReplay?
}

struct WatchDirectApproval: Identifiable, Sendable {
    var snapshot: ApprovalSnapshot
    var needsReadback = false
    var resolving = false

    var id: WatchOpaqueUTF8Key {
        WatchOpaqueUTF8Key(self.rawID)
    }

    var rawID: String {
        switch self.snapshot {
        case let .pending(value): value.id
        case let .allowed(value): value.id
        case let .denied(value): value.id
        case let .expired(value): value.id
        case let .cancelled(value): value.id
        }
    }

    var presentation: ApprovalPresentation {
        switch self.snapshot {
        case let .pending(value): value.presentation
        case let .allowed(value): value.presentation
        case let .denied(value): value.presentation
        case let .expired(value): value.presentation
        case let .cancelled(value): value.presentation
        }
    }

    var kind: ApprovalKind {
        switch self.presentation {
        case .exec: .exec
        case .plugin: .plugin
        case .systemAgent: .systemAgent
        }
    }

    var title: String {
        switch self.presentation {
        case .exec: String(localized: "Command execution")
        case let .plugin(value): value.title
        case let .systemAgent(value): value.title
        }
    }

    var detail: String {
        switch self.presentation {
        case let .exec(value):
            [value.commandtext, value.warningtext?.stringValue].compactMap(\.self).joined(separator: "\n")
        case let .plugin(value):
            [value.description, value.detail].compactMap(\.self).joined(separator: "\n")
        case let .systemAgent(value): value.description
        }
    }

    var decisions: [ApprovalDecision] {
        guard case let .pending(pending) = self.snapshot,
              pending.expiresatms > Int(Date().timeIntervalSince1970 * 1000),
              !self.needsReadback, !self.resolving
        else { return [] }
        switch self.presentation {
        case let .exec(value): return value.alloweddecisions
        case let .plugin(value): return value.alloweddecisions
        case let .systemAgent(value):
            return value.alloweddecisions.compactMap { $0.stringValue.flatMap(ApprovalDecision.init(rawValue:)) }
        }
    }

    var status: String {
        if self.needsReadback { return String(localized: "Checking current decision...") }
        if self.resolving { return String(localized: "Sending decision...") }
        switch self.snapshot {
        case .pending: return String(localized: "Pending")
        case .allowed: return String(localized: "Allowed")
        case .denied: return String(localized: "Denied")
        case .expired: return String(localized: "Expired")
        case .cancelled: return String(localized: "Cancelled")
        }
    }
}
