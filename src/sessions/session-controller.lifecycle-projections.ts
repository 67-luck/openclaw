import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { hasGatewayContextOwner } from "../plugins/runtime/gateway-request-scope.js";
import type { ReplyOperation } from "./session-controller.contracts.js";
import type { Effect, Mutation, OwnerContext } from "./session-controller.lifecycle.types.js";
import type {
  SessionControllerInput,
  SessionControllerMailboxClaim,
} from "./session-controller.mailbox.js";
import {
  findSessionControllerEntries,
  sessionControllers,
  type SessionControllerEntry,
} from "./session-controller.state.js";
import { targetFrom, type SessionTarget } from "./session-controller.target.js";

/** Incarnation is selected from the captured producer, never the mutable entry target. */
export function inputMatchesSessionId(input: SessionControllerInput, sessionId?: string): boolean {
  return (
    sessionId === undefined ||
    (input.source?.run.sessionId ?? input.target?.incarnation) === sessionId
  );
}

export function effectMatchesSessionId(effect: Effect, sessionId?: string): boolean {
  const target = effect.ref.target;
  return (
    sessionId === undefined ||
    target.incarnation === sessionId ||
    (!target.incarnation && effect.ref.operation?.hasOwnedSessionId(sessionId) === true)
  );
}

export function claimMatchesSessionId(
  claim: SessionControllerMailboxClaim,
  sessionId?: string,
): boolean {
  return (
    sessionId === undefined ||
    (claim.operation
      ? claim.operation.hasOwnedSessionId(sessionId)
      : claim.inputs.some((input) => inputMatchesSessionId(input, sessionId)))
  );
}

