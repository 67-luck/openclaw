import type { DatabaseSync } from "node:sqlite";
import {
  migrateDoctorTranscriptStorage,
  type DoctorTranscriptStorageProgress,
} from "./doctor-transcript-storage.js";

/** Stop through the operator's cancellation boundary after one real committed batch. */
export async function runDoctorTranscriptStorageBatch(
  database: DatabaseSync,
): Promise<DoctorTranscriptStorageProgress["result"]> {
  const controller = new AbortController();
  const stopped = new Error("Stopped after a committed transcript metadata batch");
  let result: DoctorTranscriptStorageProgress["result"] | undefined;
  try {
    await migrateDoctorTranscriptStorage(database, {
      signal: controller.signal,
      assertCurrent() {},
      onProgress(progress) {
        result = progress.result;
        controller.abort(stopped);
      },
    });
  } catch (error) {
    if (error !== stopped) {
      throw error;
    }
  }
  if (!result) {
    throw new Error("Expected pending transcript metadata migration work");
  }
  return result;
}
