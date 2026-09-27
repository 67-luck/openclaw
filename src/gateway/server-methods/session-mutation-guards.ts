import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import type { SessionOperatorScope } from "../../shared/session-method-scopes-base.js";
import { isGatewayAuthPolicyCurrent } from "../auth-policy.js";
import { readGatewayDeviceRevocationGuard } from "../device-revocation.js";
import {
  assertExpectedProfileSelection,
  captureExpectedProfileSelection,
  type ExpectedProfileBinding,
  type RetainedExpectedProfileSelection,
} from "../expected-profile.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "../operator-role-policy.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import {
  capturePreparedSessionInputAuthorization,
  inheritSessionInputPreparation,
  prepareSessionInputAuthorization,
  type PreparedSessionInputAuthorization,
} from "../session-sharing-input-capability.js";
import type { PreparedSessionMutationFacts } from "../session-sharing-policy.js";
import {
  assertChatSendInputLifetime,
  type RetainedChatSendInputLifetime,
} from "./chat-send-work-admission.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestOptions,
  SessionMutationAuthorization,
} from "./types.js";

type RequestMutationOptions = Pick<
  GatewayRequestHandlerOptions,
  "req" | "client" | "signal" | "hasCurrentClientAuthority" | "sessionMutationCommitGuard"
>;

type RequestMutationAuthorityBase = {
  assertCurrent: () => void;
  /** Original transport/SDK lifetime; prepared-profile methods check selection separately. */
  assertLifetimeCurrent: () => void;
  /** Host-proven child input retains its source after the spawning invocation closes. */
  assertAdmittedInputCurrent?: () => void;
  /** Original person restrictions survive independently of the invoking tool receipt. */
  assertOperatorCurrent?: () => void;
  expectedProfileBinding?: ExpectedProfileBinding;
  /** Recorded by the scope owner only when this invocation uses its narrow alternative. */
  sessionScope?: SessionOperatorScope;
};

/** Request lifetime only; method owners retain target and policy checks. */
export type GatewayRequestMutationAuthority = RequestMutationAuthorityBase &
  ({ family: "worker"; assertWorkerCurrent: () => void } | { family: "native-compatibility" });

const requestMutationAuthorityKey = Symbol("gatewayRequestMutationAuthority");

class RequestMutationAuthorityBinding {
  readonly #owner: object;
  readonly #authority: GatewayRequestMutationAuthority;

  constructor(owner: object, authority: GatewayRequestMutationAuthority) {
    this.#owner = owner;
    this.#authority = authority;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(value: unknown, owner: object): GatewayRequestMutationAuthority | undefined {
    return typeof value === "object" && value !== null && #owner in value && value.#owner === owner
      ? value.#authority
      : undefined;
  }
}

const pendingInputWorkerIssuer = Symbol("pendingInputWorkerIssuer");
const freshInputWorkerIssuer = Symbol("freshInputWorkerIssuer");

class FreshInputWorkerAuthority {
  readonly #source: GatewayRequestMutationAuthority & { family: "worker" };
  readonly #lifetime: RetainedChatSendInputLifetime;
  readonly #profile: RetainedExpectedProfileSelection;

  constructor(
    issuer: symbol,
    source: GatewayRequestMutationAuthority & { family: "worker" },
    lifetime: RetainedChatSendInputLifetime,
    profile: RetainedExpectedProfileSelection,
  ) {
    if (issuer !== freshInputWorkerIssuer) {
      throw new Error("Fresh input requires its original Gateway producer");
    }
    this.#source = source;
    this.#lifetime = lifetime;
    this.#profile = profile;
    Object.freeze(this);
  }

