import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getTrustedSafeBinDirs } from "../infra/exec-safe-bin-trust.js";
import { canBindHostInspection } from "./bash-tools.exec-host-spawn.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === "win32")("inspection shell envelope", () => {
  it.each(["zsh", "tcsh", "bash"])(
    "rejects startup, unknown, or PATH-selected %s transports",
    (name) => {
      const root = fs.realpathSync(tempDirs.make("inspection-shell-"));
      const shell = path.join(root, name);
      fs.writeFileSync(shell, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      vi.stubEnv("SHELL", name === "bash" ? name : shell);
      expect(
        canBindHostInspection({
          command: "grep security.audit.suppressions fixture.json",
          workdir: root,
          env: { PATH: "/usr/bin:/bin" },
          // Even an explicitly trusted fixture path cannot waive shell startup semantics.
          trustedSafeBinDirs: getTrustedSafeBinDirs({ extraDirs: [root] }),
        }),
      ).toBe(false);
    },
  );
});
