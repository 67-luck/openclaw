import path from "node:path";
import { z } from "zod";
import type { InstalledUpdateRetirementBinding } from "./schtasks.installed-retirement-observation.test-support.js";

const uint = z.number().int().min(0).max(0xffffffff);
const identity = { pid: uint.positive(), nativeStartFileTime: z.string().regex(/^\d{15,20}$/u) };
const stamp = z.string().max(64).datetime();
const reason = z.string().regex(/^[a-z-]{1,80}$/u);
const relative = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      !path.win32.isAbsolute(value) &&
      !value.includes(":") &&
      !value.includes("\0") &&
      (value === "." || !value.split(/[\\/]/u).some((part) => part === "." || part === "..")),
  );
const row = z.object({
  ...identity,
  threadId: uint.positive(),
  relativeTarget: relative,
  operation: z.string().regex(/^[A-Za-z0-9_.:/ -]{1,200}$/u),
  eventId: uint,
  eventVersion: uint,
  infoClass: z.string().max(20).nullable(),
  beganAt: stamp,
  completedAt: stamp,
  ntStatus: z.string().regex(/^0x[0-9A-F]{8}$/u),
});
const request = z.object({
  ...identity,
  evidenceKind: z.literal("request-event-only"),
  pathProvenance: z.literal("explicit-FilePath"),
  threadId: uint.positive(),
  relativeTarget: relative,
  eventId: z.literal(26),
  eventVersion: z.literal(1),
  infoClass: z.union([z.literal(13), z.literal(64)]),
  eventAt: stamp,
  completion: z.literal("unknown"),
  ntStatus: z.null(),
});
const resultSchema = z.object({
  ...identity,
  phase: z.literal("result"),
  observation: z.enum(["attributed", "insufficient-evidence"]),
  coverageComplete: z.boolean(),
  cleanupVerified: z.boolean(),
  identityRefused: z.boolean(),
  projectionStarted: z.boolean(),
  elapsedMs: z.number().nonnegative(),
  rawArtifactUploadAllowed: z.literal(false),
  partial: z.array(reason).max(32),
  records: z.array(row).max(256),
  counts: z.object({
    parsed: uint,
    ownBegins: uint,
    unmatchedEnds: uint,
    unresolvedTargets: uint,
    unresolvedThreads: uint,
    outOfScope: uint,
  }),
  threadCoverage: z.object({
    before: z.literal("held-native-handles"),
    after: z.enum(["completed", "unavailable", "not-attempted"]),
    maximumHandles: z.literal(256),
  }),
  captureInterval: z.object({ startedAt: stamp.nullable(), endedAt: stamp.nullable() }),
  postStopAdmission: z
    .object({
      state: z.enum([
        "Unknown",
        "Live",
        "QueryFailed",
        "IdentityMismatch",
        "Exited",
        "WaitFailed",
        "WaitUnexpected",
      ]),
      admitted: z.boolean(),
      nativeError: z.number().int().nullable(),
      waitStatus: uint.nullable(),
      reason: reason.nullable(),
    })
    .nullable(),
  loss: z
    .object({
      statisticsKnown: z.boolean(),
      stopStatus: uint,
      eventsLost: uint.nullable(),
      logBuffersLost: uint.nullable(),
      realTimeBuffersLost: uint.nullable(),
      buffersWritten: uint.nullable(),
    })
    .nullable(),
});
const factsSchema = z.object({
  phase: z.literal("owned-begin-facts"),
  diagnosticOnly: z.literal(true),
  unavailable: z.boolean(),
  truncated: z.boolean(),
  priorityTruncated: z.boolean(),
  nonPriorityTruncated: z.boolean(),
  events: z.array(z.object({ requestEvent: request.optional() })).max(16),
});
const censusEventId = z.literal([10, 11, 12, 13, 14, 15, 17, 18, 24, 26]);
const censusReason = z.enum([
  "outside-capture-window",
  "outside-original-lifetime",
  "unknown-schema",
  "name-event",
  "completion-event",
  "missing-or-zero-irp",
  "missing-issuing-thread",
  "unverified-issuing-thread",
  "outside-owned-path",
  "unresolved-target",
  "request-retained",
  "processing-interrupted",
]);
const censusCount = z.number().int().min(0).max(20_000);
const fieldPresence = z.object({
  Irp: z.boolean(),
  IrpPtr: z.boolean(),
  FileObject: z.boolean(),
  FileKey: z.boolean(),
  IssuingThreadId: z.boolean(),
  TTID: z.boolean(),
  ThreadId: z.boolean(),
  Status: z.boolean(),
  FileName: z.boolean(),
  OpenPath: z.boolean(),
  FilePath: z.boolean(),
  CreateOptions: z.boolean(),
  InfoClass: z.boolean(),
});
const censusRow = z
  .object({
    eventId: censusEventId,
    eventVersion: uint,
    headerPidMatched: z.literal(true),
    priorityEventFamily: z.boolean(),
    timeWindowMatched: z.boolean().nullable(),
    processLifetimeMatched: z.boolean().nullable(),
    processTime: z
      .object({
        querySucceeded: z.boolean(),
        nativeError: z.number().int().min(-0x80000000).max(0x7fffffff).nullable(),
        creationMatches: z.boolean().nullable(),
        eventNotBeforeCreation: z.boolean().nullable(),
        exitTimePresent: z.boolean().nullable(),
        eventNotAfterExit: z.boolean().nullable(),
      })
      .nullable(),
    issuingThreadVerified: z.boolean().nullable(),
    fieldPresence: fieldPresence.partial(),
    irpValueNonzero: z.boolean().nullable(),
    fieldShapeUnavailable: z.boolean(),
    filterReason: censusReason,
  })
  .refine((event) => event.priorityEventFamily === [17, 18, 26].includes(event.eventId))
  .refine(
    (event) => event.fieldShapeUnavailable || fieldPresence.safeParse(event.fieldPresence).success,
  );
