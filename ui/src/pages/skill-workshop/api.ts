import type {
  SkillsWorkshopChangesResult,
  SkillsWorkshopListResult,
  SkillWorkshopChange,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type WorkshopSnapshot = {
  list: SkillsWorkshopListResult;
  changes: SkillWorkshopChange[];
};

const CHANGE_FEED_LIMIT = 50;

export async function loadWorkshopSnapshot(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<WorkshopSnapshot> {
  const [list, { changes }] = await Promise.all([
    client.request<SkillsWorkshopListResult>("skills.workshop.list", { agentId }),
    client.request<SkillsWorkshopChangesResult>("skills.workshop.changes", {
      agentId,
      limit: CHANGE_FEED_LIMIT,
    }),
  ]);
  return { list, changes };
}

export type WorkshopMutation =
  | { method: "skills.workshop.archive"; name: string }
  | { method: "skills.workshop.restore"; name: string; versionId?: string };

/** Undo reverts to the version saved before the change; a creation has none, so it archives. */
export function undoMutationFor(change: SkillWorkshopChange): WorkshopMutation | null {
  if (change.versionId) {
    return {
      method: "skills.workshop.restore",
      name: change.skillName,
      versionId: change.versionId,
    };
  }
  return change.action === "create"
    ? { method: "skills.workshop.archive", name: change.skillName }
    : null;
}