function matches(a: SessionTarget, b: SessionTarget): boolean {
  return a.storeScope === b.storeScope && a.aliases.some((id) => b.aliases.includes(id));
}
export function matchingEntries(target: SessionTarget): SessionControllerEntry[] {
  return findSessionControllerEntries(target.sessionKey, target);
}
export function selectedClaims(target: SessionTarget): SessionControllerMailboxClaim[] {
  return matchingEntries(target).flatMap((entry) =>
    entry.mailbox?.claim ? [entry.mailbox.claim] : [],
  );
}
export function selectedEffects(targets: readonly SessionTarget[]): Set<Effect> {
  return new Set(
    targets.flatMap((target) =>
      matchingEntries(target).flatMap((entry) =>
        [...(entry.lifecycle?.effects ?? [])].filter((effect) =>
          matches(effect.ref.target, target),
        ),
      ),
    ),
  );
}
export function selectedOperations(targets: readonly SessionTarget[]): Set<ReplyOperation> {
  const operations = new Set<ReplyOperation>();
  for (const target of targets) {
    for (const entry of matchingEntries(target)) {
      for (const operation of entry.lifecycle?.operations ?? []) {
        operations.add(operation);
      }
      if (entry.active) {
        operations.add(entry.active);
      }
    }
  }
  return operations;
}
export function* allEffects() {
  for (const entry of sessionControllers.values()) {
    yield* entry.lifecycle?.effects ?? [];
  }
}
function* allMutations() {
  const seen = new Set<Mutation>();
  for (const entry of sessionControllers.values()) {
    for (const mutation of entry.lifecycle?.mutations ?? []) {
      if (!seen.has(mutation)) {
        seen.add(mutation);
        yield mutation;
      }
    }
  }
}
export function collectSessionControllerTargets(
  owners?: ReadonlySet<object>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const entry of sessionControllers.values()) {
    const effects = [...(entry.lifecycle?.effects ?? [])].filter(
      (effect) =>
        (effect.phase === "acquired" || effect.phase === "writer") &&
        (!owners || owners.has(effect)),
    );
    const targets = [
      ...effects.map((effect) => effect.ref.target),
      ...(entry.mailbox?.claim && entry.target && (!owners || owners.has(entry.mailbox.claim))
        ? [entry.target]
        : []),
      ...((entry.active && (!owners || owners.has(entry.active))) ||
      [...(entry.lifecycle?.operations ?? [])].some((operation) => !owners || owners.has(operation))
        ? (entry.lifecycle?.targets.keys() ?? [])
        : []),
    ];
    for (const target of targets) {
      const identities = result.get(target.storeScope) ?? new Set();
      for (const id of target.aliases) {
        identities.add(id);
      }
      result.set(target.storeScope, identities);
    }
  }
  return result;
}
export function captureGatewaySessionControllerWork(resolveGatewayContext: GatewayContextResolver) {
  const owners = new Set<object>();
  for (const effect of allEffects()) {
    if (
      (effect.phase === "acquired" || effect.phase === "writer") &&
      effect.generation === getAgentRunLifecycleGeneration() &&
      hasGatewayContextOwner(effect, resolveGatewayContext)
    ) {
      owners.add(effect);
    }
  }
  for (const entry of sessionControllers.values()) {
    const claim = entry.mailbox?.claim;
    if (claim && hasGatewayContextOwner(claim, resolveGatewayContext)) {
      owners.add(claim);
    }
    if (entry.active && hasGatewayContextOwner(entry.active, resolveGatewayContext)) {
      owners.add(entry.active);
    }
    for (const operation of entry.lifecycle?.operations ?? []) {
      if (hasGatewayContextOwner(operation, resolveGatewayContext)) {
        owners.add(operation);
      }
    }
  }
  return {
    targets: collectSessionControllerTargets(owners),
    isActive: (params: { scope: string; sessionKey: string; sessionId: string }) => {
      const target = targetFrom({
        scope: params.scope,
        identities: [params.sessionKey, params.sessionId],
      });
      return (
        selectedClaims(target).some((claim) => owners.has(claim)) ||
        [...selectedOperations([target])].some(
          (operation) => owners.has(operation) && operation.hasOwnedSessionId(params.sessionId),
        ) ||
        [...selectedEffects([target])].some(
          (effect) =>
            owners.has(effect) &&
            (effect.phase === "acquired" || effect.phase === "writer") &&
            (effect.ref.target.aliases.length === 1 ||
              target.aliases.every((id) => effect.ref.target.aliases.includes(id))),
        )
      );
    },
  };
}
export function getSessionControllerWorkCount(): number {
  return [...sessionControllers.values()].filter(
    (entry) =>
      entry.active ||
      entry.mailbox?.claim ||
      entry.lifecycle?.operations.size ||
      [...(entry.lifecycle?.effects ?? [])].some(
        (effect) => effect.phase === "acquired" || effect.phase === "writer",
      ),
  ).length;
}
export function getSessionMutationCount(): number {
  return [...allMutations()].filter((mutation) => mutation.phase === "active").length;
}
export function isSessionMutationActive(
  scope: string,
  identities: Iterable<string | undefined>,
): boolean {
  return matchingEntries(targetFrom({ scope, identities })).some((entry) =>
    entry.lifecycle?.mutations.some((mutation) => mutation.phase === "active"),
  );
}
export function hasOnlySessionMutationKindActive(
  scope: string,
  identities: Iterable<string | undefined>,
  kind: "compaction",
): boolean {
  const mutations = matchingEntries(targetFrom({ scope, identities })).flatMap(
    (entry) => entry.lifecycle?.mutations.filter((mutation) => mutation.phase === "active") ?? [],
  );
  return mutations.length > 0 && mutations.every((mutation) => mutation.kind === kind);
}
export function collectSessionMutationIdentities(scope: string): string[] {
  return [
    ...new Set(
      [...allMutations()]
        .filter((mutation) => mutation.phase === "active")
        .flatMap((mutation) =>
          mutation.targets
            .filter((target) => target.storeScope === scope.trim())
            .flatMap((target) => target.aliases),
        ),
    ),
  ].toSorted();
}

/** Capture scoped physical owners once; interruption never rediscovers a successor. */
export function selectSessionControllerInterruptionOwners(
  target: SessionTarget,
  current: OwnerContext | undefined,
  params: { requiredSessionId?: string; admissionsOnly?: boolean },
) {
  const effects = [...selectedEffects([target])].filter(
    (effect) =>
      effectMatchesSessionId(effect, params.requiredSessionId) &&
      !current?.effects.has(effect) &&
      (!current?.operation || effect.ref.operation !== current.operation),
  );
  const operations = [...selectedOperations([target])].filter(
    (operation) =>
      !params.admissionsOnly &&
      operation !== current?.operation &&
      (params.requiredSessionId === undefined ||
        operation.hasOwnedSessionId(params.requiredSessionId)),
  );
  const claims = selectedClaims(target).filter(
    (claim) =>
      (!params.admissionsOnly || !claim.operation) &&
      claimMatchesSessionId(claim, params.requiredSessionId) &&
      claim !== current?.claim &&
      (!current?.operation || claim.operation !== current.operation),
  );
  return { effects, operations, claims };
}
