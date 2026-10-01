import { pathExistsSync } from "@openclaw/fs-safe/advanced";
import { formatCliCommand } from "../cli/command-format.js";

export function assertNoRetiredStateFiles(label: string, paths: readonly string[]): void {
  const existing = paths.filter(pathExistsSync);
  if (existing.length === 0) {
    return;
  }
  throw new Error(
    `${label}: retired files whose last writer predates July 1, 2026: ${existing.join(", ")}. ` +
      `The files were left unchanged. Upgrade through OpenClaw 2026.9.7, run "${formatCliCommand("openclaw doctor --fix")}" on the original host, then retry this upgrade.`,
  );
}
