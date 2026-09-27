#if os(iOS)
import Foundation
import UIKit

/// Temporary, opt-in typing evidence. Only fixed tags and numeric or Boolean facts leave the editor.
@MainActor
public enum ChatTypingProbe {
    public static let enabled: Bool = {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--openclaw-typing-probe")
        #else
        false
        #endif
    }()

    private static var sequence = 0
    private static var nextEditorID = 0

    public struct OwnerChanges {
        let ownerChanged: Bool
        let authorityChanged: Bool
        let sessionChanged: Bool
        let agentChanged: Bool
        let contractChanged: Bool

        public init(
            ownerChanged: Bool,
            authorityChanged: Bool,
            sessionChanged: Bool,
            agentChanged: Bool,
            contractChanged: Bool)
        {
            self.ownerChanged = ownerChanged
            self.authorityChanged = authorityChanged
            self.sessionChanged = sessionChanged
            self.agentChanged = agentChanged
            self.contractChanged = contractChanged
        }
    }

    public static func readiness(
        pickerRequest: Bool,
        pendingHandoff: Bool,
        ownerMismatch: Bool,
        gatewayConnected: Bool,
        canQueueOffline: Bool,
        log: (String) -> Void)
    {
        guard self.enabled, self.sequence < 4096 else { return }
        let facts: [String: Any] = [
            "pickerRequest": pickerRequest,
            "pendingHandoff": pendingHandoff,
            "ownerMismatch": ownerMismatch,
            "gatewayConnected": gatewayConnected,
            "canQueueOffline": canQueueOffline,
        ]
        self.write("composer-readiness", facts: facts, log: log)
    }

    public static func ownerSync(
        changes: OwnerChanges,
        storedAuthAllowedBefore: Bool?,
        storedAuthAllowedAfter: Bool?,
        presentationPreserved: Bool? = nil,
        log: (String) -> Void)
    {
        guard self.enabled, self.sequence < 4096 else { return }
        var facts: [String: Any] = [
            "ownerChanged": changes.ownerChanged,
            "authorityChanged": changes.authorityChanged,
            "sessionChanged": changes.sessionChanged,
            "agentChanged": changes.agentChanged,
            "contractChanged": changes.contractChanged,
        ]
        if let storedAuthAllowedBefore { facts["storedAuthAllowedBefore"] = storedAuthAllowedBefore }
        if let storedAuthAllowedAfter { facts["storedAuthAllowedAfter"] = storedAuthAllowedAfter }
        if let presentationPreserved { facts["presentationPreserved"] = presentationPreserved }
        self.write(presentationPreserved == nil ? "owner-sync" : "owner-replaced", facts: facts, log: log)
    }

    static func editorID() -> Int {
        guard self.enabled else { return 0 }
        self.nextEditorID += 1
        return self.nextEditorID
    }

    static func emit(
        _ event: String,
        editor: ChatComposerUITextView,
        result: Bool? = nil,
        keyboardHeight: Double? = nil)
    {
        guard self.enabled, self.sequence < 4096, let log = editor.typingProbeLog else { return }
        var fields: [String: Any] = [
            "editorId": editor.typingProbeID,
            "attached": editor.window != nil,
            "firstResponder": editor.isFirstResponder,
            "editable": editor.isEditable,
            "selectable": editor.isSelectable,
            "enabled": editor.typingProbeDesiredEnabled,
            "environmentEnabled": editor.typingProbeEnvironmentEnabled,
            "textLength": min(editor.text.utf16.count, 1_000_000),
            "modelLength": min(editor.typingProbeModelLength, 1_000_000),
            "selectionLength": min(editor.selectedRange.length, 1_000_000),
        ]
        if let result { fields["result"] = result }
        if let keyboardHeight, keyboardHeight.isFinite {
            fields["keyboardHeight"] = min(10000, max(0, keyboardHeight))
        }
        self.write(event, facts: fields, log: log)
    }

    private static func write(_ event: String, facts: [String: Any], log: (String) -> Void) {
        guard self.enabled, self.sequence < 4096 else { return }
        self.sequence += 1
        var fields = facts
        fields["source"] = "app"
        fields["event"] = event
        fields["sequence"] = self.sequence
        fields["uptimeMs"] = ProcessInfo.processInfo.systemUptime * 1000
        fields["process"] = ProcessInfo.processInfo.processIdentifier
        guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8)
        else { return }
        log("IOS_TYPING_PROBE \(json)")
    }
}
#endif
