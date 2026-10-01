/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-navigation.test/"} */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { navigateChatPage, ownedChatPaneSessionKey } from "./chat-page-navigation.ts";
import {
  createChatPageNavigationContext,
  getRouteDraftForActivePane,
  setNavigationContext,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";

type DraftRecipient = HTMLElement & {
  active: boolean;
  draft?: string;
  onOpenSplitView?: () => void;
  updateComplete: Promise<unknown>;
};

describe("chat page navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
  it.each([
    { scope: "global", key: "global", agentId: "research", expected: "agent:research:main" },
    { scope: "per-sender", key: "global", agentId: "research", expected: "global" },
    {
      scope: "global",
      key: "agent:research:global",
      agentId: "main",
      expected: "agent:research:global",
    },
    { scope: "global", key: "global", agentId: undefined, expected: "global" },
  ] as const)(
    "preserves the $scope meaning of $key with captured owner $agentId",
    ({ scope, key, agentId, expected }) => {
      const { context } = createChatPageNavigationContext();
      context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope,
        agents: [{ id: "main" }, { id: "research" }],
      };
      expect(ownedChatPaneSessionKey(context, key, agentId)).toBe(expected);
    },
  );
  it.each(
    (
      [
        { agentId: "main", face: "chat" },
        { agentId: "main", face: "dashboard" },
        { agentId: "research", face: "chat" },
        { agentId: "research", face: "dashboard" },
      ] as const
    ).flatMap(({ agentId, face }) =>
      [false, true].map((pendingDraft) => ({ agentId, face, pendingDraft })),
    ),
  )(
    "keeps $agentId $face navigation stable when its pane adopts global (pending draft: $pendingDraft)",
    async ({ agentId, face, pendingDraft }) => {
      const search = "?draft=What+can+you+do%3F&__openclawComposerFocus=1&panel=details";
      window.history.replaceState(
        {},
        "",
        `/${face}/${agentId}${pendingDraft ? `${search}#pane` : ""}`,
      );
      const navigation = createChatPageNavigationContext();
      navigation.context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "main" }, { id: "research" }],
      };
      navigation.context.gateway.snapshot.hello = {
        ...gatewayHelloForMethods([]),
        snapshot: {
          sessionDefaults: { defaultAgentId: "main", mainKey: "main", mainSessionKey: "global" },
        },
      };
      navigation.context.agentSelection.set(agentId);
      navigateChatPage(
        navigation.context,
        {
          sessionKey: `agent:${agentId}:main`,
          face,
          ...(pendingDraft ? { draft: "What can you do?", focusComposer: true } : {}),
        },
        "global",
        true,
      );
      expect(navigation.replace).toHaveBeenCalledExactlyOnceWith(face, {
        pathname: `/${face}/${agentId}`,
        ...(pendingDraft ? { search, hash: "#pane" } : {}),
      });
    },
  );
  it.each([
    "route URL",
    "route data",
    "selected pane",
    "hidden page",
    "hidden native window",
    "disconnected page",
    "rejected recipient update",
  ])("keeps the route draft unconsumed after a %s", async (change) => {
    const previousHref = window.location.href;
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;
    const panes = () => [...page.querySelectorAll<DraftRecipient>("openclaw-chat-pane")];
    expectDefined(panes()[0], "classic pane").onOpenSplitView?.();
    await page.updateComplete;
    const recipient = expectDefined(
      panes().find((pane) => pane.active),
      "draft recipient",
    );
    const otherPane = expectDefined(
      panes().find((pane) => pane !== recipient),
      "other pane",
    );
    const accepted = createDeferred();
    const nextAccepted = createDeferred();
    recipient.updateComplete = accepted.promise;
    otherPane.updateComplete = nextAccepted.promise;
    const data = { sessionKey: "main", draft: "pending draft" };
    window.history.replaceState({}, "", "/chat/main?draft=pending+draft&panel=details");
    const updateError = new Error("recipient update failed");
    const errorLog =
      change === "rejected recipient update"
        ? vi.spyOn(console, "error").mockImplementation(() => {})
        : undefined;
    try {
      page.data = data;
      await page.updateComplete;
      expect(recipient.draft).toBe("pending draft");
      expect(navigation.replace).not.toHaveBeenCalled();

      if (change === "route URL") {
        window.history.replaceState({}, "", "/chat/main?draft=newer+draft&panel=next");
      } else if (change === "route data") {
        recipient.updateComplete = nextAccepted.promise;
        page.data = { sessionKey: "main", draft: "newer draft" };
      } else if (change === "selected pane") {
        expectDefined(
          otherPane.closest(".chat-split-view__cell"),
          "other split cell",
        ).dispatchEvent(new Event("pointerdown"));
      } else if (change === "hidden page") {
        page.presented = false;
      } else if (change === "hidden native window") {
        Object.assign(navigation.context, {
          nativeConversation: {
            presentation: { visible: false, active: true },
            subscribe: () => () => {},
          },
        });
        page.requestUpdate();
      } else if (change === "disconnected page") {
        page.remove();
      }
      await page.updateComplete;
      const replacements = navigation.replace.mock.calls.length;
      const currentHref = window.location.href;
      if (change === "selected pane") {
        expect(recipient.active).toBe(false);
        expect(otherPane.active).toBe(true);
      }

      if (change === "rejected recipient update") {
        accepted.reject(updateError);
        await expect(accepted.promise).rejects.toBe(updateError);
      } else {
        accepted.resolve();
        await accepted.promise;
      }
      await page.updateComplete;

      expect(navigation.replace).toHaveBeenCalledTimes(replacements);
      expect(window.location.href).toBe(currentHref);
      expect(getRouteDraftForActivePane(page)).toBe(
        change === "route data" ? "newer draft" : "pending draft",
      );
      if (errorLog) {
        expect(errorLog).toHaveBeenCalledExactlyOnceWith(
          "[openclaw] Route draft recipient update failed",
          updateError,
        );
      }
    } finally {
      page.remove();
      accepted.resolve();
      nextAccepted.resolve();
      await Promise.allSettled([accepted.promise, nextAccepted.promise]);
      errorLog?.mockRestore();
      window.history.replaceState(null, "", previousHref);
    }
  });
});
