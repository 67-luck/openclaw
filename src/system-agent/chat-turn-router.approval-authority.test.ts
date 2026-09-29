import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  fakeOverviewLoader,
  hashSystemAgentOperation,
  SystemAgentChatEngine,
  useTempStateDir,
} from "./chat-engine.test-support.js";

describe("SystemAgentChatEngine delegated approval authority", () => {
  it("rechecks authority after asynchronous config preparation", async () => {
    useTempStateDir();
    const persisted: string[] = [];
    let authorityOpen = true;
    const runConfigSet = vi.fn(
      async (params: {
        path?: string;
        value?: string;
        cliOptions: object;
        beforePersistentApply?: () => void;
      }) => {
        await Promise.resolve();
        authorityOpen = false;
        params.beforePersistentApply?.();
        persisted.push(`${params.path}=${params.value}`);
      },
    );
    const operation = { kind: "config-set" as const, path: "gateway.port", value: "19001" };
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose(operation);

    const reply = await engine.resolveOperatorApproval(
      "allow-once",
      hashSystemAgentOperation(operation),
      () => {
        if (!authorityOpen) {
          throw new Error("delegated authority ended during config preparation");
        }
      },
    );

    expect(reply?.applied).toBe(false);
    expect(reply?.text).toContain("delegated authority ended during config preparation");
    expect(persisted).toEqual([]);
  });
});
