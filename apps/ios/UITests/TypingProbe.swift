import Foundation
import XCTest

/// Temporary safe projection: recording an issue never queries the app or publishes its descriptions.
final class IOSTypingProbe: @unchecked Sendable {
    let enabled = ProcessInfo.processInfo.environment["OPENCLAW_IOS_TYPING_PROBE"] == "1"
    private let lock = NSLock()
    private var sequence = 0
    private var stage = "setup"

    func trace(_ event: String, stage: String? = nil, result: Bool? = nil) {
        guard self.enabled else { return }
        self.lock.lock()
        defer { self.lock.unlock() }
        // Leave space for the first XCTest issue even if progress tracing reaches the bound.
        guard self.sequence < 4095 else { return }
        if let stage { self.stage = stage }
        var fields = self.envelope(event)
        if let result { fields["result"] = result }
        self.emit(fields)
    }

    func record(_ issue: XCTIssue) {
        guard self.enabled else { return }
        self.lock.lock()
        defer { self.lock.unlock() }
        guard self.sequence < 4096 else { return }
        var fields = self.envelope("issue")
        fields["issueType"] = issue.type.rawValue
        fields["category"] = Self.category(issue)
        if let location = issue.sourceCodeContext.location {
            fields["sourceLine"] = min(1_000_000, max(0, location.lineNumber))
        }
        if let error = issue.associatedError {
            fields["errorCode"] = min(1_000_000_000, max(-1_000_000_000, (error as NSError).code))
        }
        self.emit(fields)
    }

    private static func category(_ issue: XCTIssue) -> String {
        let description = String((issue.compactDescription + " " + (issue.detailedDescription ?? ""))
            .prefix(16384)).lowercased()
        if description.contains("keyboard focus") || description.contains("first responder") {
            return "keyboard-focus"
        }
        if description.contains("keyboard"), description.contains("snapshot") { return "keyboard-snapshot" }
        if description.contains("synthesiz"), description.contains("event") { return "event-synthesis" }
        if description.contains("application is not running") || description.contains("app is not running") {
            return "app-not-running"
        }
        if description.contains("crash") { return "app-crash" }
        if description.contains("accessibility") || description.contains("matching snapshot") {
            return "accessibility"
        }
        if description.contains("timed out") || description.contains("timeout") { return "timeout" }
        return "other"
    }

    private func envelope(_ event: String) -> [String: Any] {
        self.sequence += 1
        return [
            "source": "test",
            "event": event,
            "stage": self.stage,
            "sequence": self.sequence,
            "uptimeMs": ProcessInfo.processInfo.systemUptime * 1000,
            "process": ProcessInfo.processInfo.processIdentifier,
        ]
    }

    private func emit(_ fields: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8)
        else { return }
        FileHandle.standardOutput.write(Data("IOS_TYPING_PROBE \(json)\n".utf8))
    }
}
