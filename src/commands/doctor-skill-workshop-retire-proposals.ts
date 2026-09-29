import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
import { resolveCanonicalWorkspacePath } from "../agents/workspace-state-identity.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isMissingPathError } from "../infra/errors.js";
import { pathExists, root } from "../infra/fs-safe.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { isPathInside } from "../infra/path-guards.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { isUpdateRehearsalReadOnlyPath } from "../infra/update-rehearsal-paths.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { dropRetiredSkillWorkshopProposalTables } from "../state/openclaw-state-db-table-retirements.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

// Retired proposal storage: `<state>/skill-workshop/proposals/<id>/[generations/<uuid>/]PROPOSAL.md`
// plus support files beside the draft; pre-SQLite bundles also carry `proposal.json`.
const LEGACY_PROPOSALS_DIR = path.join("skill-workshop", "proposals");
const LEGACY_PROPOSALS_MANIFEST = path.join("skill-workshop", "proposals.json");
const PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/u;
const DRAFT_FILE_PATTERN =
  /^(?:generations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)?PROPOSAL\.md$/u;
const MAX_EXPORT_FILE_BYTES = 8 * 1024 * 1024;
const EXPORTED_STATUSES = new Set(["pending", "quarantined"]);

type RetiredProposal = {
  id: string;
  ownerAgentId: string | null;
  draftFile: string;
  supportFiles: string[];
};

/** Reads only the export-relevant fields; malformed records keep their tables for manual review. */
function parseRetiredProposal(
  id: string,
  recordJson: string,
  ownerAgentId: string | null,
): RetiredProposal {
  const record: unknown = JSON.parse(recordJson);
  if (!isRecord(record)) {
    throw new Error("proposal record is not an object");
  }
  const { draftFile = "PROPOSAL.md", supportFiles = [] } = record;
  if (typeof draftFile !== "string" || !DRAFT_FILE_PATTERN.test(draftFile)) {
    throw new Error("proposal record has an invalid draft path");
  }
  if (!Array.isArray(supportFiles)) {
    throw new Error("proposal record has invalid support files");
  }
  const supportPaths = supportFiles.map((file: unknown) => {
    const filePath = isRecord(file) ? file.path : undefined;
    if (
      typeof filePath !== "string" ||
      path.posix.isAbsolute(filePath) ||
      filePath.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      filePath === "SKILL.md"
    ) {
      throw new Error("proposal record has an invalid support file path");
    }
    return filePath;
  });
  return { id, ownerAgentId, draftFile, supportFiles: supportPaths };
}

function readDatabaseProposals(env: NodeJS.ProcessEnv): {
  proposals: RetiredProposal[];
  /** Every proposal id with a row, whatever its status; their bundles need no sidecar. */
  recordedIds: Set<string>;
  failures: string[];
  hasTables: boolean;
} {
  const { db } = openOpenClawStateDatabase({ env });
  const hasTables = [
    "skill_workshop_proposals",
    "skill_workshop_proposal_events",
    "skill_workshop_proposal_rollbacks",
    "skill_workshop_collection_reviews",
  ].some((table) => tableExists(db, table));
  if (!tableExists(db, "skill_workshop_proposals")) {
    return { proposals: [], recordedIds: new Set(), failures: [], hasTables };
  }
  const rows = db // sqlite-allow-raw -- Retired table has no generated Kysely type; Doctor reads it once before dropping it.
    .prepare(
      `SELECT proposal_id, record_json, owner_agent_id, status FROM skill_workshop_proposals
        ORDER BY proposal_id`,
    )
    .all();
  const proposals: RetiredProposal[] = [];
  const recordedIds = new Set<string>();
  const failures: string[] = [];
  for (const row of rows) {
    const id = String(row.proposal_id);
    recordedIds.add(id);
    if (!EXPORTED_STATUSES.has(String(row.status))) {
      continue;
    }
    try {
      proposals.push(
        parseRetiredProposal(
          id,
          String(row.record_json),
          typeof row.owner_agent_id === "string" ? row.owner_agent_id : null,
        ),
      );
    } catch (error) {
      failures.push(`Could not read Skill Workshop proposal ${id}: ${String(error)}`);
    }
  }
  return { proposals, recordedIds, failures, hasTables };
}

