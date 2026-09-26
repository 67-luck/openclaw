import { vi } from "vitest";
import { launchdTestState as state } from "./launchd-state.test-support.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const { createLaunchdFileSystem } = await import("./launchd-fs.test-support.js");
  const wrapped = createLaunchdFileSystem(actual, state);
  return { ...wrapped, default: wrapped };
});
