// Wraps fs-safe atomic replacement and move helpers for OpenClaw install flows.
import "./fs-safe-defaults.js";
import fs from "node:fs";
import { replaceFileAtomic as replaceFileAtomicBase } from "@openclaw/fs-safe/atomic";
import type { ReplaceFileAtomicOptions } from "@openclaw/fs-safe/atomic";

export {
  movePathWithCopyFallback,
  replaceDirectoryAtomic,
  replaceFileAtomicSync,
} from "@openclaw/fs-safe/atomic";

type GuardedReplaceFileAtomicOptions = ReplaceFileAtomicOptions & {
  /** Synchronous authority check at the final destination mutation boundary. */
  beforeDestinationMutation?: () => void;
};

/** Atomic file replacement primitive re-exported through the fs-safe defaults shim. */
export async function replaceFileAtomic(options: GuardedReplaceFileAtomicOptions) {
  const { beforeDestinationMutation, ...baseOptions } = options;
  if (!beforeDestinationMutation) {
    return await replaceFileAtomicBase(baseOptions);
  }

  const fileSystem = baseOptions.fileSystem ?? { promises: fs.promises };
  const rename = fileSystem.promises.rename.bind(fileSystem.promises);
  return await replaceFileAtomicBase({
    ...baseOptions,
    // Permission fallbacks can delete or open the destination after additional
    // asynchronous checks. Delegated writes fail closed instead and retry later.
    copyFallbackOnPermissionError: false,
    fileSystem: {
      ...fileSystem,
      promises: {
        ...fileSystem.promises,
        rename: async (source, destination) => {
          beforeDestinationMutation();
          await rename(source, destination);
        },
      },
    },
  });
}
