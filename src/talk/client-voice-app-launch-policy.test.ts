import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import { InstalledAppLaunchToolParamsSchema } from "../infra/installed-app-launch.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveClientVoiceAppLaunchPolicy } from "./client-voice-app-launch-policy.js";

const policy: Parameters<typeof resolveClientVoiceAppLaunchPolicy>[0]["policies"][number] = {
  id: "calculator",
  agentId: "main",
  originatingDeviceId: "voice-widget",
  nodeId: "desktop-node",
  appId: "linux-desktop:org.example.Calculator.desktop",
  appRevision: "a".repeat(64),
  expiresAtMs: 2000,
};
const request = () => ({
  agentId: "main",
  nodeId: "desktop-node",
  nowMs: 1000,
  origin: { deviceId: "voice-widget", isCurrent: () => true, release: () => {} },
  action: { appId: policy.appId, appRevision: policy.appRevision },
  policies: [policy],
});

describe("Talk installed-app confirmation scope", () => {
  it.each(["absent", "empty", "configured"] as const)(
    "loads %s policy config without dropping authored policies or rewriting input",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          talk: {
            realtime: {
              provider: "openai",
              mode: "realtime",
              ...(mode === "absent" ? {} : { appLaunchPolicies: mode === "empty" ? [] : [policy] }),
            },
          },
        });
        const before = await fs.readFile(state.configPath, "utf8");
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        const policies = snapshot.config.talk?.realtime?.appLaunchPolicies;
        expect(policies).toEqual(mode === "absent" ? undefined : mode === "empty" ? [] : [policy]);
        expect(
          resolveClientVoiceAppLaunchPolicy({ ...request(), policies: policies ?? [] }),
        ).toEqual(mode === "configured" ? policy : undefined);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
      });
    },
  );
  it("allows repeated exact matching without consuming configuration", () => {
    expect(resolveClientVoiceAppLaunchPolicy(request())).toEqual(policy);
    expect(resolveClientVoiceAppLaunchPolicy(request())).toEqual(policy);
  });
  it.each(["agentId", "originatingDeviceId", "nodeId", "appId", "appRevision"] as const)(
    "keeps %s exact",
    (key) => {
      expect(
        resolveClientVoiceAppLaunchPolicy({
          ...request(),
          policies: [{ ...policy, [key]: "other" }],
        }),
      ).toBeUndefined();
    },
  );
  it("does not confuse the originating widget and target node", () => {
    expect(
      resolveClientVoiceAppLaunchPolicy({
        ...request(),
        origin: { ...request().origin, deviceId: policy.nodeId },
      }),
    ).toBeUndefined();
  });
  it("checks current policy removal, expiry, and live origin after waits", async () => {
    let active = true;
    const origin = { ...request().origin, isCurrent: () => active };
    expect(resolveClientVoiceAppLaunchPolicy({ ...request(), origin })).toEqual(policy);
    await Promise.resolve();
    active = false;
    expect(resolveClientVoiceAppLaunchPolicy({ ...request(), origin })).toBeUndefined();
    expect(resolveClientVoiceAppLaunchPolicy({ ...request(), policies: [] })).toBeUndefined();
    expect(resolveClientVoiceAppLaunchPolicy({ ...request(), nowMs: 2000 })).toBeUndefined();
    expect(resolveClientVoiceAppLaunchPolicy({ ...request(), origin: undefined })).toBeUndefined();
  });
  it("keeps configured overlapping grants explicit rather than rejecting legitimate alternatives", () => {
    const later = { ...policy, id: "later", expiresAtMs: 3000 };
    expect(
      resolveClientVoiceAppLaunchPolicy({ ...request(), nowMs: 2000, policies: [policy, later] }),
    ).toEqual(later);
  });
  it("validates inventory at the canonical configuration boundary", () => {
    const parse = (policies: unknown) =>
      OpenClawSchema.safeParse({ talk: { realtime: { appLaunchPolicies: policies } } });
    expect(parse([policy]).success).toBe(true);
    expect(parse([{ ...policy, command: "calculator" }]).success).toBe(false);
    expect(parse([{ ...policy, expiresAtMs: 0 }]).success).toBe(false);
    expect(parse([{ ...policy, appId: "Calculator" }]).success).toBe(false);
    expect(parse([policy, policy]).success).toBe(false);
  });
  it.each(["command", "argv", "env", "cwd", "url", "gatewayUrl", "gatewayToken", "environmentId"])(
    "rejects model-supplied %s at the tool boundary",
    (key) => {
      expect(
        InstalledAppLaunchToolParamsSchema.safeParse({
          action: "app_launch",
          node: policy.nodeId,
          ...request().action,
          [key]: "extra",
        }).success,
      ).toBe(false);
    },
  );
});