const censusSchema = z
  .object({
    phase: z.literal("filter-census"),
    diagnosticOnly: z.literal(true),
    meaning: z.literal(
      "provider event counts and header PID equality only; neither grants process, path, or operation authority",
    ),
    // Exhaustive finite records admit 10 + 10 + 12 count keys in total.
    relevantEventCounts: z.record(censusEventId, censusCount),
    headerPidMatchCounts: z.record(censusEventId, censusCount),
    filterReasonCounts: z.record(censusReason, censusCount),
    events: z.array(censusRow).max(32),
    unavailable: z.boolean(),
    truncated: z.boolean(),
    priorityTruncated: z.boolean(),
    nonPriorityTruncated: z.boolean(),
    rowLimit: z.literal(32),
    byteLimit: z.literal(32768),
    countKeyLimit: z.literal(32),
    priorityRowLimit: z.literal(16),
    nonPriorityRowLimit: z.literal(16),
  })
  .refine((census) => {
    const priority = census.events.filter((event) => event.priorityEventFamily).length;
    return priority <= 16 && census.events.length - priority <= 16;
  });
const censusPhase = z.object({ phase: z.literal("filter-census") });

function readFilterCensus(records: unknown[]) {
  const unavailable = { phase: "filter-census", diagnosticOnly: true, unavailable: true } as const;
  const candidates = records.filter((record) => censusPhase.safeParse(record).success);
  if (candidates.length !== 1 || Buffer.byteLength(JSON.stringify(candidates[0]) ?? "") > 32768) {
    return unavailable;
  }
  const census = censusSchema.safeParse(candidates[0]);
  if (!census.success || Buffer.byteLength(JSON.stringify(census.data)) > 32768) {
    return unavailable;
  }
  return census.data;
}

const outcomeSchema = z.object({
  exitCode: z.number().int(),
  records: z.array(z.unknown()).max(8),
});

/** Project only bounded diagnostic fields; never retain raw native envelopes. */
export function readInstalledFileIoObservation(
  value: unknown,
  binding: InstalledUpdateRetirementBinding,
) {
  const unavailable = { unavailable: "FileIO projection unavailable or binding refused" };
  const descriptor = binding.fileIo;
  const pin = binding.pinnedProcess;
  if (!descriptor?.trigger || !pin || Buffer.byteLength(JSON.stringify(value) ?? "") > 320 * 1024) {
    return unavailable;
  }
  const outcome = outcomeSchema.safeParse(value);
  if (!outcome.success) {
    return unavailable;
  }
  const result = outcome.data.records
    .map((record) => resultSchema.safeParse(record))
    .find((parsed) => parsed.success);
  const facts = outcome.data.records
    .map((record) => factsSchema.safeParse(record))
    .find((parsed) => parsed.success);
  if (
    !result?.success ||
    !facts?.success ||
    Buffer.byteLength(JSON.stringify(facts.data)) > 32768
  ) {
    return unavailable;
  }
  const sameIdentity = (record: { pid: number; nativeStartFileTime: string }) =>
    record.pid === pin.pid && record.nativeStartFileTime === pin.startTicks;
  const requests = facts.data.events.flatMap((event) =>
    event.requestEvent ? [event.requestEvent] : [],
  );
  const start = Date.parse(result.data.captureInterval.startedAt ?? "");
  const end = Date.parse(result.data.captureInterval.endedAt ?? "");
  if (
    !sameIdentity(result.data) ||
    !result.data.records.every(sameIdentity) ||
    requests.length > 8 ||
    !requests.every(
      (event) =>
        sameIdentity(event) &&
        Date.parse(event.eventAt) >= start &&
        Date.parse(event.eventAt) <= end,
    ) ||
    (requests.length > 0 &&
      (!Number.isFinite(start) ||
        end < start ||
        start <= descriptor.trigger.terminalJson.observedAtMs))
  ) {
    return unavailable;
  }
  return {
    result: result.data,
    facts: facts.data,
    filterCensus: readFilterCensus(outcome.data.records),
    exitCode: outcome.data.exitCode,
    runtime: descriptor.runtime,
    trigger: {
      kind: descriptor.trigger.terminalJson.kind,
      observedAtMs: descriptor.trigger.terminalJson.observedAtMs,
      stdoutRevision: descriptor.trigger.terminalJson.stdoutRevision,
      ledgerObservedAtMs: descriptor.trigger.ledgerObservedAtMs,
    },
    limitation:
      "Request event presence only; not distinct operations, active-at-instant IO, completion, NTSTATUS, settlement, absence or complete coverage",
  };
}
