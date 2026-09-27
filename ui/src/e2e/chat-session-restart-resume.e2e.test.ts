import { expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI restart recovery",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("resumes the selected conversation and restores its composer without creating another session", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 800 }, colorScheme: "dark" },
      async ({ page }) => {
        const key = "agent:main:dashboard:restart-recovery";
        const sessionId = "restart-recovery-session";
        const row: GatewaySessionRow = {
          key,
          sessionId,
          displayName: "Deployment checks",
          kind: "direct",
          updatedAt: 100,
          status: "failed",
          hasActiveRun: false,
          restartRecoveryStatus: "tombstoned",
        };
        const list: SessionsListResult = {
          ts: 100,
          path: "",
          count: 1,
          defaults: { model: "gpt-5-mini", modelProvider: "openai", contextTokens: 128_000 },
          sessions: [row],
        };
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          featureMethods: [...defaultControlUiFeatureMethods, "sessions.recover"],
          heldMethods: ["sessions.recover"],
          historyMessages: [{ role: "user", content: "Finish verifying the deployment." }],
          methodResponses: { "sessions.list": list },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const resume = page.getByRole("button", { name: "Resume session", exact: true });
        await resume.waitFor();
        const url = page.url();
        const artifacts = createControlUiE2eArtifactDir("restart-session-resume");
        await page.screenshot({ path: artifacts + "/resume-action.png", animations: "disabled" });
        await page
          .locator(".agent-chat__disabled-banner")
          .screenshot({ path: artifacts + "/resume-banner.png" });
        await resume.click();
        const request = await gateway.waitForRequest("sessions.recover");
        expect(request.params).toMatchObject({ agentId: "main", key });
        await page.getByRole("button", { name: "Resuming…", exact: true }).waitFor();
        await gateway.setSessionsListResponse({
          ...list,
          ts: 101,
          sessions: [{ ...row, updatedAt: 101, status: "done", restartRecoveryStatus: undefined }],
        });
        await gateway.resolveDeferred("sessions.recover", {
          ok: true,
          key,
          sessionId,
          continuation: { status: "started", runId: "explicit-resume" },
        });
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await composer.fill("Check the final result too.");
        expect(page.url()).toBe(url);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.recover")).toHaveLength(1);
        await page.screenshot({ path: artifacts + "/resumed-session.png", animations: "disabled" });
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
          sessionKey: key,
          message: "Check the final result too.",
        });
      },
    );
  });
});
