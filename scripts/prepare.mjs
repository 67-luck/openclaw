// Source-checkout preparation; published packages use prepare-git-hooks.mjs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configurePrepareGitHooks } from "./prepare-git-hooks.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

if (existsSync(join(packageRoot, "src/state/openclaw-state-schema.sql"))) {
  const { ensureKyselyTypes } = await import("./generate-kysely-types.mts");
  await ensureKyselyTypes(packageRoot);
}
configurePrepareGitHooks();
