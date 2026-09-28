import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedUserProfileIdentity } from "../state/user-profiles.types.js";
import type { AgentTurnPrincipal } from "./agent-turn/types.js";
import { resolveGatewayAuthPolicyGeneration } from "./auth-policy.js";
import { captureRestartRecoveryRequester } from "./session-restart-requester.js";

const { prepareProfile } = vi.hoisted(() => ({ prepareProfile: vi.fn() }));
vi.mock("../state/user-profile-list.js", () => ({ prepareUserProfileIdentity: prepareProfile }));

const SESSION = "agent:main:dashboard:original";
const GRANT = "grant-42";
const BINDING = "60a8365e-152e-4a36-9523-ea3cbfdd262b";

function fixture() {
  let revoked = false;
  const assertCurrent = vi.fn(() => {
    if (revoked) {
      throw new Error("original caller revoked");
    }
  });
  const release = vi.fn();
  const profile: PreparedUserProfileIdentity = {
    readCurrentProfile: () => ({ profileId: "original-person", assignedRole: null }),
    emailBindingIds: [BINDING],
    readCurrentFacts: () => ({
      profile: { profileId: "original-person", assignedRole: null, emails: [] },
      aliases: new Set<string>(),
    }),
    release,
  };
  prepareProfile.mockResolvedValue(profile);
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "original-person",
    scopes: ["operator.read", "operator.write", "operator.approvals"],
    gatewayAccessGrant: { pluginId: "access-policy", grantId: GRANT },
    restartAccessGrant: { pluginId: "access-policy", grantId: GRANT },
    restartDevice: null,
    restartBrowserOrigin: null,
    restartAuthPolicy: resolveGatewayAuthPolicyGeneration({}),
    readCurrentRoleAssignment: () => null,
    assertCurrent,
  });
  const operationalRunInstance = { instanceId: "parent-instance", runId: "parent-run" };
  const client: AgentTurnPrincipal = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "gateway-client", version: "test", platform: "node", mode: "backend" },
      role: "operator",
      scopes: ["operator.write"],
    },
    internal: {
      syntheticClient: true,
      operatorRunAuthority: authority,
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: SESSION,
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          lifecycleGeneration: "gateway-before",
          claimId: "parent-claim",
        },
      },
    },
  };
  const cfg: OpenClawConfig = {};
  const params: Parameters<typeof captureRestartRecoveryRequester>[0] = {
    client,
    inputProvenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: SESSION,
    },
    agentId: "main",
    sessionKey: SESSION,
    sessionId: "original-session",
    storePath: "/test/main/sessions.json",
    lifecycleRevision: "original-incarnation",
    runId: "accepted-self-turn",
    getConfig: () => cfg,
    assertCurrent,
  };
  return {
    params,
    client,
    authority,
    profile,
    release,
    revoke: () => {
      revoked = true;
    },
  };
}

beforeEach(() => prepareProfile.mockReset());

describe("restart requester capture", () => {
  it("retains the original operator and restricted scopes, not a System receiver", async () => {
    const f = fixture();
    await expect(captureRestartRecoveryRequester(f.params)).resolves.toMatchObject({
      version: 1,
      profileId: "original-person",
      sessionId: "original-session",
      lifecycleRevision: "original-incarnation",
      sourceRunId: "accepted-self-turn",
      scopes: ["operator.read", "operator.write"],
      grant: { pluginId: "access-policy", grantId: GRANT },
      aliasBindingIds: [BINDING],
      modelPolicyMembership: "unrestricted",
    });
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("does not accept a claimed self-source from a different runtime session", async () => {
    const f = fixture();
    f.client.internal!.agentRuntimeIdentity!.sessionKey = "agent:main:dashboard:foreign";
    await expect(captureRestartRecoveryRequester(f.params)).resolves.toBeUndefined();
    expect(prepareProfile).not.toHaveBeenCalled();
  });

  it("does not replace missing original operator authority with System", async () => {
    const f = fixture();
    delete f.client.internal!.operatorRunAuthority;
    await expect(captureRestartRecoveryRequester(f.params)).resolves.toBeUndefined();
    expect(prepareProfile).not.toHaveBeenCalled();
  });

  it("does not drop a process-local delegated tool restriction", async () => {
    const f = fixture();
    f.client.internal!.delegatedToolPolicyHandoffId = "process-local-tool-policy";
    await expect(captureRestartRecoveryRequester(f.params)).resolves.toBeUndefined();
    expect(prepareProfile).not.toHaveBeenCalled();
  });

  it.for([
    "restartAccessGrant",
    "restartDevice",
    "restartAuthPolicy",
    "restartBrowserOrigin",
  ] as const)(
    "refuses an unknown %s basis rather than treating it as independent",
    async (basis) => {
      const f = fixture();
      f.client.internal!.operatorRunAuthority = createAdmittedRunOperatorAuthority({
        ...f.authority,
        [basis]: undefined,
      });
      await expect(captureRestartRecoveryRequester(f.params)).resolves.toBeUndefined();
      expect(prepareProfile).not.toHaveBeenCalled();
    },
  );

  it("refuses an unissued operator object even when its identifiers match", async () => {
    const f = fixture();
    f.client.internal!.operatorRunAuthority = { ...f.authority };
    await expect(captureRestartRecoveryRequester(f.params)).rejects.toThrow();
    expect(prepareProfile).not.toHaveBeenCalled();
  });

  it("joins profile preparation and rejects revocation before recording a grant", async () => {
    const f = fixture();
    const prepared = createDeferred<PreparedUserProfileIdentity>();
    prepareProfile.mockReturnValue(prepared.promise);
    const pending = captureRestartRecoveryRequester(f.params);
    expect(prepareProfile).toHaveBeenCalledOnce();
    f.revoke();
    prepared.resolve(f.profile);
    await expect(pending).rejects.toThrow("original caller revoked");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("does not turn a custom model predicate into its visible model list", async () => {
    const f = fixture();
    f.client.internal!.operatorRunAuthority = createAdmittedRunOperatorAuthority({
      ...f.authority,
      modelPolicy: { models: [], allows: () => false },
    });
    await expect(captureRestartRecoveryRequester(f.params)).resolves.toBeUndefined();
    expect(prepareProfile).not.toHaveBeenCalled();
  });
});
