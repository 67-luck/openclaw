/** Registered tool -> ordinary confirmation -> Gateway/registry -> native node dispatcher. */
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { wrapToolWithBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createNodesTool } from "../../agents/tools/nodes-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveExecApprovals } from "../../infra/exec-approvals.js";
import { prepareLinuxInstalledApp } from "../../infra/installed-apps-linux.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  authorizeObservedClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
} from "../../talk/client-voice-confirmation.js";
import {
  resetClientVoiceConfirmationStateForTest,
  snapshotClientVoiceConfirmationStateForTest,
} from "../../talk/client-voice-confirmation.test-support.js";
import {
  appendClientVoiceTranscript,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { NodeRegistry } from "../node-registry.js";
import { resetNodeWakeStateForTest } from "../node-wake-state.test-support.js";
import { nodeInvokeHandlers } from "../server-methods/nodes.invoke.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { createInstalledAppLoopbackTransport } from "./installed-app-loopback.test-support.js";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only RPC transport and pairing persistence are synthetic; dispatch/policy/native spawn are real.
vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: mocks.rpc,
  readGatewayCallOptions: () => ({}),
  shouldUseInProcessGatewayTool: () => true,
}));
vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: async () => ({ nodeId: "paired-node", key: "generation" }),
  isNodePairingGenerationCurrent: async () => true,
}));
afterEach(() => {
  clientVoiceSessionTesting.reset();
  resetClientVoiceConfirmationStateForTest();
  resetNodeWakeStateForTest();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe.runIf(process.platform === "linux")("ordinary installed-app launch", () => {
  it.each([
    "yes",
    "no",
    "node-denied",
    "exec-denied",
    "caller-closed",
    "eligibility-changed",
    "os-error",
  ] as const)("preserves final outcome and independent gates: %s", async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setActivePluginRegistry(createEmptyPluginRegistry());
      const data = state.path("app-data");
      fs.mkdirSync(path.join(data, "applications"), { recursive: true });
      const executable = state.path("long-lived-native");
      // A task-owned native executable with no arguments; stdout is ignored and cleanup is joined.
      fs.copyFileSync("/usr/bin/yes", executable);
      fs.chmodSync(executable, 0o755);
      if (mode === "os-error") {
        const bytes = fs.readFileSync(executable);
        const loader = bytes.indexOf(Buffer.from("ld-linux"));
        expect(loader).toBeGreaterThan(0);
        bytes.write("xx-linux", loader, "ascii");
        fs.writeFileSync(executable, bytes);
      }
      const entry = path.join(data, "applications", "fixture.desktop");
      fs.writeFileSync(
        entry,
        "[Desktop Entry]\nType=Application\nName=Native fixture\nExec=" + executable + "\n",
      );
      vi.stubEnv("XDG_DATA_HOME", mode === "yes" ? state.path("empty-user-data") : data);
      vi.stubEnv("XDG_DATA_DIRS", data);
      const app = prepareLinuxInstalledApp("linux-desktop:fixture.desktop")!.app;
      const config: OpenClawConfig = {
        gateway: {
          nodes: {
            commands: {
              allow: ["device.apps.launch"],
              ...(mode === "node-denied" ? { deny: ["device.apps.launch"] } : {}),
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config, config);
      saveExecApprovals({
        version: 1,
        agents: {
          main: {
            security: mode === "exec-denied" ? "deny" : "allowlist",
            ask: "off",
            allowlist: [{ pattern: executable }],
          },
        },
      });
      const registry = new NodeRegistry({
        getConfig: () => config,
        resolveCurrentPairingState: async () => ({ identity: "pairing", generation: "generation" }),
        isPairingStateCurrent: () => true,
      });
      let callerActive = true;
      const { node, nativeCommands, permits, drain } = createInstalledAppLoopbackTransport(
        registry,
        {
          beforeProgress: () => {
            expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(1);
            if (mode === "caller-closed") {
              callerActive = false;
            }
            if (mode === "eligibility-changed") {
              fs.appendFileSync(entry, "Hidden=true\n");
            }
          },
        },
      );
      registry.register(node, {
        pairingIdentity: "pairing",
        pairingGeneration: "generation",
        approvedSurface: { caps: ["device"], commands: ["device.apps", "device.apps.launch"] },
      });
      const context = {
        nodeRegistry: registry,
        getRuntimeConfig: () => config,
        logGateway: { info: vi.fn(), warn: vi.fn() },
      } as unknown as GatewayRequestHandlerOptions["context"];
      mocks.rpc.mockImplementation(
        async (method: string, _options: unknown, params: Record<string, unknown>) => {
          if (method === "node.list") {
            return {
              nodes: registry
                .listConnected()
                .map((n) => ({ nodeId: n.nodeId, commands: n.commands, connected: true })),
            };
          }
          if (method !== "node.invoke") {
            throw new Error("unexpected RPC " + method);
          }
          return await new Promise((resolve, reject) => {
            void Promise.resolve(
              nodeInvokeHandlers["node.invoke"]!({
                req: { type: "req", id: "app-rpc", method },
                params,
                context,
                client: null,
                isWebchatConnect: () => false,
                respond: (ok, payload, error) =>
                  ok ? resolve(payload) : reject(new Error(error?.message ?? "node denied")),
              }),
            ).catch(reject);
          });
        },
      );
      const sessionKey = "agent:main:registered-app";
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "app-session", updatedAt: Date.now() },
      );
      const voiceSessionId = createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
        transcriptCapable: true,
      });
      const admission = prepareSystemAgentRunAdmission(config, "app-run", "main", "app-test");
      const spawn = vi.spyOn(childProcess, "spawn");
      syncBuiltinESMExports();
      const appSpawns = () =>
        spawn.mock.calls.flatMap(([file], index) =>
          file === executable
            ? [spawn.mock.results[index]!.value as childProcess.ChildProcess]
            : [],
        );
      try {
        const admitted = await admission.admit("embedded");
        registerClientVoiceConsultRun({
          agentId: "main",
          sessionKey,
          voiceSessionId,
          runId: "app-run",
        });
        const tool = wrapToolWithBeforeToolCallHook(
          createNodesTool({ agentId: "main", agentSessionKey: sessionKey, config }),
          { agentId: "main", sessionKey, runId: "app-run" },
        );
        await withGatewayToolCallerIdentity(
          createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: "main",
            sessionKey,
            receiptAuthority: () => callerActive,
          }),
          async () => {
            const listing = await tool.execute("inventory", {
              action: "app_list",
              node: "paired-node",
              query: "Native fixture",
            });
            expect(listing.details).toMatchObject({
              payload: { inventoryComplete: true, apps: [app] },
            });
            const launchParams = {
              action: "app_launch",
              node: "paired-node",
              appId: app.appId,
              appRevision: app.appRevision,
            };
            const initial = await tool
              .execute("needs-confirmation", { ...launchParams })
              .catch((error: unknown) => String(error));
            expect(JSON.stringify(initial)).toContain("VOICE_CONFIRMATION_REQUIRED");
            expect(appSpawns()).toHaveLength(0);
            expect(nativeCommands).toEqual(["device.apps"]);
            // Real transcript persistence arms the ordinary grant; no synthetic receipt or model inference.
            const now = Date.now();
            vi.spyOn(Date, "now").mockReturnValue(now + 1);
            await appendClientVoiceTranscript({
              agentId: "main",
              sessionKey,
              voiceSessionId,
              sessionTarget: { sessionKey, storePath },
              role: "user",
              entryId: "affirmation",
              text: mode === "no" ? "no" : "yes",
            });
            const grant = authorizeObservedClientVoiceConfirmation({
              agentId: "main",
              voiceSessionId,
            });
            if (mode === "no") {
              expect(grant).toBeUndefined();
            } else {
              expect(grant).toBeDefined();
              expect(
                bindAuthorizedClientVoiceConfirmation({ grant: grant!, runId: "app-run" }),
              ).toBe(true);
            }
            const result = await tool.execute("launch", { ...launchParams }).then(
              (value) => ({ value, error: undefined }),
              (error: unknown) => ({ value: undefined, error: String(error) }),
            );
            if (mode === "yes") {
              expect(result.error).toBeUndefined();
              const child = appSpawns()[0]!;
              expect(result.value?.details).toMatchObject({
                payload: {
                  status: "process-started",
                  appId: app.appId,
                  appRevision: app.appRevision,
                  pid: child.pid,
                },
              });
              expect(appSpawns()).toHaveLength(1);
              expect(child.exitCode).toBeNull();
              expect(child.signalCode).toBeNull();
              expect(() => process.kill(child.pid!, 0)).not.toThrow();
              expect(permits).toEqual([{ type: "installed-app-launch.allow", validForMs: 5000 }]);
              const replay = await tool
                .execute("replay", { ...launchParams })
                .catch((error: unknown) => String(error));
              expect(JSON.stringify(replay)).toContain("VOICE_CONFIRMATION_REQUIRED");
              expect(appSpawns()).toHaveLength(1);
            } else {
              const reasons = {
                no: /VOICE_CONFIRMATION_REQUIRED/,
                "node-denied": /not advertise|not allow|denied/,
                "exec-denied": /security=deny/,
                "caller-closed": /authority.*active/,
                "eligibility-changed": /INSTALLED_APP_CHANGED/,
                "os-error": /ENOENT/,
              };
              expect(result.error ?? JSON.stringify(result.value)).toMatch(reasons[mode]);
              expect(appSpawns()).toHaveLength(mode === "os-error" ? 1 : 0);
            }
          },
        );
      } finally {
        for (const child of appSpawns()) {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
            expect(() => process.kill(child.pid!, 0)).toThrow();
          }
        }
        admission.close();
        registry.unregister("node-connection");
        await drain();
      }
    });
  });
});
