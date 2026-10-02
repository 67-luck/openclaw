// Plugin Boundary Report tests cover plugin boundary report script behavior.
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPluginBoundaryReport,
  isPluginCompatEligibleForRemoval,
  type PluginBoundaryReportResult,
} from "../../scripts/plugin-boundary-report.js";

describe("plugin-boundary-report", () => {
  let summaryResult: PluginBoundaryReportResult;

  beforeAll(() => {
    summaryResult = createPluginBoundaryReport(["--summary", "--json"]);
  });

  it("emits compact CI-safe summary JSON", () => {
    const summary = JSON.parse(summaryResult.stdout) as {
      compat?: {
        removalPendingCount?: number;
        removalPendingDueCount?: unknown;
        removalPending?: Array<{
          code?: unknown;
          removeAfter?: unknown;
          blocker?: unknown;
          readerCount: number;
          readerSample: string[];
          dueForReview?: unknown;
        }>;
      };
      memoryHostSdk?: {
        implementation?: unknown;
      };
    };

    expect(summaryResult.exitCode).toBe(0);
    expect(summaryResult.stderr).toBe("");
    expect(summary.compat?.removalPendingCount).toBe(20);
    expect(summary.compat?.removalPendingDueCount).toEqual(expect.any(Number));
    expect(summary.compat?.removalPending?.map((record) => record.code)).toEqual([
      "sdk-untrusted-context-identifier-aliases",
      "plugin-sdk-media-understanding-public-demotion",
      "plugin-sdk-memory-host-core-public-demotion",
      "agent-harness-terminal-result-aliases",
      "message-presentation-legacy-bridges",
      "official-plugin-export-aliases",
      "plugin-sdk-channel-lifecycle-subpath",
      "plugin-sdk-channel-message-subpath",
      "plugin-sdk-channel-reply-pipeline-subpath",
      "plugin-sdk-channel-setup-input-fields",
      "plugin-sdk-config-runtime-subpath",
      "plugin-runtime-api-compat-aliases",
      "plugin-provider-manifest-compat-aliases",
      "plugin-sdk-provider-owned-helper-shims",
      "media-legacy-projection",
      "memory-host-compatibility-aliases",
      "plugin-sdk-broad-runtime-barrels",
      "plugin-sdk-focused-compat-aliases",
      "plugin-sdk-infra-runtime-subpath",
      "plugin-sdk-plugin-config-runtime-public-demotion",
    ]);
    expect(summary.compat?.removalPending?.[0]).toMatchObject({
      removeAfter: "2026-09-08",
      blocker: expect.stringContaining(
        "migration of published plugin readers is verified and explicit breaking-release approval is granted",
      ),
      readerSample: expect.arrayContaining([expect.any(String)]),
    });
    for (const record of summary.compat?.removalPending ?? []) {
      expect(record.removeAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(record.blocker).toEqual(expect.stringMatching(/retain|replacement/iu));
      expect(record.readerCount).toEqual(expect.any(Number));
      expect(record.readerSample).toHaveLength(Math.min(5, record.readerCount));
      for (const reader of record.readerSample) {
        expect(reader).toEqual(expect.any(String));
      }
      expect(record.dueForReview).toEqual(expect.any(Boolean));
    }
    expect(["private-core-bridge", "private-package-core-integrated"]).toContain(
      summary.memoryHostSdk?.implementation,
    );
  });

  it("treats removeAfter as the final compatibility day", () => {
    expect(
      isPluginCompatEligibleForRemoval("2026-08-12", new Date("2026-08-12T23:59:59.999Z")),
    ).toBe(false);
    expect(
      isPluginCompatEligibleForRemoval("2026-08-12", new Date("2026-08-13T00:00:00.000Z")),
    ).toBe(true);
    expect(isPluginCompatEligibleForRemoval(undefined, new Date("2026-08-13T00:00:00.000Z"))).toBe(
      false,
    );
  });

  it("renders removal-pending blockers and reader references without changing fail gates", () => {
    const result = createPluginBoundaryReport(["--summary"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("removalPending=20");
    expect(result.stdout).not.toContain("agent-harness-sdk-alias");
    expect(result.stdout).toMatch(/blocker=.*retain the public/iu);
    expect(result.stdout).toMatch(/readerRefs=\d+ readers=/u);
  });

  it("keeps blocked migrations due for review without exempting expired deprecations", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
      const blocked = createPluginBoundaryReport([
        "--summary",
        "--json",
        "--fail-on-eligible-compat",
      ]);

      expect(blocked.exitCode).toBe(0);
      expect(blocked.stderr).toBe("");
      expect(JSON.parse(blocked.stdout)).toMatchObject({
        compat: {
          eligibleForRemovalCount: 0,
          removalPending: expect.arrayContaining([
            expect.objectContaining({
              code: "plugin-sdk-channel-setup-input-fields",
              removeAfter: "2026-10-01",
              dueForReview: true,
              blocker: expect.stringContaining("published-plugin"),
            }),
            expect.objectContaining({
              code: "media-legacy-projection",
              removeAfter: "2026-10-01",
              dueForReview: true,
              blocker: expect.stringContaining("published-plugin"),
            }),
          ]),
        },
      });

      vi.setSystemTime(new Date("2026-11-30T00:00:00Z"));
      const expired = createPluginBoundaryReport([
        "--summary",
        "--json",
        "--fail-on-eligible-compat",
      ]);

      expect(expired.exitCode).toBe(1);
      expect(expired.stderr).toContain("compatibility record(s) are due for removal");
      expect(JSON.parse(expired.stdout)).toMatchObject({
        compat: {
          eligibleForRemoval: expect.arrayContaining([
            expect.objectContaining({
              code: "plugin-sdk-session-agent-resolution-aliases",
              removeAfter: "2026-11-29",
            }),
          ]),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the inbound reply dispatch major-version gate as date-ineligible", () => {
    const jsonResult = createPluginBoundaryReport(["--json", "--owner", "channel"]);
    const report = JSON.parse(jsonResult.stdout) as {
      compat?: {
        records?: Array<{
          code?: unknown;
          removeAfter?: unknown;
          removalGate?: unknown;
          eligibleForRemoval?: unknown;
        }>;
      };
    };
    const record = report.compat?.records?.find(
      (candidate) => candidate.code === "plugin-sdk-inbound-reply-dispatch-subpath",
    );

    expect(jsonResult.exitCode).toBe(0);
    expect(record).toMatchObject({
      removalGate: "next-plugin-sdk-major",
      eligibleForRemoval: false,
    });
    expect(record?.removeAfter).toBeUndefined();

    const textResult = createPluginBoundaryReport(["--owner", "channel"]);
    expect(textResult.stdout).toContain(
      "next-plugin-sdk-major plugin-sdk-inbound-reply-dispatch-subpath",
    );
    expect(textResult.stdout).not.toContain("no-date plugin-sdk-inbound-reply-dispatch-subpath");
  });
});
