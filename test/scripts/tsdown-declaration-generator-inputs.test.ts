import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTsdownDeclarationGeneratorInputs } from "../../scripts/lib/tsdown-declaration-generator-inputs.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createDeclarationFixture } from "./tsdown-declaration-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("captures worker entrypoint bytes without interpreting runtime code as generator imports", () => {
  const { root, write } = createDeclarationFixture({
    createTempDir: (prefix) => tempDirs.make(prefix),
  });
  const entry = "scripts/write-plugin-sdk-entry-dts.ts";
  const file = join(root, entry);
  const worker = "src/infra/sqlite-worker-transport.worker.ts";
  write(
    worker,
    'const candidate = "runtime-only"; require(candidate); throw new Error(candidate);',
  );
  expect(resolveTsdownDeclarationGeneratorInputs(root, entry)).toContain(join(root, worker));
  appendFileSync(file, '\nimport "missing-generator-package";\n');
  expect(() => resolveTsdownDeclarationGeneratorInputs(root, entry)).toThrow(
    "missing-generator-package",
  );
  write(file, 'const candidate = "unowned-generator"; require(candidate);');
  expect(() => resolveTsdownDeclarationGeneratorInputs(root, entry)).toThrow(
    "Unresolved dynamic module edges in scripts/write-plugin-sdk-entry-dts.ts",
  );
});
