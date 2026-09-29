import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createModelGenerationFixture } from "../embedded-agent-runner/model.generation-scope.test-support.js";
import type { runCliTurnCompactionLifecycle } from "./cli-compaction.js";

export function createPreparedRuntimeLease(input: {
  config: OpenClawConfig;
  agentDir: string;
  agentId?: string;
  workspaceDir?: string;
}) {
  const prepared = createModelGenerationFixture({
    config: input.config,
    label: "cli",
    agentDir: input.agentDir,
    workspaceDir: expectDefined(input.workspaceDir, "compaction fixture workspace"),
  });
  return {
    snapshot: {
      ...prepared.preparedModelRuntime,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
    pluginGeneration: {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: prepared.metadataSnapshot,
      cliBackendModels: [],
      pluginRegistry: prepared.pluginRegistry,
    },
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}

export function buildContextEngine(params: {
  compactCalls: Array<Parameters<ContextEngine["compact"]>[0]>;
}): ContextEngine {
  return {
    info: {
      id: "legacy",
      name: "Legacy Context Engine",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(assembleParams) {
      return { messages: assembleParams.messages, estimatedTokens: 0 };
    },
    async compact(compactParams) {
      params.compactCalls.push(compactParams);
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensBefore: compactParams.currentTokenCount ?? 0,
          tokensAfter: 100,
        },
      };
    },
  };
}

export const systemCompactionHost = {
  sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined },
} satisfies Parameters<typeof runCliTurnCompactionLifecycle>[1];

export async function writeSessionFile(params: { sessionFile: string; sessionId: string }) {
  // The lifecycle compacts canonical OpenClaw session JSONL, so tests write the
  // same session/message envelope the real store appends.
  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  await fs.writeFile(
    params.sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: path.dirname(params.sessionFile),
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "old ask", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          timestamp: 2,
        },
      }),
      "",
    ].join("\n"),
    "utf-8",
  );
}
