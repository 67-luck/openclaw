import type { LabelEntry } from "../../agents/sessions/session-manager-types.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { isSessionLabelTargetAdmitted } from "./session-entry-navigation.js";

type LabelAdmissionRow = { seq: number } & (
  | { event: unknown }
  | { unavailable: { id: string; error: SyntaxError } }
);

/** One snapshot's chronological facts can extend to a newly required label without rereading its prefix. */
export class SessionLabelAdmissionReader {
  readonly labels = new Map<number, LabelEntry>();
  private readonly knownIds = new Set<string>();
  private readonly unavailableIds = new Map<string, SyntaxError>();
  private readonly unavailableSequences = new Map<number, SyntaxError>();

  read(rows: Iterable<LabelAdmissionRow>): void {
    for (const row of rows) {
      if ("unavailable" in row) {
        this.unavailableSequences.set(row.seq, row.unavailable.error);
        if (!this.knownIds.has(row.unavailable.id)) {
          this.unavailableIds.set(row.unavailable.id, row.unavailable.error);
        }
        continue;
      }
      const event = row.event;
      if (!isIndexedSessionEntry(event)) {
        continue;
      }
      if (!isSessionLabelTargetAdmitted(event, this.knownIds)) {
        if (event.type === "label") {
          const error = this.unavailableIds.get(event.targetId);
          if (error) {
            this.unavailableSequences.set(row.seq, error);
            if (!this.knownIds.has(event.id)) {
              this.unavailableIds.set(event.id, error);
            }
          }
        }
        continue;
      }
      this.knownIds.add(event.id);
      this.unavailableIds.delete(event.id);
      if (event.type === "label") {
        this.labels.set(row.seq, event);
      }
    }
  }

  assertAvailable(sequences: Iterable<number>): void {
    for (const seq of sequences) {
      const error = this.unavailableSequences.get(seq);
      if (error) {
        throw error;
      }
    }
  }
}
