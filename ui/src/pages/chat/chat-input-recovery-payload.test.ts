import { expect, it } from "vitest";
import {
  isChatRecoveryInputSendable,
  readChatRecoveryPayload,
} from "./chat-input-recovery-payload.ts";

it.each([{ role: "user" }, { role: "user", provenance: { kind: "external_user" } }])(
  "accepts complete plain user text ($provenance)",
  (source) => {
    expect(readChatRecoveryPayload({ ...source, content: "Literal [truncated] text" })).toBe(
      "Literal [truncated] text",
    );
    expect(
      readChatRecoveryPayload({
        ...source,
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  },
);

it.each([
  { role: "assistant" },
  { role: "system" },
  {},
  ...["inter_session", "internal_system", "unknown"].map((kind) => ({
    role: "user",
    provenance: { kind },
  })),
  ...[
    false,
    42,
    "external_user",
    {},
    [],
    { kind: "external_user", sourceTool: 4 },
    { kind: "external_user", sourceRole: "assistant" },
  ].map((provenance) => ({ role: "user", provenance })),
])("rejects non-user or untrusted provenance: %j", (source) => {
  expect(isChatRecoveryInputSendable(source)).toBe(false);
  expect(readChatRecoveryPayload({ ...source, content: "Do not promote this" })).toBeNull();
});

it.each([
  { content: "" },
  { content: "  " },
  { content: "/stop" },
  { content: "  !command" },
  { content: "stop" },
  { content: null },
  { content: [] },
  { content: [{ type: "text", text: "part", omitted: true }] },
  ...["image", "audio", "video", "custom"].map((type) => ({
    content: [
      { type: "text", text: "caption" },
      { type, omitted: true },
    ],
  })),
  ...[true, "false", {}].map((truncated) => ({ __openclaw: { truncated } })),
  ...["display-cap", "oversized"].map((reason) => ({ __openclaw: { truncated: false, reason } })),
  ...[
    "media",
    "attachments",
    "openclawDelivery",
    "replyToId",
    "mentions",
    "humanMentions",
    "workContext",
  ].flatMap((key) => [{ [key]: [] }, { __openclaw: { [key]: {} } }]),
])("rejects incomplete or metadata-bearing display payload: %j", (patch) => {
  expect(readChatRecoveryPayload({ role: "user", content: "Full prompt", ...patch })).toBeNull();
});
