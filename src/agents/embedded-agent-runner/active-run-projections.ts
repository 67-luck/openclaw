/** Shipped SDK names; session activity is owned exclusively by the controller.
 * Internal readers import the controller query module directly. */
export {
  getActiveSessionRunCount as getActiveEmbeddedRunCount,
  listActiveSessionRunKeys as listActiveEmbeddedRunSessionKeys,
  listActiveSessionRunIds as listActiveEmbeddedRunSessionIds,
  resolveActiveSessionRunId as resolveActiveEmbeddedRunSessionId,
} from "../../sessions/session-controller.queries.js";
