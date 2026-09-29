import { consumeRootCommandOptionToken } from "./cli-root-options.js";
import { hasUnquotedShellExpansionSource } from "./command-analysis/risks.js";
import type { AllowAlwaysPersistenceDecision } from "./exec-approvals-contracts.js";
// Resolves exec approval requirements and approval-decision availability.
import {
  normalizeExecAsk,
  type ExecApprovalDecision,
  type ExecApprovalUnavailableDecision,
  type ExecAsk,
  type ExecSecurity,
} from "./exec-approvals-core.js";
import type { ExecAuthorizationPlan } from "./exec-authorization-plan.js";
import { parseExecArgvToken, type CommandResolution } from "./exec-command-resolution.js";
import { getTrustedSafeBinDirs, isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";
import { resolveEnvironmentValue } from "./process-env.js";
import { hasPosixShellStartupBeforeInlineCommand } from "./shell-wrapper-resolution.js";
import { analyzeWindowsShellCommand, tokenizeWindowsSegment } from "./windows-shell-command.js";

export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied?: boolean;
}): boolean {
  if (params.ask === "always") {
    return true;
  }
  if (params.durableApprovalSatisfied === true) {
    return false;
  }
  return (
    params.ask === "on-miss" &&
    params.security === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied)
  );
}

function normalizeCommandName(value: string | undefined): string {
  return (value ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function textMentionsSecurityAuditSuppressions(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("security.audit.suppressions") ||
    /["']?security["']?[\s\S]{0,200}["']?audit["']?[\s\S]{0,200}["']?suppressions["']?/.test(
      normalized,
    )
  );
}

function isReadOnlySecurityAuditSuppressionInspection(argv: string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  let offset = command === "pnpm" && argv[1] === "openclaw" ? 1 : 0;
  if (normalizeCommandName(argv[offset]) !== "openclaw") {
    return false;
  }
  offset += 1;
  while (offset < argv.length) {
    const consumed = consumeRootCommandOptionToken(argv, offset);
    if (!consumed) {
      break;
    }
    offset += consumed;
  }
  return (
    argv[offset] === "config" && ["get", "schema", "validate"].includes(argv[offset + 1] ?? "")
  );
}

// These are inspection semantics, not an exec allowlist. Unknown options stay
// approval-gated; in particular rg can launch programs via --pre/--hostname-bin
// or decompression. Do not infer read-only behavior from an executable grant.
const RIPGREP_INSPECTION_OPTIONS = {
  boolean:
    "-n -N -l -L -i -s -S -F -w -x -v -c -q -o -H -I -a -U -u --hidden --files --no-ignore --no-ignore-vcs --fixed-strings --line-number --files-with-matches --files-without-match --count --only-matching --no-heading --heading --json --no-config --no-messages --follow",
  value:
    "-e -f -g -t -T -m -A -B -C --regexp --file --glob --iglob --type --type-not --max-count --after-context --before-context --context --max-depth --encoding --color --sort --sortr",
};

function isReadOnlyFileInspection(argv: string[], env?: NodeJS.ProcessEnv): boolean {
  const command = normalizeCommandName(argv[0]);
  if (command === "sed") {
    // Only a print-only script followed by filenames, never -e/-f/-i or scripts
    // that can write files or launch commands.
    return (
      argv[1] === "-n" &&
      /^(\d+|\$)(,(\d+|\$))?p$/.test(argv[2] ?? "") &&
      argv.slice(3).every((arg) => !arg.startsWith("-"))
    );
  }
  if (["cat", "grep", "head", "tail", "wc"].includes(command)) {
    return true;
  }
  if (command !== "rg") {
    return false;
  }
  const booleanFlags = new Set(RIPGREP_INSPECTION_OPTIONS.boolean.split(" "));
  const valueFlags = new Set(RIPGREP_INSPECTION_OPTIONS.value.split(" "));
  let noRipgrepConfig = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = parseExecArgvToken(argv[i] ?? "");
    if (token.kind === "terminator") {
      break;
    }
    if (token.kind !== "option") {
      continue;
    }
    const flags = token.style === "long" ? [token.flag] : token.flags;
    for (const [index, flag] of flags.entries()) {
      const attached =
        token.style === "long" ? token.inlineValue !== undefined : index < flags.length - 1;
      if (valueFlags.has(flag)) {
        if (!attached && ++i >= argv.length) {
          return false;
        }
        break;
      }
      if (!booleanFlags.has(flag) || (token.style === "long" && attached)) {
        return false;
      }
      noRipgrepConfig ||= flag === "--no-config";
    }
  }
  return (
    noRipgrepConfig ||
    !(
      resolveEnvironmentValue(env, "RIPGREP_CONFIG_PATH") ??
      resolveEnvironmentValue(process.env, "RIPGREP_CONFIG_PATH")
    )
  );
}

