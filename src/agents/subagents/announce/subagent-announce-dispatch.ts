type SubagentDeliveryPath = "steered" | "direct" | "queued" | "none";
type SubagentAnnounceDeliveryDisposition =
  | "delivered"
  | "session_queued"
  | "intentional_non_delivery"
  | "retryable"
  | "ambiguous"
  | "permanent_failure";
type SubagentAnnounceDeliveryFailureReason =
  | "completion_handoff_pending"
  | "completion_handoff_unavailable"
  | "delivery_suppressed"
  | "generated_media_missing"
  | "message_tool_delivery_missing"
  | "requester_abandoned"
  | "source_owner_changed"
  | "steer_dropped"
  | "visible_reply_missing";

type SubagentAnnounceSteerOutcome =
  | { status: "steered"; deliveredAt?: number; enqueuedAt?: number }
  | { status: "none" | "dropped" | "source_owner_changed" };

export type SubagentAnnounceDeliveryResult = {
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  /** Direct delivery that already committed the requester's visible final. */
  requesterVisibleFinalDelivered?: true;
  storeReplaced?: true;
  /** Bounded visible final returned by the direct requester synthesis turn. */
  finalAssistantVisibleText?: string;
  reason?: SubagentAnnounceDeliveryFailureReason;
  error?: string;
  // Stops fallback delivery when ownership changed or another terminal result
  // makes trying a second path unsafe.
  terminal?: boolean;
  disposition?: SubagentAnnounceDeliveryDisposition;
  missingMediaUrls?: string[];
  phases?: Array<{
    phase: "steer-primary" | "direct-primary" | "steer-fallback";
    delivered: boolean;
    path: SubagentDeliveryPath;
    deliveredAt?: number;
    enqueuedAt?: number;
    reason?: SubagentAnnounceDeliveryFailureReason;
    error?: string;
  }>;
};

export function sourceOwnerChangedResult(): SubagentAnnounceDeliveryResult {
  return {
    delivered: false,
    path: "none",
    reason: "source_owner_changed",
    error: "subagent source lifecycle changed before completion delivery",
    terminal: true,
    disposition: "intentional_non_delivery",
  };
}

function mapSteerOutcomeToDeliveryResult(
  outcome: SubagentAnnounceSteerOutcome,
): SubagentAnnounceDeliveryResult {
  if (outcome.status === "steered") {
    return {
      delivered: true,
      path: "steered",
      deliveredAt: outcome.deliveredAt,
      enqueuedAt: outcome.enqueuedAt,
    };
  }
  if (outcome.status === "source_owner_changed") {
    return sourceOwnerChangedResult();
  }
  return {
    delivered: false,
    path: "none",
    ...(outcome.status === "dropped" ? { reason: "steer_dropped" } : {}),
  };
}

export async function runSubagentAnnounceDispatch(params: {
  expectsCompletionMessage: boolean;
  requireDirectDelivery?: boolean;
  signal?: AbortSignal;
  steer: () => Promise<SubagentAnnounceSteerOutcome>;
  direct: () => Promise<SubagentAnnounceDeliveryResult>;
}): Promise<SubagentAnnounceDeliveryResult> {
  if (params.signal?.aborted) {
    return { delivered: false, path: "none" };
  }

  if (!params.requireDirectDelivery && !params.expectsCompletionMessage) {
    const primarySteerOutcome = await params.steer();
    const primarySteer = mapSteerOutcomeToDeliveryResult(primarySteerOutcome);
    if (
      primarySteer.delivered ||
      primarySteer.terminal ||
      primarySteerOutcome.status === "dropped"
    ) {
      return primarySteer;
    }
  }
  return await params.direct();
}
