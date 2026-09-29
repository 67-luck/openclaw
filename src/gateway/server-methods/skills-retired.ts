import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

export const SKILL_PROPOSALS_RETIRED_MESSAGE =
  "Skill Workshop proposals are retired. Workshop changes apply immediately and are undoable: use skills.workshop.list/changes/read/archive/restore (CLI: openclaw skills workshop ...).";
export const SKILL_CURATOR_RETIRED_MESSAGE =
  "Skill curator methods are retired. Use skills.workshop.list for Workshop skills, usage, and saved versions, and skills.workshop.archive/restore to change them (CLI: openclaw skills workshop ...).";

const RETIRED_METHODS: Record<string, string> = {
  "skills.proposals.list": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.inspect": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.historyStatus": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.historyScan": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.create": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.update": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.revise": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.requestRevision": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.apply": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.reject": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.quarantine": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.events.list": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.proposals.evaluate": SKILL_PROPOSALS_RETIRED_MESSAGE,
  "skills.curator.status": SKILL_CURATOR_RETIRED_MESSAGE,
  "skills.curator.pin": SKILL_CURATOR_RETIRED_MESSAGE,
  "skills.curator.unpin": SKILL_CURATOR_RETIRED_MESSAGE,
  "skills.curator.restore": SKILL_CURATOR_RETIRED_MESSAGE,
};

/** Retired methods stay registered (the catalog is append-only) so old clients get guidance. */
export const skillsRetiredHandlers: GatewayRequestHandlers = Object.fromEntries(
  Object.entries(RETIRED_METHODS).map(([method, message]): [string, GatewayRequestHandler] => [
    method,
    ({ respond }) => respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message)),
  ]),
);