function isTrustedInspectionCommand(
  resolution: CommandResolution | null | undefined,
  trustedDirs?: ReadonlySet<string>,
): boolean {
  // Effective executable identity cannot attest the dispatch wrappers that launch it.
  if (!resolution || resolution.policyBlocked || resolution.wrapperChain?.length) {
    return false;
  }
  const executable = resolution.execution;
  const dirs = trustedDirs ?? getTrustedSafeBinDirs({ safeBins: [executable.executableName] });
  return [executable.resolvedPath, executable.resolvedRealPath].every(
    (resolvedPath) => resolvedPath && isTrustedSafeBinPath({ resolvedPath, trustedDirs: dirs }),
  );
}

export function commandRequiresSecurityAuditSuppressionApproval(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  segments: Array<{ argv: string[]; raw?: string }>;
  originalArgv?: string[];
  analysisOk?: boolean;
  authorizationPlan?: ExecAuthorizationPlan;
  trustedSafeBinDirs?: ReadonlySet<string>;
  transportResolution?: CommandResolution;
  /** Remote preflight cannot resolve node executables; the node checks trust at dispatch. */
  deferReaderTrustToNode?: boolean;
}): boolean {
  if (
    !textMentionsSecurityAuditSuppressions(params.command) &&
    !textMentionsSecurityAuditSuppressions(params.originalArgv?.join(" ") ?? "") &&
    !params.segments.some((segment) =>
      textMentionsSecurityAuditSuppressions(segment.argv.join(" ")),
    )
  ) {
    return false;
  }
  if (
    hasPosixShellStartupBeforeInlineCommand(params.originalArgv ?? []) ||
    (params.transportResolution &&
      !params.deferReaderTrustToNode &&
      !isTrustedInspectionCommand(params.transportResolution, params.trustedSafeBinDirs))
  ) {
    return true;
  }
  const plan = params.authorizationPlan;
  if (plan === undefined) {
    // Shipped SDK callers omit analysis metadata; revalidate their direct source.
    // Windows wrappers must never inherit the exception from a stripped payload.
    const [segment] = params.segments;
    const argv = tokenizeWindowsSegment(params.command) ?? [];
    const analysisOk =
      params.analysisOk === undefined ? analyzeWindowsShellCommand(params).ok : params.analysisOk;
    return !(
      analysisOk &&
      params.segments.length === 1 &&
      (segment?.raw ?? segment?.argv.join(" "))?.trim() === params.command.trim() &&
      argv.length === segment?.argv.length &&
      argv.every((arg, index) => arg === segment?.argv[index]) &&
      isReadOnlySecurityAuditSuppressionInspection(argv)
    );
  }
  if (!plan.ok || plan.originalCommand !== params.command || plan.groups.length === 0) {
    return true;
  }
  // A parsed prefix or a reader feeding a writer cannot exempt the whole command.
  return !plan.groups.every(
    (group) =>
      group.candidates.length > 0 &&
      group.candidates.every((candidate) => {
        const argv = candidate.sourceSegment.sourceArgv ?? candidate.sourceSegment.argv;
        const execution = candidate.sourceSegment.resolution?.execution;
        const configRead = isReadOnlySecurityAuditSuppressionInspection(argv);
        const wrapper =
          candidate.transport.kind === "shell-wrapper"
            ? candidate.transport.wrapperSegment
            : undefined;
        return (
          candidate.trustMode === "executable" &&
          candidate.reasons.every((reason) => reason === "inline-eval") &&
          (!wrapper ||
            !hasPosixShellStartupBeforeInlineCommand(wrapper.sourceArgv ?? wrapper.argv)) &&
          ((plan.dialect === "argv" && candidate.transport.kind === "direct") ||
            !hasUnquotedShellExpansionSource(candidate.sourceStep.text)) &&
          (configRead || isReadOnlyFileInspection(argv, params.env)) &&
          (params.deferReaderTrustToNode ||
            !wrapper ||
            isTrustedInspectionCommand(wrapper.resolution, params.trustedSafeBinDirs)) &&
          (configRead ||
            params.deferReaderTrustToNode ||
            (isTrustedInspectionCommand(
              candidate.sourceSegment.resolution,
              params.trustedSafeBinDirs,
            ) &&
              normalizeCommandName(argv[0]) === normalizeCommandName(execution?.resolvedRealPath)))
        );
      }),
  );
}

