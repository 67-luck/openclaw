import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  buildRequesterSettleWakeIdentity,
  hasRequesterCompletionCohort,
} from "../registry/subagent-requester-settle-identity.js";
import { loadRequesterSessionEntry } from "./subagent-announce-delivery.runtime.js";

export const subagentCompletionSourceId = (entry: SubagentRunRecord) =>
  `subagent-completion:${entry.runId}:${entry.generation ?? 0}`;

/** Reserves one followup source against the durable registry row that owns it. */
export function reserveSubagentControllerSource(
  entry: SubagentRunRecord,
  reservationId: string,
  protocolRunId?: string,
  continuationCaller?: SessionControllerInput["continuationCaller"],
): SessionControllerInput | undefined {
  const requester = loadRequesterSessionEntry(entry.requesterSessionKey, entry.requesterAgentId);
  if (!requester.entry?.sessionId || !requester.storePath) {
    return undefined;
  }
  return reserveSessionControllerSource(requester.canonicalKey, {
    reservationId,
    protocolRunId,
    continuationCaller,
    policy: { mode: "followup" },
    target: captureSessionTarget({
      storeScope: requester.storePath,
      sessionKey: requester.canonicalKey,
      aliases: [entry.requesterSessionKey],
      agentId: requester.agentId,
      incarnation: requester.entry.sessionId,
    }),
  });
}

export const reserveSubagentCompletionControllerSource = (
  entry: SubagentRunRecord,
  protocolRunId?: string,
) => reserveSubagentControllerSource(entry, subagentCompletionSourceId(entry), protocolRunId);

/** Rebuilds process-local mailbox custody from durable completion obligations in owed order. */
export function reserveRestoredSubagentControllerSources(
  entries: readonly SubagentRunRecord[],
): SessionControllerInput[] {
  const reservations: Array<[number, () => SessionControllerInput | undefined]> = [];
  const entriesById = new Map(entries.map((entry) => [entry.runId, entry]));
  for (const entry of entries) {
    if (
      entry.expectsCompletionMessage === true &&
      !hasRequesterCompletionCohort(entry) &&
      (entry.delivery?.status === "pending" || entry.delivery?.status === "in_progress")
    ) {
      reservations.push([
        entry.delivery.createdAt ?? entry.execution.endedAt ?? entry.createdAt,
        () => reserveSubagentCompletionControllerSource(entry),
      ]);
    }
    const wake = entry.requesterSettleWake;
    const batchRunIds = wake?.batchRunIds?.toSorted();
    if (!wake || !batchRunIds?.length) {
      continue;
    }
    const batch = batchRunIds.flatMap((runId) => {
      const member = entriesById.get(runId);
      return member ? [member] : [];
    });
    if (entry !== batch[0]) {
      continue;
    }
    const attemptIndex =
      wake.status === "dispatching" ? Math.max(0, wake.attemptCount - 1) : wake.attemptCount;
    const { batchKey } = buildRequesterSettleWakeIdentity({
      requesterSessionKey: entry.requesterSessionKey,
      requesterAgentId: entry.requesterAgentId,
      batchRunIds,
      rearmGeneration: wake.rearmGeneration,
    });
    const sourceId = `${batchKey}:attempt-${attemptIndex}`;
    const caller = Object.freeze({
      deliveryRoute: entry.requesterOrigin && Object.freeze(structuredClone(entry.requesterOrigin)),
      run: <T>(run: () => Promise<T>) => run(),
    });
    reservations.push([
      Math.max(...batch.map((member) => member.execution.endedAt ?? member.createdAt)),
      () => reserveSubagentControllerSource(entry, sourceId, undefined, caller),
    ]);
  }
  return reservations.toSorted(([a], [b]) => a - b).flatMap(([, reserve]) => reserve() ?? []);
}
