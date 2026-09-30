import type { Page } from "playwright";
import { waitForControlUiInitialRoster } from "./control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "./control-ui-e2e.ts";
import {
  createControlUiChatHistoryMessage,
  createControlUiSessionRow,
} from "./control-ui-session-fixtures.ts";

export const bootDynamicImportMarkPrefix = "openclaw:boot-import:";
export const bootTranscriptText = "The existing conversation is ready.";
export const bootSessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";

/** Authenticated foreground boot; browser idle work stays queued until after capture. */
export async function captureControlUiBoot(
  page: Page,
  baseUrl: string,
  options: { serverBuildId?: string; mainSession?: boolean; route?: "chat" | "new" } = {},
) {
  const chat = options.route !== "new";
  const origin = new URL(baseUrl).origin;
  const requests: Array<{ path: string; startedAt: number }> = [];
  const pending = new Map<string, { done: Promise<void>; resolve: () => void }>();
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  network.on("Network.requestWillBeSent", ({ request, requestId, wallTime }) => {
    const url = new URL(request.url);
    const assetsAt = url.pathname.indexOf("/assets/");
    if (url.origin === origin && assetsAt >= 0 && url.pathname.endsWith(".js")) {
      requests.push({ path: url.pathname.slice(assetsAt), startedAt: wallTime * 1_000 });
      const completion = Promise.withResolvers<void>();
      pending.set(requestId, { done: completion.promise, resolve: completion.resolve });
    }
  });
  const finish = ({ requestId }: { requestId: string }) => {
    pending.get(requestId)?.resolve();
    pending.delete(requestId);
  };
  network.on("Network.loadingFinished", finish);
  network.on("Network.loadingFailed", finish);
  const drainScripts = async () => {
    // A completed module can schedule another import from its render. Join
    // requests and their rendering turn, rather than waiting a wall-clock settle.
    let previousRequests: number;
    do {
      previousRequests = requests.length;
      await Promise.all([...pending.values()].map(({ done }) => done));
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
    } while (pending.size || requests.length !== previousRequests);
  };
  try {
    await page.addInitScript(() => {
      const requestIdle = window.requestIdleCallback.bind(window);
      const cancelIdle = window.cancelIdleCallback.bind(window);
      const callbacks = new Map<
        number,
        { callback: IdleRequestCallback; options?: IdleRequestOptions }
      >();
      let nextId = 0;
      window.requestIdleCallback = (callback, idleOptions) => {
        const id = ++nextId;
        callbacks.set(id, { callback, options: idleOptions });
        return id;
      };
      window.cancelIdleCallback = (id) => {
        callbacks.delete(id);
      };
      window.addEventListener(
        "openclaw:boot-release-idle",
        () => {
          window.requestIdleCallback = requestIdle;
          window.cancelIdleCallback = cancelIdle;
          for (const { callback, options: idleOptions } of callbacks.values()) {
            requestIdle(callback, idleOptions);
          }
          callbacks.clear();
        },
        { once: true },
      );
    });
    const sessionKey = options.mainSession ? "agent:main:main" : bootSessionKey;
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      authMethod: "device-token",
      serverBuildId: options.serverBuildId,
      deferredMethods: ["connect"],
      heldMethods: chat ? ["sessions.messages.subscribe", "chat.startup"] : [],
      sessionKey,
      sessions: [
        createControlUiSessionRow(bootSessionKey, "Existing conversation", 2),
        createControlUiSessionRow("agent:main:main", "Main", 1),
      ],
      historyMessages: [createControlUiChatHistoryMessage("assistant", bootTranscriptText, 1)],
      presenceUsers: [
        {
          self: true,
          id: "boot-reader",
          name: "Boot Reader",
          identity: { type: "profile", id: "boot-reader" },
        },
      ],
      methodResponses: {
        "config.get": {
          raw: "{}",
          hash: "boot-config",
          config: {},
          sourceConfig: {},
          runtimeConfig: {},
        },
        "users.prefs.get": { status: "ok", entries: { "ui.themeMode": "dark" } },
      },
    });
    await page.goto(
      !chat
        ? `${origin}/new`
        : options.mainSession
          ? `${origin}/chat`
          : controlUiSessionUrl(baseUrl, sessionKey),
      { waitUntil: "commit" },
    );
    await gateway.waitForRequest("connect");
    await gateway.resolveDeferred("connect");
    await gateway.waitForRequest("users.prefs.get");
    if (!chat || options.mainSession) {
      await waitForControlUiInitialRoster(page);
    }
    if (chat) {
      await gateway.waitForRequest("sessions.messages.subscribe");
    } else {
      await page.locator(".new-session-page__message").waitFor();
    }
    await drainScripts();
    if (chat) {
      if ((await gateway.getRequests("chat.startup")).length) {
        throw new Error("Chat startup escaped the subscription admission barrier");
      }
      await gateway.resolveDeferred("sessions.messages.subscribe");
      await gateway.waitForRequest("chat.startup", { match: { sessionKey } });
    }
    const startupAt = await page.evaluate((isChat) => {
      if (!isChat) {
        return performance.timeOrigin + performance.now();
      }
      const mark = performance.getEntriesByName("mock-gateway:chat.startup")[0];
      if (!mark) {
        throw new Error("Chat startup request was not timestamped");
      }
      return performance.timeOrigin + mark.startTime;
    }, chat);
    if (chat) {
      await gateway.resolveDeferred("chat.startup");
      await page.getByText(bootTranscriptText, { exact: true }).waitFor();
    }
    const entriesBeforeStartup = await page.evaluate(
      ({ prefix, cutoff }) =>
        performance
          .getEntriesByType("mark")
          .filter(
            (mark) =>
              mark.name.startsWith(prefix) && performance.timeOrigin + mark.startTime <= cutoff,
          )
          .map((mark) => mark.name.slice(prefix.length)),
      { prefix: bootDynamicImportMarkPrefix, cutoff: startupAt },
    );
    return {
      entriesBeforeStartup: new Set(entriesBeforeStartup),
      beforeStartup: new Set(
        requests.filter((request) => request.startedAt <= startupAt).map((request) => request.path),
      ),
      afterStartup: new Set(
        requests.filter((request) => request.startedAt > startupAt).map((request) => request.path),
      ),
    };
  } finally {
    await page.evaluate(() => window.dispatchEvent(new Event("openclaw:boot-release-idle")));
    await network.detach();
  }
}
