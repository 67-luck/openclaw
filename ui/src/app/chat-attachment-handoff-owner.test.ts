/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createApplicationChatAttachmentHandoff } from "./chat-attachment-handoff-owner.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import { canReloadControlUiDocument } from "./document-reload-guard.ts";

function fixture() {
  const client = createTestGatewayClient(async () => undefined);
  const connection = createApplicationGateway();
  const { gateway } = connection;
  connection.publish({
    ...gateway.snapshot,
    phase: "connected",
    client,
    selfUser: { id: "owner" },
  });
  const handoff = createApplicationChatAttachmentHandoff(gateway);
  const create = vi.fn(createChatAttachmentHandoff);
  const key = { owner: client, paneId: "pane", scopeKey: "private" };
  const input = {
    ...key,
    incognito: true,
    message: "private draft",
    attachments: [],
    fallbacks: {},
    reviewPrivateDraft: async () => false,
  };
  return { handoff, create, key, input };
}

it("keeps an empty application free of a handoff implementation", () => {
  const { handoff, create, key } = fixture();
  expect(handoff.consume(key)).toBeNull();
  expect(handoff.retainedAttachmentIds([]).size).toBe(0);
  handoff.retireScope(key.scopeKey, Date.now());
  handoff.clearPane(key.paneId);
  handoff.dispose();
  expect(create).not.toHaveBeenCalled();
  expect(canReloadControlUiDocument()).toBe(true);
});

it("retains private input synchronously through one supplied owner", () => {
  const { handoff, create, key, input } = fixture();
  try {
    handoff.prepare(input, create);
    expect(canReloadControlUiDocument()).toBe(false);
    const unused = vi.fn(createChatAttachmentHandoff);
    handoff.prepare({ ...input, paneId: "second", message: "second draft" }, unused);
    expect(create).toHaveBeenCalledOnce();
    expect(unused).not.toHaveBeenCalled();
    expect(handoff.consume(key)?.message).toBe("private draft");
    expect(canReloadControlUiDocument()).toBe(false);
    handoff.clearPane("second");
    expect(canReloadControlUiDocument()).toBe(true);
  } finally {
    handoff.dispose();
  }
});

it.each([false, true])(
  "does not retain late input after disposal (initialized=%s)",
  (initialized) => {
    const { handoff, create, key, input } = fixture();
    if (initialized) {
      handoff.prepare(input, create);
    }
    handoff.dispose();
    handoff.prepare(input, create);
    expect(handoff.consume(key)).toBeNull();
    expect(canReloadControlUiDocument()).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  },
);
