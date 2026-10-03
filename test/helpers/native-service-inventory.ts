import fs from "node:fs/promises";
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import * as loadedUnits from "../../src/daemon/systemd-loaded-unit-inventory.js";
import { resolveSystemdUnitLoadDirectories } from "../../src/daemon/systemd-unit-load-paths.js";

export function isolateNativeServiceInventory(home: string) {
  const loaded = vi.spyOn(loadedUnits, "listLoadedSystemdUnits").mockResolvedValue([]);
  const { userDirs, systemDirs } = resolveSystemdUnitLoadDirectories(
    process.env,
    home,
    process.geteuid?.(),
  );
  const roots = [...userDirs, ...systemDirs, "/Library/LaunchAgents", "/Library/LaunchDaemons"].map(
    (root) => path.normalize(root),
  );
  const fixturePath = (value: string) => {
    const normalized = path.normalize(value);
    // Seeded user units stay real; native directories belong to this fixture too.
    if (normalized === home || normalized.startsWith(`${home}${path.sep}`)) {
      return value;
    }
    return roots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`))
      ? path.join(home, "native", normalized.slice(path.parse(normalized).root.length))
      : value;
  };
  const readdir = fs.readdir;
  const readFile = fs.readFile;
  const directories = vi
    .spyOn(fs, "readdir")
    .mockImplementation((...args: Parameters<typeof fs.readdir>) => {
      if (typeof args[0] === "string") {
        args[0] = fixturePath(args[0]);
      }
      return readdir(...args);
    });
  const files = vi
    .spyOn(fs, "readFile")
    .mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (typeof args[0] === "string") {
        args[0] = fixturePath(args[0]);
      }
      return readFile(...args);
    });
  onTestFinished(() => {
    loaded.mockRestore();
    files.mockRestore();
    directories.mockRestore();
  });
  return fixturePath;
}