/**
 * Legacy sidecars carry no owner column: use the recorded origin agent, else the one agent whose
 * workspace or Workshop holds the target skill, else the sole configured agent. A recorded owner
 * that is no longer configured is never reassigned; that bundle stays for manual recovery.
 */
function inferLegacyOwnerAgentId(
  record: Record<string, unknown>,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const agentIds = listAgentIds(config);
  const soleAgentId = agentIds.length === 1 ? agentIds[0] : undefined;
  const origin = isRecord(record.origin) ? record.origin : {};
  const recordedOwner =
    (typeof origin.agentId === "string" && origin.agentId.trim()) ||
    (typeof origin.sessionKey === "string"
      ? parseAgentSessionKey(origin.sessionKey)?.agentId
      : undefined);
  if (recordedOwner) {
    const ownerAgentId = normalizeAgentId(recordedOwner);
    return agentIds.includes(ownerAgentId) ? ownerAgentId : undefined;
  }
  const target = isRecord(record.target) ? record.target : {};
  if (typeof target.skillDir !== "string") {
    return soleAgentId;
  }
  const skillDir = resolveCanonicalWorkspacePath(path.resolve(target.skillDir));
  const claims = agentIds.flatMap((agentId) => {
    const workspaceDir = resolveCanonicalWorkspacePath(
      resolveAgentWorkspaceDir(config, agentId, env),
    );
    return [
      path.join(workspaceDir, "skills"),
      path.join(workspaceDir, ".agents", "skills"),
      resolveCanonicalWorkspacePath(resolveWorkshopSkillsDir(config, agentId, env)),
    ]
      .filter((skillsRoot) => isPathInside(skillsRoot, skillDir))
      .map((skillsRoot) => ({ agentId, skillsRoot }));
  });
  // The innermost skills root wins; agents sharing it make the owner ambiguous.
  const innermost = Math.max(...claims.map(({ skillsRoot }) => skillsRoot.length));
  const owners = new Set(
    claims
      .filter(({ skillsRoot }) => skillsRoot.length === innermost)
      .map(({ agentId }) => agentId),
  );
  return owners.size === 1 ? [...owners][0] : owners.size === 0 ? soleAgentId : undefined;
}

