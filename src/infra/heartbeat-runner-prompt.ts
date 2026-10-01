import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  isHeartbeatContentEffectivelyEmpty,
} from "../auto-reply/heartbeat.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readCronScratchSnapshot } from "../cron/scratch-read.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { formatErrorMessage } from "./errors.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isCronOwnedSystemEvent,
  isExecCompletionEvent,
  isExecCompletionSystemEvent,
  isHeartbeatDeliveryAwarenessEvent,
  isRelayableExecCompletionEvent,
} from "./heartbeat-events-filter.js";
import { heartbeatLog as log } from "./heartbeat-log.js";
import {
  resolveConfiguredHeartbeatPrompt,
  resolveHeartbeatResponseToolPrompt,
} from "./heartbeat-runner-config.js";
import { resolveHeartbeatSessionSelection } from "./heartbeat-runner-session.js";
import {
  resolveHeartbeatWakePayloadFlags,
  type HeartbeatWakePayloadFlags,
} from "./heartbeat-wake-policy.js";
import {
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  type HeartbeatScheduledTask,
  type HeartbeatWakeSource,
} from "./heartbeat-wake.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import {
  peekDeliverableSystemEventEntries,
  resolveSystemEventDeliveryContext,
  type SystemEvent,
} from "./system-events.js";

export function truncateHeartbeatPreview(value: string | undefined): string | undefined {
  return value ? truncateUtf16Safe(value, 200) : undefined;
}

type HeartbeatSkipReason = "empty-heartbeat-file" | typeof HEARTBEAT_SKIP_NO_PENDING_EVENT;

type HeartbeatPreflight = HeartbeatWakePayloadFlags & {
  session: ReturnType<typeof resolveHeartbeatSessionSelection>;
  pendingEventEntries: ReturnType<typeof peekDeliverableSystemEventEntries>;
  selectedEventEntries: SystemEvent[];
  deferredEventEntries: SystemEvent[];
  selectedDeliveryRouteKey?: string;
  turnSourceDeliveryContext: ReturnType<typeof resolveSystemEventDeliveryContext>;
  hasTaggedCronEvents: boolean;
  shouldInspectPendingEvents: boolean;
  authoritativeScheduledTick: boolean;
  skipReason?: HeartbeatSkipReason;
  scratchJobId?: string;
  scratchRevision?: number;
  heartbeatScratchContent?: string;
};

const EMPTY_DELIVERY_ROUTE_KEY = channelRouteDedupeKey();

function systemEventDeliveryRouteKey(event: SystemEvent): string | undefined {
  const key = channelRouteDedupeKey(event.deliveryContext);
  return key === EMPTY_DELIVERY_ROUTE_KEY ? undefined : key;
}

function selectSystemEventRouteGroup(
  events: readonly SystemEvent[],
  eligibility: { inspectsRunQueue: boolean; isCronWake: boolean },
): {
  selected: SystemEvent[];
  deferred: SystemEvent[];
  routeKey?: string;
} {
  const eligible = eligibility.inspectsRunQueue
    ? events
    : events.filter(
        (event) =>
          isExecCompletionSystemEvent(event) ||
          isCronOwnedSystemEvent(event, eligibility.isCronWake),
      );
  const firstExec = eligible.find((event) => isExecCompletionSystemEvent(event));
  const routeKey = firstExec
    ? systemEventDeliveryRouteKey(firstExec)
    : eligible.map(systemEventDeliveryRouteKey).find((key) => key !== undefined);
  if (!firstExec && routeKey === undefined) {
    const selected = new Set(eligible);
    return { selected: [...eligible], deferred: events.filter((event) => !selected.has(event)) };
  }
  const selected = eligible.filter((event) => systemEventDeliveryRouteKey(event) === routeKey);
  const selectedIds = new Set(selected);
  return {
    selected,
    deferred: events.filter((event) => !selectedIds.has(event)),
    ...(routeKey === undefined ? {} : { routeKey }),
  };
}

/**
 * Terminal no-op preflight (empty scratch, consumed exec events) must resolve
 * before retryable busy guards; wakes carrying heartbeat tasks keep deferral.
 */
export function shouldPreflightWakeBeforeBusy(
  source: HeartbeatWakeSource | undefined,
  scheduledEveryMs: number | undefined,
  scheduledTaskCount: number,
): boolean {
  return (
    scheduledTaskCount === 0 &&
    (source === "interval" ||
      (source === "exec-event" &&
        !(
          typeof scheduledEveryMs === "number" &&
          Number.isSafeInteger(scheduledEveryMs) &&
          scheduledEveryMs > 0
        )))
  );
}

