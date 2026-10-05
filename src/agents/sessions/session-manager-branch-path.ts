import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionEntryNavigation } from "../../config/sessions/session-entry-navigation.js";
import {
  isIndexedSessionEntry,
  migrateToCurrentVersion,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
  partitionSessionFileEntries,
} from "./session-manager-codec.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import type {
  PreservedOpaqueFileEntry,
  SessionEntry,
  SessionHeader,
} from "./session-manager-types.js";

/** One copy algorithm for worker-owned forks and detached/volatile sessions. */
export function prepareBranchedSession(
  events: readonly unknown[],
  leafId: string,
  header: SessionHeader,
) {
  return new BranchPath(events).copy(leafId, header);
}

class BranchPath extends SessionEntryNavigation<SessionEntry> {
  private opaqueFileEntries: PreservedOpaqueFileEntry[];
  constructor(events: readonly unknown[]) {
    super();
    const partitioned = partitionSessionFileEntries(events);
    migrateToCurrentVersion(partitioned.fileEntries, partitioned.fileEntriesByOriginalIndex);
    this.opaqueFileEntries = partitioned.opaqueEntries;
    let opaqueIndex = 0;
    for (let index = 0; index <= partitioned.fileEntries.length; index++) {
      while (this.opaqueFileEntries[opaqueIndex]?.index === index) {
        this.appendOpaqueNavigationRecord(this.opaqueFileEntries[opaqueIndex++]!.record);
      }
      const entry = partitioned.fileEntries[index];
      if (isIndexedSessionEntry(entry)) {
        this.appendCanonicalNavigationEntry(entry);
      }
    }
    this.finishNavigation();
  }

  copy(leafId: string, header: SessionHeader) {
    const path = this.collectBranchedSessionPath(leafId);
    if (path.entries.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }
    const selectedLeafEntryId = path.entries.at(-1)?.id;
    const pathIds = new Set(path.entries.map((entry) => entry.id));
    let parentId = path.tailId;
    for (const [targetId, label] of this.labelsById) {
      if (pathIds.has(targetId)) {
        const entry: SessionEntry = {
          type: "label",
          id: generateSessionEntryId(),
          parentId,
          timestamp: this.labelTimestampsById.get(targetId)!,
          targetId,
          label,
        };
        path.entries.push(entry);
        parentId = entry.id;
      }
    }
    const files = [header, ...path.entries];
    const copied: unknown[] = [];
    let opaqueIndex = 0;
    for (let index = 0; index <= files.length; index++) {
      while (path.opaqueEntries[opaqueIndex]?.index === index) {
        copied.push(path.opaqueEntries[opaqueIndex++]!.record);
      }
      if (files[index]) {
        copied.push(files[index]);
      }
    }
    return { events: copied, selectedLeafEntryId };
  }
  private collectBranchedSessionPath(leafId: string): {
    entries: SessionEntry[];
    opaqueEntries: PreservedOpaqueFileEntry[];
    tailId: string | null;
  } {
    type BranchNode =
      | { type: "entry"; entry: SessionEntry }
      | { type: "opaque"; id: string; record: Record<string, unknown> };

    const opaqueById = new Map<string, Record<string, unknown>>();
    for (const opaqueEntry of this.opaqueFileEntries) {
      const leafEntry = parseOpaqueLeafEntry(opaqueEntry.record);
      const link = leafEntry ?? parseParentLinkedOpaqueEntry(opaqueEntry.record);
      if (link && isRecord(opaqueEntry.record)) {
        opaqueById.set(link.id, opaqueEntry.record);
      }
    }

    const reversedNodes: BranchNode[] = [];
    const seen = new Set<string>();
    let currentId: string | null = leafId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const entry = this.byId.get(currentId);
      if (entry) {
        reversedNodes.push({ type: "entry", entry });
        if (this.logicalParentsById.has(entry.id)) {
          const logicalParentId = this.logicalParentsById.get(entry.id) ?? null;
          let physicalId = entry.parentId;
          while (physicalId && physicalId !== logicalParentId && !seen.has(physicalId)) {
            const physicalRecord = opaqueById.get(physicalId);
            if (!physicalRecord || !this.opaqueParentsById.has(physicalId)) {
              break;
            }
            seen.add(physicalId);
            reversedNodes.push({ type: "opaque", id: physicalId, record: physicalRecord });
            physicalId = this.opaqueParentsById.get(physicalId) ?? null;
          }
          currentId = logicalParentId;
        } else {
          currentId = entry.parentId;
        }
        continue;
      }
      const record = opaqueById.get(currentId);
      if (!record || !this.opaqueParentsById.has(currentId)) {
        break;
      }
      reversedNodes.push({ type: "opaque", id: currentId, record });
      currentId = this.opaqueParentsById.get(currentId) ?? null;
    }

    const entries: SessionEntry[] = [];
    const opaqueEntries: PreservedOpaqueFileEntry[] = [];
    let tailId: string | null = null;
    for (const node of reversedNodes.toReversed()) {
      if (node.type === "entry") {
        if (node.entry.type === "label") {
          continue;
        }
        // This is the selected path in a new session, not an inactive side branch.
        // Its navigation controls are omitted, so copied entries must advance the leaf.
        const branchEntry: SessionEntry = { ...node.entry, parentId: tailId };
        delete branchEntry.appendMode;
        entries.push(branchEntry);
        tailId = branchEntry.id;
        continue;
      }
      if (parseOpaqueLeafEntry(node.record)) {
        continue;
      }
      opaqueEntries.push({
        index: entries.length + 1,
        record: { ...node.record, parentId: tailId },
      });
      tailId = node.id;
    }
    return { entries, opaqueEntries, tailId };
  }
}
