#if os(iOS)
import Foundation

/// Investigation-only, explicitly enabled facts. No messages, routes, or credentials are recorded.
@MainActor
public enum ChatComposerProbe {
    public static let enabled: Bool = {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--openclaw-composer-probe")
        #else
        false
        #endif
    }()

    private static var sequence = 0
    private static var nextEditor = 0
    private static let output: FileHandle? = {
        guard enabled,
              let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        else { return nil }
        let file = root
            .appendingPathComponent("openclaw-composer-probe-\(ProcessInfo.processInfo.processIdentifier).jsonl")
        guard FileManager.default.createFile(atPath: file.path, contents: nil) else { return nil }
        return try? FileHandle(forWritingTo: file)
    }()

    static func editorID() -> Int {
        guard self.enabled else { return 0 }
        self.nextEditor += 1
        return self.nextEditor
    }

    static func record(_ event: String, fields: [String: Any]) {
        guard self.enabled, self.sequence < 4096, let output else { return }
        self.sequence += 1
        var record = fields
        record["event"] = event
        record["sequence"] = self.sequence
        record["process"] = ProcessInfo.processInfo.processIdentifier
        record["uptimeMs"] = ProcessInfo.processInfo.systemUptime * 1000
        guard var data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        data.append(10)
        try? output.write(contentsOf: data)
    }

    public static func readiness(
        picker: Bool,
        handoff: Bool,
        ownerMismatch: Bool,
        connected: Bool,
        offline: Bool,
        attachment: Bool)
    {
        self.record("readiness", fields: [
            "picker": picker, "handoff": handoff, "ownerMismatch": ownerMismatch,
            "connected": connected, "offline": offline, "attachment": attachment,
        ])
    }
}
#endif
