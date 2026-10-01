import path from "node:path";
import { fileURLToPath } from "node:url";

// Literal source URLs keep executable children in the static dependency graph.
// Runtime launchers and the package build still share the same stable locations.
function runtimeProcessEntrypoint(sourceUrl: URL) {
  const sourceWorkerName = path
    .relative(path.dirname(fileURLToPath(import.meta.url)), fileURLToPath(sourceUrl))
    .replaceAll(path.sep, "/")
    .slice(0, -".ts".length);
  return {
    currentModuleUrl: import.meta.url,
    sourceWorkerName,
    distWorkerPath: path.posix.normalize(`infra/${sourceWorkerName}.js`),
  } as const;
}

export const SQLITE_READONLY_CHILD_ARG = "--openclaw-sqlite-readonly-child";

export const runtimeProcessEntrypoints = {
  secretEgressProxy: runtimeProcessEntrypoint(
    new URL("../secrets/egress-proxy/proxy.worker.ts", import.meta.url),
  ),
  codeModeNode: runtimeProcessEntrypoint(
    new URL("../agents/code-mode-node.worker.ts", import.meta.url),
  ),
  cronReadOnly: runtimeProcessEntrypoint(
    new URL("../cron/store/read-only.worker.ts", import.meta.url),
  ),
  stateRead: runtimeProcessEntrypoint(
    new URL("../state/openclaw-state-read.worker.ts", import.meta.url),
  ),
  workerNativeLifecycle: runtimeProcessEntrypoint(
    new URL("./worker-native-lifecycle.worker.ts", import.meta.url),
  ),
  spawnBroker: runtimeProcessEntrypoint(
    new URL("../process/spawn-broker/worker.ts", import.meta.url),
  ),
  cronStreamMatcher: runtimeProcessEntrypoint(
    new URL("../gateway/cron-stream-matcher.worker.ts", import.meta.url),
  ),
  controlUiFile: runtimeProcessEntrypoint(
    new URL("../gateway/control-ui-file.worker.ts", import.meta.url),
  ),
  nativeHookRelayClient: runtimeProcessEntrypoint(
    new URL("../agents/harness/native-hook-relay-client.worker.ts", import.meta.url),
  ),
  computerHost: runtimeProcessEntrypoint(
    new URL("../gateway/desktop/computer.worker.ts", import.meta.url),
  ),
  imageProcessor: runtimeProcessEntrypoint(
    new URL("../media/image-processor.worker.ts", import.meta.url),
  ),
  fileToolPlanning: runtimeProcessEntrypoint(
    new URL("../agents/sessions/tools/file-tool-planning.worker.ts", import.meta.url),
  ),
  attachmentProcessor: runtimeProcessEntrypoint(
    new URL("../media/attachment-processor.worker.ts", import.meta.url),
  ),
  gitOperations: runtimeProcessEntrypoint(new URL("./git-operation.worker.ts", import.meta.url)),
  fsSafeCopy: runtimeProcessEntrypoint(new URL("./fs-safe-copy.worker.ts", import.meta.url)),
  sharedStateStore: runtimeProcessEntrypoint(
    new URL("../state/openclaw-state.worker.ts", import.meta.url),
  ),
  authProfileInlineUsage: runtimeProcessEntrypoint(
    new URL("../agents/auth-profiles/inline-usage.worker.ts", import.meta.url),
  ),
  agentDatabaseExecution: runtimeProcessEntrypoint(
    new URL("../state/openclaw-agent-execution.worker.ts", import.meta.url),
  ),
  workspaceMemory: runtimeProcessEntrypoint(
    new URL("../worker/memory-worker-entry.ts", import.meta.url),
  ),
  localAgentAvatar: runtimeProcessEntrypoint(
    new URL("../agents/identity-avatar-file.worker.ts", import.meta.url),
  ),
  identityFile: runtimeProcessEntrypoint(
    new URL("../agents/identity-file.worker.ts", import.meta.url),
  ),
  workspaceSkills: runtimeProcessEntrypoint(
    new URL("../worker/skills-worker-entry.ts", import.meta.url),
  ),
  boardStore: runtimeProcessEntrypoint(
    new URL("../boards/sqlite-board-store.worker.ts", import.meta.url),
  ),
  sessionSharingStore: runtimeProcessEntrypoint(
    new URL("../config/sessions/session-sharing-store.worker.ts", import.meta.url),
  ),
  heartbeatOutcomeStore: runtimeProcessEntrypoint(
    new URL("./heartbeat-outcome-store.worker.ts", import.meta.url),
  ),
  contextEngineTurnOutbox: runtimeProcessEntrypoint(
    new URL("../agents/harness/context-engine-turn-outbox.worker.ts", import.meta.url),
  ),
  sqliteStore: runtimeProcessEntrypoint(new URL("./sqlite-store.worker.ts", import.meta.url)),
  sqliteTransport: runtimeProcessEntrypoint(
    new URL("./sqlite-worker-transport.worker.ts", import.meta.url),
  ),
  agentSchemaInspection: runtimeProcessEntrypoint(
    new URL("../state/openclaw-agent-schema-inspection.worker.ts", import.meta.url),
  ),
  stateMigrationSnapshot: runtimeProcessEntrypoint(
    new URL("./state-migrations.snapshot.worker.ts", import.meta.url),
  ),
  githubExec: runtimeProcessEntrypoint(
    new URL("../agents/github-exec-launcher.ts", import.meta.url),
  ),
  sqliteReadOnly: runtimeProcessEntrypoint(
    new URL("./sqlite-readonly-location.worker.ts", import.meta.url),
  ),
  sqliteSnapshotStaging: runtimeProcessEntrypoint(
    new URL("./sqlite-snapshot-staging.worker.ts", import.meta.url),
  ),
  sqliteReadOnlyNativeResource: runtimeProcessEntrypoint(
    new URL("./sqlite-readonly-native-resource.ts", import.meta.url),
  ),
  sqliteSourceRevision: runtimeProcessEntrypoint(
    new URL("./sqlite-source-revision.worker.ts", import.meta.url),
  ),
  sqliteIntegrity: runtimeProcessEntrypoint(
    new URL("./sqlite-integrity.worker.ts", import.meta.url),
  ),
  sqliteCloseProbe: runtimeProcessEntrypoint(
    new URL("./bun-sqlite-close-probe.worker.ts", import.meta.url),
  ),
  preparedModelCatalog: runtimeProcessEntrypoint(
    new URL("../agents/prepared-model-catalog.worker.ts", import.meta.url),
  ),
  providerPromptState: runtimeProcessEntrypoint(
    new URL("../agents/embedded-agent-runner/provider-prompt-state.worker.ts", import.meta.url),
  ),
  updateRepair: runtimeProcessEntrypoint(new URL("./update-repair.worker.ts", import.meta.url)),
  updateMigratedFinalize: runtimeProcessEntrypoint(
    new URL("./update-migrated-finalize.worker.ts", import.meta.url),
  ),
  updateCandidateState: runtimeProcessEntrypoint(
    new URL("./update-candidate-state.worker.ts", import.meta.url),
  ),
  doctorLint: runtimeProcessEntrypoint(
    new URL("../commands/doctor-lint.worker.ts", import.meta.url),
  ),
  doctor: runtimeProcessEntrypoint(new URL("../commands/doctor.worker.ts", import.meta.url)),
  databaseVerify: runtimeProcessEntrypoint(
    new URL("../state/openclaw-database-verify.worker.ts", import.meta.url),
  ),
  stateLeaseHeartbeat: runtimeProcessEntrypoint(
    new URL("../state/openclaw-state-lease-heartbeat.worker.ts", import.meta.url),
  ),
  sessionTranscriptArchive: runtimeProcessEntrypoint(
    new URL("../config/sessions/session-accessor.sqlite-archive.worker.ts", import.meta.url),
  ),
  sessionTranscript: runtimeProcessEntrypoint(
    new URL("../config/sessions/session-transcript.worker.ts", import.meta.url),
  ),
  sessionManagerMetadata: runtimeProcessEntrypoint(
    new URL("../agents/sessions/session-manager-metadata.worker.ts", import.meta.url),
  ),
  sessionManagerMessage: runtimeProcessEntrypoint(
    new URL("../agents/sessions/session-manager-message.worker.ts", import.meta.url),
  ),
  sessionTranscriptProjectionPublication: runtimeProcessEntrypoint(
    new URL(
      "../config/sessions/session-transcript-projection-publication.worker.ts",
      import.meta.url,
    ),
  ),
  sessionTranscriptReports: runtimeProcessEntrypoint(
    new URL(
      "../config/sessions/session-accessor.sqlite-transcript-reports.worker.ts",
      import.meta.url,
    ),
  ),
  sessionTranscriptReconcile: runtimeProcessEntrypoint(
    new URL("../config/sessions/session-transcript-reconcile.worker.ts", import.meta.url),
  ),
  tailscaleRouteOwner: runtimeProcessEntrypoint(
    new URL("./tailscale-route-owner.worker.ts", import.meta.url),
  ),
  serviceChildRelay: runtimeProcessEntrypoint(
    new URL("../process/supervisor/service-child-relay.ts", import.meta.url),
  ),
  terminalPty: runtimeProcessEntrypoint(
    new URL("../process/terminal-pty-worker.ts", import.meta.url),
  ),
  serviceChildGroupAnchor: runtimeProcessEntrypoint(
    new URL("../process/supervisor/service-child-group-anchor.ts", import.meta.url),
  ),
  serviceChildWindowsJobAnchor: runtimeProcessEntrypoint(
    new URL("../process/supervisor/service-child-windows-job-anchor.ts", import.meta.url),
  ),
  // Not a launcher: the daemon runtime probe requires this module inside candidate Bun
  // executables so they select the same SQLite library the Gateway will run with.
  bunSqliteLibrary: runtimeProcessEntrypoint(new URL("./bun-sqlite-library.ts", import.meta.url)),
} as const;
