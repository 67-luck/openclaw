import type { WorkshopChangesQuery } from "./changes.kernel.js";
import type { WorkshopChange } from "./library.js";

export type WorkshopChangesWorkerOperations = {
  "skills.workshop.changes.record": { input: WorkshopChange; output: void };
  "skills.workshop.changes.list": { input: WorkshopChangesQuery; output: WorkshopChange[] };
};
