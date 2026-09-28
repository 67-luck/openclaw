import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type MessageStringEncoding = {
  values: Map<string, unknown>;
  capture: boolean;
};

const rawJSON = "rawJSON" in JSON && typeof JSON.rawJSON === "function" ? JSON.rawJSON : undefined;

export function serializeFrameField(
  name: "payload" | "stateVersion",
  value: unknown,
  messageStrings?: MessageStringEncoding,
  serializeSession?: () => string,
): string {
  // Keep the wrapper for toJSON's property key and reuse its serialized field.
  // Only splice wrappers that still start with that field after inherited toJSON.
  const shareSession =
    serializeSession !== undefined &&
    isRecord(value) &&
    !("toJSON" in value) &&
    !("toJSON" in Object.prototype);
  const field = { [name]: value };
  const sessionJSON = shareSession ? serializeSession() : undefined;
  let payload: unknown;
  const messageObjects = messageStrings ? new WeakSet<object>() : undefined;
  let fieldJSON: string;
  // The presenter owns this fresh envelope; avoid cloning its large receipt surface.
  const session = shareSession ? value.session : undefined;
  if (shareSession) {
    value.session = undefined;
  }
  try {
    fieldJSON = JSON.stringify(
      field,
      messageStrings &&
        function (this: object, key: string, current: unknown): unknown {
          if (this === field) {
            payload = current;
          } else if ((this === payload && key === "message") || messageObjects!.has(this)) {
            if (typeof current === "string" && current.length >= 1024) {
              const encoded = messageStrings.values.get(current);
              if (encoded !== undefined) {
                return encoded;
              }
              if (messageStrings.capture) {
                const prepared = rawJSON!(JSON.stringify(current));
                messageStrings.values.set(current, prepared);
                return prepared;
              }
            } else if (current !== null && typeof current === "object") {
              messageObjects!.add(current);
            }
          }
          return current;
        },
    );
  } finally {
    if (shareSession) {
      value.session = session;
    }
  }
  if (shareSession) {
    const separator = fieldJSON.endsWith("{}}") ? "" : ",";
    return `,${fieldJSON.slice(1, -2)}${separator}"session":${sessionJSON}}`;
  }
  return fieldJSON.startsWith(`{"${name}":`) ? `,${fieldJSON.slice(1, -1)}` : "";
}

export type FrameFields = {
  eventJSON: string;
  stateVersionFragment: string;
};
export function frameWithSequence(
  base: FrameFields,
  seq: number,
  payload: string,
  recipientProfileId?: string,
): string {
  const recipient =
    recipientProfileId === undefined
      ? ""
      : `,"recipientProfileId":${JSON.stringify(recipientProfileId)}`;
  return `{"type":"event","event":${base.eventJSON}${payload},"seq":${seq}${base.stateVersionFragment}${recipient}}`;
}

export const supportsRawJSON = rawJSON !== undefined;
