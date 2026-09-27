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
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { NodeRegistry } from "../node-registry.js";
import { resetNodeWakeStateForTest } from "../node-wake-state.test-support.js";
import { nodeInvokeHandlers } from "../server-methods/nodes.invoke.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";
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
    "policy-repeat",
    "policy-detached-origin",
    "policy-request-ended",
    "policy-shared-token",
    "policy-run-replaced",
    "policy-mismatch-agentId",
    "policy-mismatch-originatingDeviceId",
    "policy-mismatch-nodeId",
    "policy-mismatch-appId",
    "policy-mismatch-appRevision",
    "policy-revoke",
    "policy-expire",
    "policy-device-revoke",
    "policy-host-denied",
    "policy-node-denied",
  ] as const)("preserves final outcome and independent gates: %s", async (scenario) => {
    const policyMode = scenario.startsWith("policy-") ? scenario : undefined;
    const mode =
      scenario === "no" ||
      scenario === "node-denied" ||
      scenario === "exec-denied" ||
      scenario === "caller-closed" ||
      scenario === "eligibility-changed" ||
      scenario === "os-error"
        ? scenario
        : "yes";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setActivePluginRegistry(createEmptyPluginRegistry());
      const data = state.path("app-data");
      fs.mkdirSync(path.join(data, "applications"), { recursive: true });
      const executable = state.path("yes");
      // Preserve argv[0] for multicall coreutils (uutils/busybox); a renamed applet exits immediately.
      // This task-owned native executable has no arguments; stdout is ignored and cleanup is joined.
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
              ...(mode === "node-denied" || policyMode === "policy-node-denied"
                ? { deny: ["device.apps.launch"] }
                : {}),
            },
          },
        },
      };
      const policy = {
        id: "repeat-native",
        agentId: "main",
        originatingDeviceId: "voice-client",
        nodeId: "paired-node",
        appId: app.appId,
        appRevision: app.appRevision,
        expiresAtMs: Date.now() + 60_000,
      };
      if (policyMode) {
        if (policyMode === "policy-mismatch-agentId") {
          policy.agentId = "other";
        }
        if (policyMode === "policy-mismatch-originatingDeviceId") {
          policy.originatingDeviceId = "other";
        }
        if (policyMode === "policy-mismatch-nodeId") {
          policy.nodeId = "other";
        }
        if (policyMode === "policy-mismatch-appId") {
          policy.appId = "linux-desktop:other.desktop";
        }
        if (policyMode === "policy-mismatch-appRevision") {
          policy.appRevision = "b".repeat(64);
        }
        config.talk = { realtime: { appLaunchPolicies: [policy] } };
      }
      const originContext = {};
      const originConnection = new AbortController();
      let originRequestCurrent = true;
      const ingress = captureGatewayDeviceRevocation(
        originContext,
        { deviceId: "voice-client", role: "operator" },
        () => originRequestCurrent,
        originConnection.signal,
        { isCurrent: () => true, subscribe: () => () => {} },
      );
      const origin = policyMode
        ? captureTalkVoiceOrigin({
            client: {
              ...sharingPolicyClient({ deviceId: "voice-client" }),
              isDeviceTokenAuth: policyMode !== "policy-shared-token",
            },
            hasCurrentClientAuthority: ingress.isCurrent,
          })
        : undefined;
      setRuntimeConfigSnapshot(config, config);
      saveExecApprovals({
        version: 1,
        agents: {
          main: {
            security:
              mode === "exec-denied" || policyMode === "policy-host-denied" ? "deny" : "allowlist",
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
            expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(
              policyMode ? 0 : 1,
            );
            if (policyMode === "policy-request-ended") {
              originRequestCurrent = false;
            }
            if (policyMode === "policy-detached-origin") {
              originConnection.abort();
              origin?.release();
              ingress.release();
            }
            if (policyMode === "policy-run-replaced") {
              const voiceSessionId = createOrResumeClientVoiceSession({
                agentId: "main",
                sessionKey,
                origin: "client",
                transcriptCapable: true,
              });
              registerClientVoiceConsultRun({
                agentId: "main",
                sessionKey,
                voiceSessionId,
                runId: "app-run",
                originAuthority: origin,
              });
            }
            if (policyMode === "policy-revoke") {
              config.talk = { realtime: { appLaunchPolicies: [] } };
              setRuntimeConfigSnapshot(config, config);
            }
            if (policyMode === "policy-expire") {
              vi.spyOn(Date, "now").mockReturnValue(policy.expiresAtMs);
            }
            if (policyMode === "policy-device-revoke") {
              invalidateGatewayDeviceRevocation(originContext, "voice-client", "operator");
            }
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
          originAuthority: origin,
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
            if (policyMode) {
              const launch = (id: string, params = launchParams) =>
                tool.execute(id, { ...params }).then(
                  (value) => ({ value, error: undefined }),
                  (error: unknown) => ({ value: undefined, error: String(error) }),
                );
              const result = await launch("policy-first");
              if (
                policyMode === "policy-repeat" ||
                policyMode === "policy-detached-origin" ||
                policyMode === "policy-request-ended"
              ) {
                expect(result.error).toBeUndefined();
                expect(result.value?.details).toMatchObject({
                  payload: {
                    status: "process-started",
                    appId: app.appId,
                    appRevision: app.appRevision,
                    pid: appSpawns()[0]?.pid,
                  },
                });
                expect((await launch("policy-second")).error).toBeUndefined();
                expect(appSpawns()).toHaveLength(2);
                for (const child of appSpawns()) {
                  expect(child.exitCode).toBeNull();
                  expect(() => process.kill(child.pid!, 0)).not.toThrow();
                }
                const changed = await launch("changed-scope", {
                  ...launchParams,
                  appRevision: "b".repeat(64),
                });
                expect(changed.error ?? JSON.stringify(changed.value)).toContain(
                  "VOICE_CONFIRMATION_REQUIRED",
                );
                config.talk = { realtime: { appLaunchPolicies: [] } };
                setRuntimeConfigSnapshot(config, config);
                const replay = await launch("revoked-replay");
                expect(replay.error ?? JSON.stringify(replay.value)).toContain(
                  "VOICE_CONFIRMATION_REQUIRED",
                );
                expect(appSpawns()).toHaveLength(2);
                expect(permits).toEqual([
                  { type: "installed-app-launch.allow", validForMs: 5000 },
                  { type: "installed-app-launch.allow", validForMs: 5000 },
                ]);
              } else {
                const error = result.error ?? JSON.stringify(result.value);
                if (
                  policyMode.startsWith("policy-mismatch-") ||
                  policyMode === "policy-shared-token"
                ) {
                  expect(error).toContain("VOICE_CONFIRMATION_REQUIRED");
                  expect(nativeCommands).toEqual(["device.apps"]);
                } else if (policyMode === "policy-host-denied") {
                  expect(error).toContain("security=deny");
                  expect(permits).toEqual([]);
                } else if (policyMode === "policy-node-denied") {
                  expect(error).toMatch(/not advertise|not allow|denied/);
                  expect(permits).toEqual([]);
                } else {
                  expect(error).toMatch(
                    /authorization is no longer current|VOICE_CONFIRMATION_REQUIRED|run binding changed/,
                  );
                  expect(permits).toEqual([{ type: "installed-app-launch.deny" }]);
                }
                expect(appSpawns()).toHaveLength(0);
                if (policyMode === "policy-run-replaced") {
                  invalidateGatewayDeviceRevocation(originContext, "voice-client", "operator");
                }
                const replay = await launch("policy-replay");
                expect(replay.error ?? JSON.stringify(replay.value)).not.toContain(
                  '"status":"process-started"',
                );
                expect(appSpawns()).toHaveLength(0);
              }
              expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(0);
              return;
            }
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
        origin?.release();
        ingress.release();
        admission.close();
        registry.unregister("node-connection");
        await drain();
      }
    });
  });
});
