import type { PluginCompatRecord } from "./types.js";

export const MEMORY_SESSION_READER_COMPAT_RECORDS = [
  {
    code: "memory-session-sync-inventory",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-09",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await loadArchivedSessionsAsync and resolveMemorySessionTargetsAsync from memory-core-host-engine-sessions. Synchronous readers retain their existing signatures and results until the next Plugin SDK major.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-inventory-readers",
    surfaces: ["loadArchivedSessions", "resolveMemorySessionTargets"],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/memory-core-host-engine-sessions.test.ts",
      "src/plugins/compat/registry.test.ts",
      "extensions/memory-core/src/memory-forget.participants.test.ts",
    ],
    releaseNote:
      "Memory archive discovery and forget target selection can be awaited through worker-backed SDK readers; synchronous readers remain compatible until the next Plugin SDK major.",
  },
  {
    code: "memory-session-discovery-sync-readers",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-08",
    deprecated: "2026-10-06",
    warningStarts: "2026-10-06",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await loadMemorySessionMetadataAsync from memory-core-host-engine-sessions and loadCombinedSessionStoreForGatewayAsync from session-transcript-hit. Synchronous readers retain their v2026.9.8 signatures and results until the next Plugin SDK major.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-inventory-readers",
    surfaces: ["loadMemorySessionMetadata", "loadCombinedSessionStoreForGateway"],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/memory-core-host-engine-sessions.test.ts",
      "src/plugin-sdk/session-transcript-hit.test.ts",
      "src/plugin-sdk/session-transcript-hit.projection.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Memory ingestion metadata and session search discovery use awaited session readers; released synchronous SDK readers remain compatible until the next Plugin SDK major.",
  },
] as const satisfies readonly PluginCompatRecord[];
