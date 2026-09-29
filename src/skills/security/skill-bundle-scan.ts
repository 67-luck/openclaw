import { scanSkillContent, scanSource, type SkillScanFinding } from "./scanner.js";

export type SkillBundleScan = {
  critical: number;
  findings: SkillScanFinding[];
};

/** Scans SKILL.md plus support files; support-file paths are checked for literal secrets only. */
export function scanSkillBundle(
  content: string,
  supportFiles: readonly { path: string; content: string }[] = [],
): SkillBundleScan {
  const findings = [
    ...scanSkillContent(content, "SKILL.md"),
    ...scanSource(content, "SKILL.md"),
    ...supportFiles.flatMap((file) => [
      ...scanSkillContent(file.path, "support-file-path").filter(
        (finding) => finding.ruleId === "literal-secret",
      ),
      ...scanSkillContent(file.content, file.path),
      ...scanSource(file.content, file.path),
    ]),
  ];
  return {
    critical: findings.filter((finding) => finding.severity === "critical").length,
    findings,
  };
}

export function assertSkillBundleHasNoLiteralSecrets(scan: SkillBundleScan): void {
  const finding = scan.findings.find((entry) => entry.ruleId === "literal-secret");
  if (!finding) {
    return;
  }
  throw new Error(
    `Skill contains a recognized literal credential in ${finding.file}; replace it with a SecretRef or placeholder.`,
  );
}
