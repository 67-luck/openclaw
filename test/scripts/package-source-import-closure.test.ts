import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  collectPackageDistImportErrors,
  collectPackageDistImports,
} from "../../scripts/lib/package-dist-imports.mjs";

it("keeps shipped source scripts and launchers closed over non-dist imports", () => {
  const manifest: { files: string[] } = JSON.parse(readFileSync("package.json", "utf8"));
  // The node bootstrap packs explicit script files from this same allowlist.
  const files = [
    "package.json",
    ...manifest.files.filter(
      (file) =>
        !file.startsWith("!") &&
        !file.startsWith("dist/") &&
        !file.endsWith("/") &&
        !file.includes("*"),
    ),
  ];
  const imports = collectPackageDistImports({
    files,
    readText: (file) => readFileSync(file, "utf8"),
  });

  expect(
    collectPackageDistImportErrors({
      files,
      // Built targets belong to the full tarball check; this gate needs no build.
      imports: imports.filter(({ importedPath }) => !importedPath.startsWith("dist/")),
    }),
  ).toEqual([]);
});
