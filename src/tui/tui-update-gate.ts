import { runCliRespawnPlan } from "../entry.respawn.js";
import {
  announceLocalTuiClient,
  waitForLocalTuiUpdate,
  type LocalTuiUpdateAnnouncement,
} from "../infra/local-tui-processes.js";
import { formatOpenClawProcessTitle } from "../infra/openclaw-installation-id.js";
import {
  resolveOpenClawPackageRootSync,
  rewritePnpmVersionedOpenClawEntryPath,
} from "../infra/openclaw-root.js";

async function respawnTuiFromCurrentInstallation(): Promise<never> {
  const [entryArg, ...entryArgs] = process.argv.slice(1);
  runCliRespawnPlan({
    command: process.execPath,
    argv: [
      ...process.execArgv,
      ...(entryArg ? [rewritePnpmVersionedOpenClawEntryPath(entryArg)] : []),
      ...entryArgs,
    ],
    env: { ...process.env },
    detachForProcessTree: false,
  });
  // The attached child now owns this terminal. Keep the stale parent alive only
  // to bridge its signals and exit status; it must never import replaced chunks.
  return await new Promise<never>(() => {});
}

/** Loads the TUI graph only after this installation is no longer being replaced. */
async function loadTuiAfterUpdateGate(): Promise<{
  tui?: typeof import("./tui.js");
  announcement?: LocalTuiUpdateAnnouncement;
  waitedForUpdate: boolean;
}> {
  const targetRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
  });
  if (!targetRoot) {
    throw new Error("Unable to identify this OpenClaw installation before TUI startup.");
  }
  const previousProcessTitle = process.title;
  let announcement: LocalTuiUpdateAnnouncement | undefined;
  const { waitedForUpdate } = await waitForLocalTuiUpdate(
    targetRoot,
    undefined,
    undefined,
    async () => {
      process.title = formatOpenClawProcessTitle("openclaw-tui", targetRoot);
      announcement =
        process.platform === "win32" ? await announceLocalTuiClient(targetRoot) : undefined;
      return async () => {
        await announcement?.release();
        announcement = undefined;
        process.title = previousProcessTitle;
      };
    },
  ).catch(async (error: unknown) => {
    await announcement?.release();
    process.title = previousProcessTitle;
    throw error;
  });
  if (waitedForUpdate) {
    await announcement?.release();
    process.title = previousProcessTitle;
    return { waitedForUpdate: true };
  }
  try {
    return { tui: await import("./tui.js"), announcement, waitedForUpdate: false };
  } catch (error) {
    await announcement?.release();
    throw error;
  }
}

export async function withTuiAfterUpdateGate<T>(
  run: (tui: typeof import("./tui.js")) => Promise<T>,
): Promise<{ status: "ran"; value: T } | { status: "updated" }> {
  const { tui, announcement, waitedForUpdate } = await loadTuiAfterUpdateGate();
  // Nested owners must unwind their resources after an update. Replaying their
  // original argv here would restart onboarding or setup before cleanup finishes.
  if (waitedForUpdate || !tui) {
    return { status: "updated" };
  }
  try {
    return { status: "ran", value: await run(tui) };
  } finally {
    await announcement?.release();
  }
}

export async function runTuiAfterUpdateGate(
  options: Parameters<typeof import("./tui.js").runTui>[0],
): ReturnType<typeof import("./tui.js").runTui> {
  const result = await withTuiAfterUpdateGate(async ({ runTui }) => await runTui(options));
  return result.status === "ran" ? result.value : await respawnTuiFromCurrentInstallation();
}

/** Runs a nested TUI without replaying its owning command after a crossed update. */
export async function runNestedTuiAfterUpdateGate(
  options: Parameters<typeof import("./tui.js").runTui>[0],
): Promise<Awaited<ReturnType<typeof import("./tui.js").runTui>> | undefined> {
  const result = await withTuiAfterUpdateGate(async ({ runTui }) => await runTui(options));
  return result.status === "ran" ? result.value : undefined;
}