export async function resolveHeartbeatPreflight(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  sessionKey?: string;
  reason?: string;
  source?: HeartbeatWakeSource;
  cronPayload?: boolean;
  scheduledEveryMs?: number;
  scheduledTasks?: readonly HeartbeatScheduledTask[];
}): Promise<HeartbeatPreflight> {
  let monitorScratch: Awaited<ReturnType<typeof readCronScratchSnapshot>>;
  try {
    monitorScratch = await readCronScratchSnapshot(resolveCronJobsStorePathFromConfig(params.cfg), {
      kind: "heartbeat",
      agentId: params.agentId,
    });
  } catch (error) {
    log.warn(`heartbeat: scratch read failed: ${formatErrorMessage(error)}`);
  }
  const wakeFlags = resolveHeartbeatWakePayloadFlags({
    source: params.source,
    reason: params.reason,
    cronPayload: params.cronPayload,
  });
  const session = resolveHeartbeatSessionSelection(
    params.cfg,
    params.agentId,
    params.heartbeat,
    params.sessionKey,
  );
  const pendingEventEntries = peekDeliverableSystemEventEntries(
    resolveSystemEventQueueKey(session.sessionKey, params.agentId),
  ).filter((event) => !isHeartbeatDeliveryAwarenessEvent(event));
  const hasTaggedCronEvents = pendingEventEntries.some((event) =>
    event.contextKey?.startsWith("cron:"),
  );
  // The selected queue follows isolated execution into reply admission; the base queue does not.
  const shouldInspectWakePendingEvents = wakeFlags.isWakePayload && session.inspectsRunQueue;
  const shouldInspectPendingEvents =
    wakeFlags.isExecEventWake ||
    wakeFlags.isCronWake ||
    shouldInspectWakePendingEvents ||
    hasTaggedCronEvents;
  const eventRouteSelection =
    params.scheduledTasks?.length || !shouldInspectPendingEvents
      ? { selected: [], deferred: pendingEventEntries }
      : selectSystemEventRouteGroup(pendingEventEntries, {
          inspectsRunQueue: session.inspectsRunQueue,
          isCronWake: wakeFlags.isCronWake,
        });
  // A queued exec completion owns its final route. Later generic events stay
  // pending and must not replace the route before outbound delivery.
  const turnSourceDeliveryContext = resolveSystemEventDeliveryContext(
    params.scheduledTasks?.length ? [] : eventRouteSelection.selected,
  );
  const shouldBypassScratchGates =
    wakeFlags.isExecEventWake ||
    wakeFlags.isCronWake ||
    wakeFlags.isWakePayload ||
    hasTaggedCronEvents;
  const heartbeatScratchContent = monitorScratch?.state.scratch?.content;
  const basePreflight = {
    ...wakeFlags,
    session,
    pendingEventEntries,
    selectedEventEntries: eventRouteSelection.selected,
    deferredEventEntries: eventRouteSelection.deferred,
    ...(eventRouteSelection.routeKey
      ? { selectedDeliveryRouteKey: eventRouteSelection.routeKey }
      : {}),
    turnSourceDeliveryContext,
    hasTaggedCronEvents,
    shouldInspectPendingEvents,
    authoritativeScheduledTick:
      typeof params.scheduledEveryMs === "number" &&
      Number.isSafeInteger(params.scheduledEveryMs) &&
      params.scheduledEveryMs > 0,
    ...(monitorScratch?.jobId
      ? {
          scratchJobId: monitorScratch.jobId,
          scratchRevision: monitorScratch.state.currentRevision,
        }
      : {}),
    // Bypass scopes (cron/exec events and wake payloads) stay
    // self-contained: only the job identity travels so heartbeat_respond can
    // still persist scratch, never the monitor instructions themselves.
    ...(!shouldBypassScratchGates && heartbeatScratchContent !== undefined
      ? { heartbeatScratchContent }
      : {}),
  } satisfies Omit<HeartbeatPreflight, "skipReason">;

  // The exec completion can be acknowledged by process poll after its wake is
  // queued. Treat that stale wake as consumed without touching unrelated events.
  if (
    wakeFlags.isExecEventWake &&
    !basePreflight.authoritativeScheduledTick &&
    !params.scheduledTasks?.length &&
    !hasTaggedCronEvents &&
    eventRouteSelection.selected.length === 0
  ) {
    return {
      ...basePreflight,
      skipReason: HEARTBEAT_SKIP_NO_PENDING_EVENT,
    };
  }
  if (shouldBypassScratchGates) {
    return basePreflight;
  }
  // Cron owns task due-ness. Task wakes still receive ordinary scratch prose,
  // but empty or missing scratch must never suppress the independently scheduled job.
  if (params.scheduledTasks?.length) {
    return basePreflight;
  }
  if (heartbeatScratchContent === undefined) {
    // Without scratch, the model still gets the generic monitor prompt and
    // decides whether anything needs attention.
    return basePreflight;
  }
  if (isHeartbeatContentEffectivelyEmpty(heartbeatScratchContent)) {
    return {
      ...basePreflight,
      skipReason: "empty-heartbeat-file",
    };
  }
  return basePreflight;
}

