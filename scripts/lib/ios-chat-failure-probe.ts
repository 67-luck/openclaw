import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Temporary investigation projection: no payloads, identifiers, paths, or error text leave the fixture.
export function projectChatFailureProbe(input: {
  gatewayLog: string;
  appLog?: string;
  requestLog?: string;
  history?: unknown;
  health?: unknown;
  mockFailed: boolean;
}) {
  const errorKinds = (text: string) =>
    Object.entries({
      auth: /unauthorized|authentication|api.key|auth.profile/iu,
      model: /unknown model|model.*(?:unavailable|not found)|no.*model/iu,
      timeout: /timed? ?out|timeout/iu,
      connection: /ECONNREFUSED|ECONNRESET|fetch failed|connection.*closed/iu,
      rateLimit: /rate.limit|\b429\b/iu,
      context: /context.*(?:length|limit|overflow)|too many tokens/iu,
      stateContention: /state.contention|database.*locked|SQLITE_BUSY/iu,
      dispatch: /dispatch.*(?:error|fail)|agent failed before reply/iu,
      aborted: /abort/iu,
      runtimeStartup: /prepared model runtime startup degraded after/iu,
      runtimePublication: /background model runtime publication failed:/iu,
      modelFetch: /\[model-fetch\] error/iu,
      memoryPreflight: /active-memory: before_prompt_build preflight timed out after/iu,
      memoryRecall: /active-memory: before_prompt_build recall timed out after/iu,
    }).flatMap(([kind, pattern]) => (pattern.test(text) ? [kind] : []));
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? Math.min(value, 1_000_000)
      : undefined;
  const health = isRecord(input.health) ? input.health : {};
  const healthRequests = isRecord(health.requests) ? health.requests : {};
  const ingress = isRecord(healthRequests.ingress) ? healthRequests.ingress : {};
  const selections = isRecord(healthRequests.selections) ? healthRequests.selections : {};
  const rows = input.requestLog?.trim().split("\n").filter(Boolean) ?? [];
  const requests = {
    available: input.requestLog !== undefined,
    total: rows.length,
    examined: Math.min(rows.length, 256),
    invalid: 0,
    routes: { responses: 0, chatCompletions: 0, embeddings: 0, other: 0 },
    bodies: { string: 0, truncated: 0, other: 0, invalid: 0 },
    models: { expected: 0, other: 0, absent: 0 },
    purposes: {
      "activity-recap": 0,
      "session-observer": 0,
      "benchmark-turn": 0,
      other: 0,
      absent: 0,
    },
    markers: { seed0: 0, seed1: 0, seed2: 0, final: 0 },
  };
  for (const row of rows.slice(-256)) {
    let request: unknown;
    try {
      request = JSON.parse(row);
    } catch {
      requests.invalid += 1;
      continue;
    }
    if (!isRecord(request)) {
      requests.invalid += 1;
      continue;
    }
    const route =
      request.path === "/v1/responses"
        ? "responses"
        : request.path === "/v1/chat/completions"
          ? "chatCompletions"
          : request.path === "/v1/embeddings"
            ? "embeddings"
            : "other";
    requests.routes[route] += 1;
    const purpose = isRecord(request.inferenceFacts) ? request.inferenceFacts.purpose : undefined;
    requests.purposes[
      purpose === "activity-recap" ||
      purpose === "session-observer" ||
      purpose === "benchmark-turn" ||
      purpose === "other"
        ? purpose
        : "absent"
    ] += 1;
    if (typeof request.body !== "string") {
      requests.bodies[
        isRecord(request.body) && request.body.truncated === true ? "truncated" : "other"
      ] += 1;
      continue;
    }
    requests.bodies.string += 1;
    let body: unknown;
    try {
      body = JSON.parse(request.body);
    } catch {
      requests.bodies.invalid += 1;
      continue;
    }
    requests.models[
      isRecord(body) && body.model === "ios-e2e"
        ? "expected"
        : isRecord(body) && typeof body.model === "string"
          ? "other"
          : "absent"
    ] += 1;
    for (const [key, marker] of [
      ["seed0", "OPENCLAW_E2E_SEED_0_"],
      ["seed1", "OPENCLAW_E2E_SEED_1_"],
      ["seed2", "OPENCLAW_E2E_SEED_2_"],
      ["final", "OPENCLAW_E2E_OK_"],
    ] as const) {
      if (request.body.includes(marker)) {
        requests.markers[key] += 1;
      }
    }
  }
  const messages =
    isRecord(input.history) && Array.isArray(input.history.messages)
      ? input.history.messages.filter(isRecord)
      : [];
  const app = input.appLog ?? "";
  const accepted = new Set(
    [...app.matchAll(/\] chat\.ui transport send accepted [^\n]*remoteRunId=([^\s]+)/gu)].map(
      (match) => match[1],
    ),
  );
  const events = { delta: 0, final: 0, error: 0, aborted: 0 };
  for (const match of app.matchAll(
    /\] chat\.ui event chat state=(delta|final|error|aborted) runId=([^\s]+)/gu,
  )) {
    const state = match[1];
    if (
      accepted.has(match[2]) &&
      (state === "delta" || state === "final" || state === "error" || state === "aborted")
    ) {
      events[state] += 1;
    }
  }
  return {
    investigationOnly: true,
    mock: {
      failed: input.mockFailed,
      healthStatus:
        health.ok === true ? "healthy" : input.health === undefined ? "unavailable" : "unexpected",
      ingress: Object.fromEntries(
        ["responses", "chatCompletions", "embeddings", "other"].map((key) => [
          key,
          count(ingress[key]),
        ]),
      ),
      selections: Object.fromEntries(
        ["model", "global", "automaticTool", "automaticText"].map((key) => [
          key,
          count(selections[key]),
        ]),
      ),
    },
    requests,
    app: {
      available: input.appLog !== undefined,
      acceptedRuns: accepted.size,
      acceptedRunEvents: events,
      terminalAcknowledgements: Object.fromEntries(
        ["ok", "error", "timeout"].map((status) => [
          status,
          [
            ...app.matchAll(
              new RegExp(`\\] chat\\.ui send terminal ack [^\\n]*status=${status}\\b`, "gu"),
            ),
          ].length,
        ]),
      ),
    },
    history: {
      available: isRecord(input.history) && Array.isArray(input.history.messages),
      roles: Object.fromEntries(
        ["user", "assistant", "toolResult"].map((role) => [
          role,
          messages.filter((message) => message.role === role).length,
        ]),
      ),
      errors: messages.filter(
        (message) => message.stopReason === "error" || typeof message.errorMessage === "string",
      ).length,
      errorKinds: errorKinds(
        messages
          .map((message) => (typeof message.errorMessage === "string" ? message.errorMessage : ""))
          .join("\n"),
      ),
    },
    gateway: {
      bytes: Buffer.byteLength(input.gatewayLog),
      truncated: input.gatewayLog.includes("[output truncated to last "),
      errorKinds: errorKinds(input.gatewayLog),
    },
  };
}
