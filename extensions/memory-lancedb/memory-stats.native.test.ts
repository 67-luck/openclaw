import { describe, expect, test } from "vitest";
import { loadLanceDbModule } from "./lancedb-runtime.js";
import { MemoryDB } from "./lancedb-store.js";
import { readMemoryStats } from "./memory-stats.js";
import { installTmpDirHarness } from "./test-helpers.js";

describe("native statistics reader source entry", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-stats-" });

  test("keeps an empty store table-free and counts only the selected agent's current rows", async () => {
    const source = { dbPath: getDbPath() };
    await expect(readMemoryStats(source, "alpha")).resolves.toBe(0);
    const connection = await (await loadLanceDbModule()).connect(source.dbPath);
    try {
      expect(await connection.tableNames()).toEqual([]);
    } finally {
      connection.close();
    }
    const db = new MemoryDB(source.dbPath, 2);
    try {
      const entry = {
        text: "private preference",
        vector: [1, 0],
        importance: 0.5,
        category: "fact" as const,
      };
      await db.store("alpha", entry);
      await db.store("beta", entry);
      await expect(readMemoryStats(source, "alpha")).resolves.toBe(1);
      const external = new MemoryDB(source.dbPath, 2);
      try {
        await external.store("alpha", entry);
      } finally {
        external.close();
      }
      await expect(readMemoryStats(source, "alpha")).resolves.toBe(2);
      await expect(db.list("beta")).resolves.toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