export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  const order: Record<ExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[a] <= order[b] ? a : b;
}

export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[a] >= order[b] ? a : b;
}

export const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];
export const OPTIONAL_EXEC_APPROVAL_DECISIONS = [
  "allow-always",
] as const satisfies readonly ExecApprovalDecision[];
const OPTIONAL_EXEC_APPROVAL_DECISION_SET: ReadonlySet<string> = new Set(
  OPTIONAL_EXEC_APPROVAL_DECISIONS,
);

function isOptionalExecApprovalDecision(
  decision: string,
): decision is ExecApprovalUnavailableDecision {
  return OPTIONAL_EXEC_APPROVAL_DECISION_SET.has(decision);
}

function collectExecApprovalUnavailableDecisionSet(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): ReadonlySet<ExecApprovalUnavailableDecision> {
  const unavailable = new Set<ExecApprovalUnavailableDecision>();
  if (!Array.isArray(decisions)) {
    return unavailable;
  }
  for (const decision of decisions) {
    if (isOptionalExecApprovalDecision(decision)) {
      unavailable.add(decision);
    }
  }
  return unavailable;
}

export function normalizeExecApprovalUnavailableDecisions(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): readonly ExecApprovalUnavailableDecision[] {
  const unavailable = collectExecApprovalUnavailableDecisionSet(decisions);
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => unavailable.has(decision));
}

export function resolveExecApprovalAllowedDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalDecision[] {
  const ask = normalizeExecAsk(params?.ask);
  if (ask === "always" || params?.allowAlwaysPersistence?.kind === "one-shot") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function resolveExecApprovalUnavailableDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalUnavailableDecision[] {
  const allowed = new Set(resolveExecApprovalAllowedDecisions(params));
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => !allowed.has(decision));
}

export function resolveExecApprovalRequestAllowedDecisions(params?: {
  ask?: string | null;
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const policyDecisions = resolveExecApprovalAllowedDecisions({ ask: params?.ask });
  const unavailableDecisions = collectExecApprovalUnavailableDecisionSet(
    params?.unavailableDecisions,
  );
  if (unavailableDecisions.size === 0) {
    return policyDecisions;
  }
  return policyDecisions.filter(
    (decision) => !isOptionalExecApprovalDecision(decision) || !unavailableDecisions.has(decision),
  );
}

export function isExecApprovalDecisionAllowed(params: {
  decision: ExecApprovalDecision;
  ask?: string | null;
}): boolean {
  return resolveExecApprovalAllowedDecisions({ ask: params.ask }).includes(params.decision);
}