type HeartbeatPromptResolution = {
  prompt: string;
  hasTaskContinuation: boolean;
  hasExecCompletion: boolean;
  hasRelayableExecCompletion: boolean;
  hasCronEvents: boolean;
  usesHeartbeatResponseTool: boolean;
  genericEvents: SystemEvent[];
  inspectedSystemEventsToConsume: SystemEvent[];
  deferredSystemEvents: SystemEvent[];
  retainGenericEventsUntilDelivery: boolean;
};

function appendHeartbeatScratch(prompt: string, heartbeatScratchContent?: string): string {
  if (!heartbeatScratchContent) {
    return prompt;
  }
  const directives = heartbeatScratchContent.trim();
  if (!directives || prompt.includes(directives)) {
    return prompt;
  }
  return `${prompt}\n\nHeartbeat monitor scratch:\n${directives}`;
}

export function resolveHeartbeatRunPrompt(params: {
  cfg: OpenClawConfig;
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
  canRelayToUser: boolean;
  scheduledTasks: readonly HeartbeatScheduledTask[];
  heartbeatScratchContent?: string;
  useHeartbeatResponseTool: boolean;
}): HeartbeatPromptResolution {
  const pendingEventEntries = params.preflight.selectedEventEntries;
  const genericEvents: SystemEvent[] = [];
  const cronEvents: SystemEvent[] = [];
  const execEvents: SystemEvent[] = [];
  const cronNoise: SystemEvent[] = [];
  // Select once: admission owns generic text; completed delivery owns dedicated
  // prompts and filtered cron noise. Late arrivals retain their queue identities.
  for (const event of pendingEventEntries) {
    if (isExecCompletionSystemEvent(event)) {
      if (params.preflight.shouldInspectPendingEvents) {
        execEvents.push(event);
      }
    } else if (isCronOwnedSystemEvent(event, params.preflight.isCronWake)) {
      (isCronSystemEvent(event.text) || isExecCompletionEvent(event.text)
        ? cronEvents
        : cronNoise
      ).push(event);
    } else {
      genericEvents.push(event);
    }
  }
  const hasExecCompletion = execEvents.length > 0;
  const hasRelayableExecCompletion =
    params.canRelayToUser && execEvents.some((event) => isRelayableExecCompletionEvent(event.text));
  const hasCronEvents = cronEvents.length > 0;
  const retainGenericEventsUntilDelivery =
    params.preflight.session.inspectsRunQueue &&
    params.preflight.selectedDeliveryRouteKey !== undefined &&
    genericEvents.length > 0;
  const hasBackgroundTaskEvent =
    params.preflight.session.inspectsRunQueue &&
    genericEvents.some((event) => event.contextKey?.startsWith("task:"));
  if (params.scheduledTasks.length > 0) {
    const taskList = params.scheduledTasks
      .map((task) => `- ${task.name}: ${task.prompt}`)
      .join("\n");
    const completionInstruction = params.useHeartbeatResponseTool
      ? `After completing all due tasks:\n${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`
      : `After completing all due tasks, reply ${SILENT_REPLY_TOKEN}.`;
    const taskPrompt = `Run the following periodic tasks (only those due based on their intervals):

${taskList}

${completionInstruction}`;
    return {
      prompt: appendHeartbeatScratch(taskPrompt, params.heartbeatScratchContent),
      hasTaskContinuation: hasBackgroundTaskEvent,
      hasExecCompletion: false,
      hasRelayableExecCompletion: false,
      hasCronEvents: false,
      usesHeartbeatResponseTool: params.useHeartbeatResponseTool,
      genericEvents,
      inspectedSystemEventsToConsume: cronNoise,
      deferredSystemEvents: params.preflight.deferredEventEntries,
      retainGenericEventsUntilDelivery: false,
    };
  }

  const basePrompt =
    hasExecCompletion || hasCronEvents
      ? (hasExecCompletion ? buildExecEventPrompt : buildCronEventPrompt)(
          (hasExecCompletion ? execEvents : cronEvents).map((event) => event.text),
          {
            deliverToUser: params.canRelayToUser,
            useHeartbeatResponseTool: params.useHeartbeatResponseTool,
          },
        )
      : params.useHeartbeatResponseTool
        ? resolveHeartbeatResponseToolPrompt(params.cfg, params.heartbeat)
        : resolveConfiguredHeartbeatPrompt(params.cfg, params.heartbeat);
  return {
    prompt: appendHeartbeatScratch(basePrompt, params.heartbeatScratchContent),
    hasTaskContinuation:
      hasExecCompletion ||
      hasBackgroundTaskEvent ||
      cronEvents.some((event) => event.contextKey?.startsWith("task:")),
    hasExecCompletion,
    hasRelayableExecCompletion,
    hasCronEvents,
    usesHeartbeatResponseTool: params.useHeartbeatResponseTool,
    genericEvents,
    inspectedSystemEventsToConsume: [
      ...cronNoise,
      ...(retainGenericEventsUntilDelivery ? genericEvents : []),
      ...(hasExecCompletion ? execEvents : cronEvents),
    ],
    deferredSystemEvents: params.preflight.deferredEventEntries,
    retainGenericEventsUntilDelivery,
  };
}
