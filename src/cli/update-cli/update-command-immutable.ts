import fs from "node:fs/promises";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "../../infra/package-update-activation-paths.js";
import { resolveUpdateRoot, type UpdateCommandOptions } from "./shared.js";

/**
 * Stable does not own beta's immutable installation format. Refuse it before the
 * mutable updater can touch the selected installation; ordinary installs keep
 * using the stable update path.
 */
export async function tryRunImmutableUpdateCommand(opts: UpdateCommandOptions): Promise<boolean> {
  const root = opts.sourceUpdate?.root ?? (await resolveUpdateRoot());
  const control = resolvePackageActivationControl(resolvePackageActivationAnchor(root));
  try {
    await fs.lstat(control);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  throw new Error(
    "This installation uses a newer immutable update format. Its current generation remains unchanged; update it with the version that adopted it.",
  );
}
