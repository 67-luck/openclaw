import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { InputProvenanceSchema } from "../../../../packages/gateway-protocol/src/schema/primitives.js";
import { isChatStopCommand } from "./run-lifecycle.ts";

/** Saved agent/system data is not a fresh instruction from the current user. */
export function isChatRecoveryInputSendable(message: unknown): boolean {
  const row = asOptionalRecord(message);
  return (
    row?.role === "user" &&
    (row.provenance == null ||
      (Value.Check(InputProvenanceSchema, row.provenance) &&
        row.provenance.kind === "external_user"))
  );
}

/** Display payloads omit media bytes. Only the native outbox can retry rich input. */
export function readChatRecoveryPayload(
  message: unknown,
  mode: "complete" | "preview" = "complete",
): string | null {
  const row = asOptionalRecord(message);
  const metadata = asOptionalRecord(row?.["__openclaw"]);
  if (
    !row ||
    !isChatRecoveryInputSendable(row) ||
    (mode === "complete" &&
      ((metadata?.truncated !== undefined && metadata.truncated !== false) ||
        metadata?.reason === "display-cap" ||
        metadata?.reason === "oversized")) ||
    [row, metadata].some(
      (record) =>
        record &&
        [
          "media",
          "attachments",
          "openclawDelivery",
          "replyToId",
          "mentions",
          "humanMentions",
          "workContext",
        ].some((key) => record[key] != null),
    )
  ) {
    return null;
  }
  const content =
    typeof row.content === "string" ? [{ type: "text", text: row.content }] : row.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const value of content) {
    const block = asOptionalRecord(value);
    if (block?.type !== "text" || typeof block.text !== "string" || block.omitted === true) {
      return null;
    }
    parts.push(block.text);
  }
  const text = parts.join("\n");
  return text.trim() && !/^\s*[!/]/u.test(text) && !isChatStopCommand(text) ? text : null;
}
