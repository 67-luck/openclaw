import { truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  diagnosticReadOutcome,
  projectReadinessTimeline,
  readProviderIngress,
  readReadinessLog,
} from "../../scripts/lib/ios-readiness-diagnostics.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());
const started = Date.parse("2026-09-26T12:00:00.000Z");
const line = (message: string, offset = 0) =>
  `[${new Date(started + offset).toISOString()}] ${message}`;

it("projects readiness and existing send facts without exporting private values", () => {
  const proof = projectReadinessTimeline(
    [
      line(
        "ios.readiness event=health stage=begin health=false current=true elapsedMs=0 session=PRIVATE_SESSION error=PRIVATE_ERROR",
      ),
      line(
        "ios.readiness event=bootstrap stage=operator-error problem=pairingRequired pairingApproval=true pauseReconnect=false",
        2,
      ),
      line(
        "chat.ui send invoked sessionKey=PRIVATE_SESSION inputLen=42 attachments=0 pending=0 sending=false health=false",
        3,
      ),
      line("chat.ui send ignored reason=pending sessionKey=PRIVATE_SESSION", 4),
      line("chat.ui transport send start sessionKey=PRIVATE_SESSION request=PRIVATE_REQUEST", 5),
      line(
        "ios.readiness event=send stage=end outcome=PRIVATE_ERROR inputLength=PRIVATE_INPUT pending=-1 health=PRIVATE_BOOL",
        6,
      ),
      line("ios.readiness event=PRIVATE_EVENT stage=begin", 7),
      line("ios.readiness event=send stage=PRIVATE_STAGE", 8),
      line("ios.readiness event=bootstrap stage=operator-error problem=PRIVATE_PROBLEM", 9),
    ].join("\n"),
    started,
  );
  expect(proof.events).toEqual([
    {
      event: "health",
      stage: "begin",
      atMs: 0,
      fields: { health: false, current: true, elapsedMs: 0 },
    },
    {
      event: "bootstrap",
      stage: "operator-error",
      atMs: 2,
      fields: { problem: "pairingRequired", pairingApproval: true, pauseReconnect: false },
    },
    {
      event: "send",
      stage: "invoked",
      atMs: 3,
      fields: { inputLength: 42, pending: 0, sending: false, health: false },
    },
    { event: "send", stage: "ignored", atMs: 4, fields: { reason: "pending" } },
    { event: "send", stage: "transport-start", atMs: 5, fields: {} },
    { event: "send", stage: "end", atMs: 6, fields: {} },
    { event: "bootstrap", stage: "operator-error", atMs: 9, fields: {} },
  ]);
  expect(proof.rejected).toBe(2);
  expect(JSON.stringify(proof)).not.toContain("PRIVATE");
});

it("bounds repeated events while retaining initial state and the latest failure context", () => {
  const proof = projectReadinessTimeline(
    [
      ...Array.from({ length: 300 }, (_, index) =>
        line(`ios.readiness event=send stage=begin inputLength=${index}`, index),
      ),
      line("ios.readiness event=health stage=end elapsedMs=1000000000 outcome=ok", 301),
      line("ios.readiness event=send stage=end", 3_600_001),
      line(`ios.readiness event=send stage=begin private=${"x".repeat(2048)}`, 303),
    ].join("\n"),
    started,
  );
  expect(proof.events).toHaveLength(128);
  expect(proof.events[0]?.fields).toEqual({ inputLength: 0 });
  expect(proof.events[31]?.fields).toEqual({ inputLength: 31 });
  expect(proof.events.at(-2)?.fields).toEqual({ inputLength: 299 });
  expect(proof.events.at(-1)?.fields).toEqual({ outcome: "ok" });
  expect(proof.omitted).toBe(173);
  expect(proof.rejected).toBe(2);
});

it("reads bounded real files and distinguishes absent logs from size refusal", async () => {
  const directory = temps.make("ios-readiness-log-");
  const log = path.join(directory, "app.log");
  await expect(readReadinessLog(log).catch(diagnosticReadOutcome)).resolves.toBe("missing");
  writeFileSync(log, "small log");
  await expect(readReadinessLog(log)).resolves.toBe("small log");
  truncateSync(log, 1024 * 1024 + 1);
  await expect(readReadinessLog(log).catch(diagnosticReadOutcome)).resolves.toBe("too-large");
});

it("retains only bounded provider counters so zero requests differs from unavailable evidence", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        requests: {
          id: "PRIVATE_PROVIDER_ID",
          ingress: { responses: 0, chatCompletions: 0, embeddings: 0, other: 0 },
          private: "PRIVATE_BODY",
        },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  const result = await readProviderIngress("http://127.0.0.1:1/health", signal);
  expect(result).toEqual({
    status: "read",
    counts: { responses: 0, chatCompletions: 0, embeddings: 0, other: 0 },
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  fetch.mockResolvedValueOnce(new Response("x".repeat(8193)));
  await expect(readProviderIngress("http://127.0.0.1:1/health", signal)).resolves.toEqual({
    status: "too-large",
  });
  fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
  await expect(readProviderIngress("http://127.0.0.1:1/health", signal)).resolves.toEqual({
    status: "unavailable",
  });
});
