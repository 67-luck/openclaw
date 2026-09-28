import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { StateVersionSchema } from "./snapshot.js";

/** One unchanged, viewer-scoped sessions.changed receipt inside an ordered bundle. */
export const SessionsChangedReceiptSchema = closedObject({
  payload: Type.Unknown(),
  stateVersion: Type.Optional(StateVersionSchema),
});

/** Negotiated transport grouping; every receipt remains independently observable. */
export const SessionsChangedBundleEventSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  receipts: Type.Array(SessionsChangedReceiptSchema, { minItems: 1, maxItems: 32 }),
});

export type SessionsChangedBundleEvent = Static<typeof SessionsChangedBundleEventSchema>;
