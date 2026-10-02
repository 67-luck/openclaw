import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { runFixtureGit as git } from "../../infra/update-runner-git-candidate.test-support.js";

export function readDatabase(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get()?.user_version,
      rows: db.prepare("SELECT rowid, value FROM payload ORDER BY rowid").all(),
      columns: db
        .prepare("PRAGMA table_info(payload)")
        .all()
        .map((column) => column.name),
    };
  } finally {
    db.close();
  }
}

export async function writeDatabaseRollbackPackage(params: {
  root: string;
  version: string;
  schemaVersions: { state: number; agent: number };
  source: string;
}) {
  const { root, version, schemaVersions, source } = params;
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      packageManager: "pnpm@12.0.0",
      type: "module",
      version,
      openclaw: { schemaVersions },
    }),
  );
  await fs.writeFile(path.join(root, "dist/index.js"), source);
  const worker = path.join(
    root,
    "dist",
    runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
  );
  await fs.mkdir(path.dirname(worker), { recursive: true });
  const entry = path
    .relative(path.dirname(worker), path.join(root, "dist/index.js"))
    .split(path.sep)
    .join("/");
  await fs.writeFile(worker, `import ${JSON.stringify(entry)};\n`);
}

export async function writeDatabaseRollbackGitRuntime(root: string) {
  const sha = await git(root, "rev-parse", "HEAD");
  const dist = path.join(root, "dist");
  await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dist, "build-info.json"), JSON.stringify({ commit: sha, buildId: sha })),
    fs.writeFile(path.join(dist, ".buildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, ".runtime-postbuildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, "control-ui", "index.html"), "ready"),
    fs.writeFile(path.join(dist, "entry.js"), "import './index.js';\n"),
  ]);
}