/** Pre-SQLite bundles keep their record in `proposal.json`; SQLite-backed bundles have none. */
async function readLegacyJsonProposals(params: {
  stateDir: string;
  recordedIds: ReadonlySet<string>;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{ proposals: RetiredProposal[]; failures: string[] }> {
  const proposals: RetiredProposal[] = [];
  const failures: string[] = [];
  const stateRoot = await root(params.stateDir);
  for (const entry of await stateRoot.list(LEGACY_PROPOSALS_DIR, { withFileTypes: true })) {
    if (
      !entry.isDirectory ||
      !PROPOSAL_ID_PATTERN.test(entry.name) ||
      params.recordedIds.has(entry.name)
    ) {
      continue;
    }
    const bundleDir = path.join(params.stateDir, LEGACY_PROPOSALS_DIR, entry.name);
    try {
      const read = await stateRoot.read(`${LEGACY_PROPOSALS_DIR}/${entry.name}/proposal.json`, {
        hardlinks: "reject",
        maxBytes: MAX_EXPORT_FILE_BYTES,
        symlinks: "reject",
      });
      const recordJson = read.buffer.toString("utf8");
      const record: unknown = JSON.parse(recordJson);
      if (!isRecord(record) || typeof record.status !== "string") {
        throw new Error("proposal record has no status");
      }
      if (!EXPORTED_STATUSES.has(record.status)) {
        continue;
      }
      const ownerAgentId = inferLegacyOwnerAgentId(record, params.config, params.env);
      if (!ownerAgentId) {
        failures.push(
          `Could not tell which agent owns Skill Workshop proposal ${entry.name}; kept ${bundleDir}. Copy its PROPOSAL.md into the owning agent's workshop skills, delete that directory, then rerun openclaw doctor --fix.`,
        );
        continue;
      }
      proposals.push(parseRetiredProposal(entry.name, recordJson, ownerAgentId));
    } catch (error) {
      failures.push(
        isMissingPathError(error)
          ? `Skill Workshop proposal ${entry.name} has no record; kept ${bundleDir}. Copy anything worth keeping, delete that directory, then rerun openclaw doctor --fix.`
          : `Could not read Skill Workshop proposal ${entry.name}: ${String(error)}`,
      );
    }
  }
  return { proposals, failures };
}

/** Copies one draft bundle; an existing export is never overwritten. */
async function exportProposal(
  proposal: RetiredProposal,
  stateDir: string,
  exportRoot: string,
): Promise<"exported" | "existing" | "missing-draft"> {
  const destination = path.join(exportRoot, proposal.id);
  if (await pathExists(destination)) {
    return "existing";
  }
  const bundleDir = path.join(
    stateDir,
    LEGACY_PROPOSALS_DIR,
    proposal.id,
    path.posix.dirname(proposal.draftFile),
  );
  const readOptions = {
    hardlinks: "reject",
    maxBytes: MAX_EXPORT_FILE_BYTES,
    symlinks: "reject",
  } as const;
  let files: Array<[string, Buffer]>;
  try {
    const bundle = await root(bundleDir);
    files = [["SKILL.md", (await bundle.read("PROPOSAL.md", readOptions)).buffer]];
    for (const supportFile of proposal.supportFiles) {
      files.push([supportFile, (await bundle.read(supportFile, readOptions)).buffer]);
    }
  } catch (error) {
    if (isMissingPathError(error) && !(await pathExists(path.join(bundleDir, "PROPOSAL.md")))) {
      return "missing-draft";
    }
    throw error;
  }
  // Stage beside the destination so a crash never leaves a partial export under the final name.
  const staging = path.join(exportRoot, `.${proposal.id}.partial`);
  await fs.rm(staging, { recursive: true, force: true });
  for (const [relativePath, content] of files) {
    const target = path.join(staging, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { flag: "wx" });
  }
  await fs.rename(staging, destination);
  return "exported";
}

async function retireProposals(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
}): Promise<MigrationMessages> {
  const { config, env, assertCurrent } = params;
  const stateDir = resolveStateDir(env);
  const legacyDirExists = await pathExists(path.join(stateDir, LEGACY_PROPOSALS_DIR));
  const database = readDatabaseProposals(env);
  if (!database.hasTables && !legacyDirExists) {
    return { changes: [], warnings: [] };
  }
  const legacy = legacyDirExists
    ? await readLegacyJsonProposals({
        stateDir,
        recordedIds: database.recordedIds,
        config,
        env,
      })
    : { proposals: [], failures: [] };
  const warnings = [...database.failures, ...legacy.failures];
  // Any unread or unexported proposal keeps the tables and files for the next Doctor run.
  let blocked = warnings.length > 0;
  const changes: string[] = [];
  const exportedIds = new Set<string>();
  const exportedByRoot = new Map<string, number>();
  const defaultAgentId = resolveDefaultAgentId(config);
  for (const proposal of [...database.proposals, ...legacy.proposals]) {
    assertCurrent();
    const exportRoot = path.join(
      resolveWorkshopSkillsDir(config, proposal.ownerAgentId ?? defaultAgentId, env),
      ".archive",
      ".retired-proposals",
    );
    // An update rehearsal must not write outside its copied state; the real Doctor run exports.
    if (isUpdateRehearsalReadOnlyPath(exportRoot, env)) {
      blocked = true;
      continue;
    }
    try {
      await fs.mkdir(exportRoot, { recursive: true });
      const outcome = await exportProposal(proposal, stateDir, exportRoot);
      if (outcome === "missing-draft") {
        warnings.push(
          `Skill Workshop proposal ${proposal.id} has no draft left to export; retired its record.`,
        );
      } else if (outcome === "exported") {
        exportedByRoot.set(exportRoot, (exportedByRoot.get(exportRoot) ?? 0) + 1);
      }
      exportedIds.add(proposal.id);
    } catch (error) {
      blocked = true;
      warnings.push(
        `Could not export Skill Workshop proposal ${proposal.id} to ${exportRoot}: ${String(error)}. Its proposal tables and files are kept; rerun openclaw doctor --fix after fixing the cause.`,
      );
    }
  }
  for (const [exportRoot, count] of exportedByRoot) {
    changes.push(
      `Exported ${count} pending Skill Workshop proposal draft${count === 1 ? "" : "s"} to ${exportRoot}${path.sep}.`,
    );
  }
  if (blocked) {
    return {
      changes,
      warnings,
      ...(warnings.length > 0 ? { warningDisposition: "recoverable" as const } : {}),
    };
  }
  assertCurrent();
  const dropped = runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      // Reread inside the transaction: a proposal written since planning keeps the tables.
      const pending = tableExists(db, "skill_workshop_proposals")
        ? db // sqlite-allow-raw -- Retired table has no generated Kysely type.
            .prepare(
              "SELECT proposal_id FROM skill_workshop_proposals WHERE status IN ('pending', 'quarantined')",
            )
            .all()
        : [];
      if (pending.some((row) => !exportedIds.has(String(row.proposal_id)))) {
        return undefined;
      }
      // Files go before the tables: a crash in between leaves records (whose exports already
      // exist), never recordless bundles that would block the next run.
      if (legacyDirExists) {
        rmSync(path.join(stateDir, LEGACY_PROPOSALS_DIR), { recursive: true, force: true });
        rmSync(path.join(stateDir, LEGACY_PROPOSALS_MANIFEST), { force: true });
      }
      return dropRetiredSkillWorkshopProposalTables(db);
    },
    { env },
    { operationLabel: "doctor.skill-workshop.retire-proposals" },
  );
  if (dropped === undefined) {
    warnings.push(
      "Skill Workshop proposals changed during export; rerun openclaw doctor --fix to finish retiring the proposal tables.",
    );
    return { changes, warnings, warningDisposition: "recoverable" };
  }
  if (dropped) {
    changes.push("Retired the Skill Workshop proposal tables.");
  }
  if (legacyDirExists) {
    changes.push(
      `Removed retired Skill Workshop proposal files from ${path.join(stateDir, LEGACY_PROPOSALS_DIR)}.`,
    );
  }
  return {
    changes,
    warnings,
    ...(warnings.length > 0 ? { warningDisposition: "recoverable" as const } : {}),
  };
}

/**
 * Exports pending and quarantined Skill Workshop proposal drafts into each owning agent's
 * Workshop archive, then drops the retired proposal tables and legacy proposal files.
 */
export async function retireSkillWorkshopProposals(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const env = params.env ?? process.env;
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (maintenance?.ownsSchemaMaintenance) {
    return await maintenance.run(() =>
      retireProposals({
        config: params.config,
        env,
        assertCurrent: () => maintenance.assertOwnerCurrent(),
      }),
    );
  }
  const owner = await acquireGatewayLock({ env, role: "sqlite-maintenance", allowInTests: true });
  if (!owner) {
    throw new Error("Skill Workshop proposal retirement requires exclusive state ownership");
  }
  try {
    return await owner.run(() =>
      retireProposals({ config: params.config, env, assertCurrent: () => owner.assertCurrent() }),
    );
  } finally {
    await owner.release();
  }
}