  static assertCurrent(value: unknown): void {
    if (typeof value !== "object" || value === null || !(#source in value)) {
      throw new Error("Fresh input has no original worker authority");
    }
    value.#source.assertOperatorCurrent?.();
    value.#source.assertWorkerCurrent();
    assertChatSendInputLifetime(value.#lifetime);
    assertExpectedProfileSelection(value.#profile);
  }
}

export type GatewayFreshInputWorkerAuthority = FreshInputWorkerAuthority;
export function captureGatewayFreshInputWorkerAuthority(
  options: GatewayRequestHandlerOptions,
  lifetime: RetainedChatSendInputLifetime,
): GatewayFreshInputWorkerAuthority | undefined {
  const source = readGatewayRequestMutationAuthority(options);
  if (source.family !== "worker" || !source.expectedProfileBinding) {
    return undefined;
  }
  return new FreshInputWorkerAuthority(
    freshInputWorkerIssuer,
    source,
    lifetime,
    captureExpectedProfileSelection(source.expectedProfileBinding),
  );
}
export function assertGatewayFreshInputWorkerAuthority(
  value: GatewayFreshInputWorkerAuthority,
): void {
  FreshInputWorkerAuthority.assertCurrent(value);
}

class PendingInputWorkerAuthority {
  readonly #source: GatewayRequestMutationAuthority & { family: "worker" };
  readonly #lifetime: RetainedChatSendInputLifetime;
  readonly #target: PreparedSessionInputAuthorization;
  readonly #options: GatewayRequestHandlerOptions;
  readonly #authorization: SessionMutationAuthorization | undefined;

  constructor(
    issuer: symbol,
    source: GatewayRequestMutationAuthority & { family: "worker" },
    lifetime: RetainedChatSendInputLifetime,
    target: PreparedSessionInputAuthorization,
    options: GatewayRequestHandlerOptions,
  ) {
    if (issuer !== pendingInputWorkerIssuer) {
      throw new Error("Pending input authority requires its original Gateway producer");
    }
    this.#source = source;
    this.#lifetime = lifetime;
    this.#target = capturePreparedSessionInputAuthorization(target);
    this.#options = options;
    this.#authorization = options.sessionMutationAuthorization;
    Object.freeze(this);
  }

  static capture(value: unknown): PendingInputWorkerAuthority {
    if (typeof value !== "object" || value === null || !(#source in value)) {
      throw new Error("Pending input requires its original worker authority");
    }
    return value;
  }

  get workerRead() {
    return this.#target.workerRead;
  }

  assertLifetimeCurrent(completion = false): void {
    if (this.#options.sessionMutationAuthorization !== this.#authorization) {
      throw new Error("Pending input lost its original session authorization");
    }
    this.#source.assertOperatorCurrent?.();
    this.#source.assertWorkerCurrent();
    assertChatSendInputLifetime(this.#lifetime, completion);
  }

  assertCurrent(facts: PreparedSessionMutationFacts, completion = false): void {
    this.assertLifetimeCurrent(completion);
    this.#target.assertCurrent(facts);
  }

  release(): void {
    this.#target.release();
  }
}

export type GatewayPendingInputWorkerAuthority = PendingInputWorkerAuthority;

export function captureGatewayPendingInputWorkerAuthority(value: unknown) {
  return PendingInputWorkerAuthority.capture(value);
}

/** The ordinary WS producer combines its exact request, work lease and resolved target owners. */
export async function prepareGatewayPendingInputWorkerAuthority(
  options: GatewayRequestHandlerOptions,
  lifetime: RetainedChatSendInputLifetime,
): Promise<GatewayPendingInputWorkerAuthority | undefined> {
  const source = readGatewayRequestMutationAuthority(options);
  if (source.family !== "worker" || source.assertAdmittedInputCurrent) {
    return undefined;
  }
  source.assertOperatorCurrent?.();
  source.assertWorkerCurrent();
  assertChatSendInputLifetime(lifetime);
  const authorization = options.sessionMutationAuthorization;
  const target = await prepareSessionInputAuthorization(authorization);
  if (!target) {
    return undefined;
  }
  try {
    source.assertOperatorCurrent?.();
    source.assertWorkerCurrent();
    assertChatSendInputLifetime(lifetime);
    if (options.sessionMutationAuthorization !== authorization) {
      throw new Error("Pending input session authorization changed during preparation");
    }
    return new PendingInputWorkerAuthority(
      pendingInputWorkerIssuer,
      source,
      lifetime,
      target,
      options,
    );
  } catch (error) {
    target.release();
    throw error;
  }
}

function bindRequestMutationAuthority(
  options: object,
  authority: GatewayRequestMutationAuthority,
): void {
  Object.defineProperty(options, requestMutationAuthorityKey, {
    value: new RequestMutationAuthorityBinding(options, authority),
    configurable: true,
  });
}

function assertRequestAuthorityCurrent(options: RequestMutationOptions): void {
  options.signal?.throwIfAborted();
  if (options.client?.invalidated || options.hasCurrentClientAuthority?.() === false) {
    throw new Error("Gateway requester authority changed");
  }
  options.sessionMutationCommitGuard?.();
}

/** Opaque SDK guards retain their synchronous commit boundary from v2026.9.4. */
export function readGatewayRequestMutationAuthority(
  options: RequestMutationOptions,
): GatewayRequestMutationAuthority {
  const binding: unknown = Object.getOwnPropertyDescriptor(
    options,
    requestMutationAuthorityKey,
  )?.value;
  const retained = RequestMutationAuthorityBinding.read(binding, options);
  if (retained) {
    return retained;
  }
  const { req, client, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } = options;
  const captured = { req, client, signal, hasCurrentClientAuthority, sessionMutationCommitGuard };
  const assertLifetimeCurrent = () => assertRequestAuthorityCurrent(captured);
  const compatibility: GatewayRequestMutationAuthority = {
    family: "native-compatibility",
    assertCurrent: assertLifetimeCurrent,
    assertLifetimeCurrent,
  };
  bindRequestMutationAuthority(options, compatibility);
  return compatibility;
}

/** Only the trusted hosted creation producer can separate its tool receipt from input custody. */
export function bindCreatedInputMutationAuthority<T extends GatewayRequestOptions>(
  options: T,
  assertSourceCurrent: (() => void) | undefined,
): T {
  if (!assertSourceCurrent) {
    return options;
  }
  const source = readGatewayRequestMutationAuthority(options);
  const { req, client, context, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } =
    options;
  bindRequestMutationAuthority(options, {
    ...source,
    assertAdmittedInputCurrent: () => {
      if (
        options.req !== req ||
        options.client !== client ||
        options.context !== context ||
        options.signal !== signal ||
        options.hasCurrentClientAuthority !== hasCurrentClientAuthority ||
        options.sessionMutationCommitGuard !== sessionMutationCommitGuard
      ) {
        throw new Error("Gateway requester authority changed");
      }
      assertRequestAuthorityCurrent({
        req,
        client,
        signal,
        hasCurrentClientAuthority,
        sessionMutationCommitGuard: assertSourceCurrent,
      });
    },
  });
  return options;
}

/** WS admission retains owner facts, never an arbitrary generation getter or socket lifetime. */
export function bindWebSocketRequestMutationAuthority<T extends GatewayRequestOptions>(
  options: T,
  client: GatewayWsClient,
  generationReader: (() => string | undefined) | undefined,
): T {
  const generationState = SharedGatewaySessionGenerationState.fromReader(generationReader);
  const hasCurrentDeviceRevocation = readGatewayDeviceRevocationGuard(
    options.hasCurrentClientAuthority,
  );
  if (
    !generationState ||
    !hasCurrentDeviceRevocation ||
    client.internal?.agentRuntimeIdentity ||
    options.sessionMutationCommitGuard
  ) {
    return options;
  }
  const { req, context, signal, hasCurrentClientAuthority } = options;
  const assertWorkerCurrent = () => {
    signal?.throwIfAborted();
    if (
      options.req !== req ||
      options.client !== client ||
      options.context !== context ||
      options.signal !== signal ||
      options.hasCurrentClientAuthority !== hasCurrentClientAuthority ||
      options.sessionMutationCommitGuard !== undefined ||
      client.invalidated ||
      !isGatewayAuthPolicyCurrent(client.authPolicyGeneration, getRuntimeConfigSnapshot()) ||
      !hasCurrentDeviceRevocation() ||
      client.internal?.agentRuntimeIdentity
    ) {
      throw new Error("Gateway requester authority changed");
    }
    const requiredGeneration = client.usesSharedGatewayAuth
      ? generationState.requiredGeneration
      : undefined;
    if (
      requiredGeneration !== undefined &&
      client.sharedGatewaySessionGeneration !== requiredGeneration
    ) {
      throw new Error("Gateway requester authority changed");
    }
  };
  bindRequestMutationAuthority(options, {
    family: "worker",
    assertLifetimeCurrent: assertWorkerCurrent,
    assertCurrent: () => {
      assertWorkerCurrent();
      assertRequestAuthorityCurrent(options);
    },
    assertWorkerCurrent,
  });
  return options;
}

/** Transfer only this exact invocation's custody after the router composes profile selection. */
export function bindGatewayRequestHandlerMutationAuthority<T extends GatewayRequestHandlerOptions>(
  request: GatewayRequestOptions,
  handler: T,
  expectedProfileBinding: ExpectedProfileBinding | undefined,
  sessionScope?: SessionOperatorScope,
): T {
  const source = readGatewayRequestMutationAuthority(request);
  const retainedProfileBinding = expectedProfileBinding ?? source.expectedProfileBinding;
  const retainedSessionScope = sessionScope ?? source.sessionScope;
  const { req, client, context, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } =
    handler;
  const assertHandlerCurrent = () => {
    if (
      handler.req !== req ||
      handler.client !== client ||
      handler.context !== context ||
      handler.signal !== signal ||
      handler.hasCurrentClientAuthority !== hasCurrentClientAuthority ||
      handler.sessionMutationCommitGuard !== sessionMutationCommitGuard
    ) {
      throw new Error("Gateway requester authority changed");
    }
  };
  const assertCurrent = () => {
    assertHandlerCurrent();
    source.assertOperatorCurrent?.();
    if (source.family === "worker") {
      source.assertWorkerCurrent();
    }
    assertRequestAuthorityCurrent(handler);
  };
  const assertLifetimeCurrent = () => {
    assertHandlerCurrent();
    // Keep the pre-router owner; the handler guard also contains native profile selection.
    source.assertLifetimeCurrent();
  };
  const authority: GatewayRequestMutationAuthority = {
    assertCurrent,
    assertLifetimeCurrent,
    expectedProfileBinding: retainedProfileBinding,
    sessionScope: retainedSessionScope,
    assertOperatorCurrent: source.assertOperatorCurrent,
    ...(source.family === "worker"
      ? {
          family: "worker" as const,
          assertWorkerCurrent: () => {
            assertHandlerCurrent();
            source.assertOperatorCurrent?.();
            source.assertWorkerCurrent();
          },
        }
      : { family: "native-compatibility" as const }),
  };
  if (source.assertAdmittedInputCurrent) {
    const assertAdmittedInputCurrent = source.assertAdmittedInputCurrent;
    const assertTransferredHandlerCurrent = () => {
      assertHandlerCurrent();
      source.assertOperatorCurrent?.();
      // An adapter may add an opaque host guard. Only the unchanged producer
      // guard has the known tool-receipt/source split; retain any new guard in full.
      if (sessionMutationCommitGuard !== request.sessionMutationCommitGuard) {
        assertRequestAuthorityCurrent(handler);
      }
    };
    authority.assertAdmittedInputCurrent = () => {
      assertTransferredHandlerCurrent();
      assertAdmittedInputCurrent();
    };
    const authorization = handler.sessionMutationAuthorization;
    if (authorization) {
      handler.sessionMutationAuthorization = inheritSessionInputPreparation(authorization, {
        ...authorization,
        assertAdmittedInputCurrent: () => {
          assertTransferredHandlerCurrent();
          (authorization.assertAdmittedInputCurrent ?? authorization.assertCurrent)();
        },
      });
    }
  }
  bindRequestMutationAuthority(handler, authority);
  return handler;
}

/** Retain the person's ceiling independently of the request's receipt lifetime. */
export function captureGatewayRequestOperatorGuard(options: GatewayRequestOptions): () => void {
  const { client, context } = options;
  const source = readGatewayRequestMutationAuthority(options);
  const actor = resolveGatewayOperatorRoleActor(client);
  const role = client?.connect?.role ?? "operator";
  const scopes = [...(client?.connect?.scopes ?? [])];
  const profileId = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const canonicalProfileId = client?.preparedSessionProfile?.profileId;
  const assertCurrent = () => {
    source.assertOperatorCurrent?.();
    const currentActor = resolveGatewayOperatorRoleActor(client);
    if (
      (client?.connect?.role ?? "operator") !== role ||
      scopes.some((scope) => !operatorScopeSatisfied(scope, client?.connect?.scopes ?? [])) ||
      client?.authenticatedUserProfile?.profileId !== profileId ||
      client?.authenticatedUserId !== userId ||
      (canonicalProfileId !== undefined &&
        client?.preparedSessionProfile?.profileId !== canonicalProfileId) ||
      currentActor?.kind !== actor?.kind ||
      (actor?.kind === "operator" &&
        (currentActor?.kind !== "operator" || currentActor.profileId !== actor.profileId))
    ) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(ErrorCodes.FORBIDDEN, "Gateway requester authority changed"),
      );
    }
    if (actor?.kind === "operator") {
      const error = authorizeCurrentOperatorRoleScopes(
        client,
        (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)(),
      );
      if (error) {
        throw new SessionMutationAuthorizationChangedError(error);
      }
    }
  };
  bindRequestMutationAuthority(options, { ...source, assertOperatorCurrent: assertCurrent });
  return assertCurrent;
}

/** Keep the host lifetime and operator target policy on the same commit boundary. */
export function withSessionMutationCommitGuard(
  authorization: SessionMutationAuthorization | undefined,
  assertCommitAllowed: (() => void) | undefined,
  assertExpectedProfile: (() => void) | undefined,
  assertAdmittedSourceCurrent?: () => void,
): SessionMutationAuthorization | undefined {
  if (!assertCommitAllowed && !assertExpectedProfile) {
    return authorization;
  }
  // Committed input keeps its original host and session authority. A later
  // account selection change cannot revoke custody already transferred to it.
  const assertAdmittedInputCurrent = () => {
    (assertAdmittedSourceCurrent ?? assertCommitAllowed)?.();
    authorization?.assertCurrent();
  };
  return inheritSessionInputPreparation(authorization, {
    ...authorization,
    assertAdmittedInputCurrent,
    assertCurrent: () => {
      assertExpectedProfile?.();
      assertCommitAllowed?.();
      authorization?.assertCurrent();
    },
    assertTargetCurrent: (target) => {
      assertExpectedProfile?.();
      assertCommitAllowed?.();
      authorization?.assertTargetCurrent(target);
    },
  });
}
