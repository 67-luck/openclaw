import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { retireSkillWorkshopProposals } from "./doctor-skill-workshop-retire-proposals.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

const GENERATION = "generations/123e4567-e89b-42d3-a456-426614174000";

function write(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

it("exports pending drafts from retired tables and legacy files, then drops the tables once", async () => {
  const root = tempDirs.make("openclaw-retire-proposals-");
  const stateDir = path.join(root, "state");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const mainDir = path.join(root, "main-agent");
  const opsDir = path.join(root, "ops-agent");
  const config: OpenClawConfig = {
    agents: { entries: { main: { default: true, agentDir: mainDir }, ops: { agentDir: opsDir } } },
  };
  const proposalsDir = path.join(stateDir, "skill-workshop", "proposals");
  const mainExports = path.join(mainDir, "workshop-skills", ".archive", ".retired-proposals");
  const opsExports = path.join(opsDir, "workshop-skills", ".archive", ".retired-proposals");

  // Retired shape from an older release, including the review index Doctor must drop first.
  openOpenClawStateDatabase({ env }).db.exec(`
    CREATE TABLE skill_workshop_proposals (
      proposal_id TEXT NOT NULL PRIMARY KEY, record_json TEXT NOT NULL,
      owner_agent_id TEXT, status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE skill_workshop_proposal_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL,
      FOREIGN KEY (proposal_id) REFERENCES skill_workshop_proposals(proposal_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE skill_workshop_proposal_rollbacks (
      proposal_id TEXT NOT NULL PRIMARY KEY,
      FOREIGN KEY (proposal_id) REFERENCES skill_workshop_proposals(proposal_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE skill_workshop_collection_reviews (
      review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL, create_time INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX idx_skill_workshop_collection_reviews_owner_time
      ON skill_workshop_collection_reviews(owner_agent_id, create_time DESC, review_id);
    INSERT INTO skill_workshop_proposals VALUES
      ('pending-procedure-1', '{"draftFile":"${GENERATION}/PROPOSAL.md","supportFiles":[{"path":"references/notes.md"}]}', 'ops', 'pending'),
      ('quarantined-procedure-1', '{"draftFile":"PROPOSAL.md"}', NULL, 'quarantined'),
      ('applied-procedure-1', '{"draftFile":"PROPOSAL.md"}', 'main', 'applied');
    INSERT INTO skill_workshop_proposal_events (proposal_id) VALUES ('pending-procedure-1');
    INSERT INTO skill_workshop_collection_reviews VALUES ('review', 'main', 1);
  `);
  write(path.join(proposalsDir, "pending-procedure-1", GENERATION, "PROPOSAL.md"), "# Pending\n");
  write(
    path.join(proposalsDir, "pending-procedure-1", GENERATION, "references", "notes.md"),
    "notes\n",
  );
  write(path.join(proposalsDir, "quarantined-procedure-1", "PROPOSAL.md"), "# Quarantined\n");
  write(path.join(proposalsDir, "applied-procedure-1", "PROPOSAL.md"), "# Applied\n");
  write(
    path.join(proposalsDir, "legacy-procedure-1", "proposal.json"),
    '{"status":"pending","draftFile":"PROPOSAL.md","origin":{"sessionKey":"agent:main:main"}}',
  );
  write(path.join(proposalsDir, "legacy-procedure-1", "PROPOSAL.md"), "# Legacy\n");
  // An earlier export is never overwritten.
  write(path.join(mainExports, "quarantined-procedure-1", "SKILL.md"), "# Kept export\n");

  await expect(retireSkillWorkshopProposals({ config, env })).resolves.toEqual({
    changes: [
      `Exported 1 pending Skill Workshop proposal draft to ${opsExports}${path.sep}.`,
      `Exported 1 pending Skill Workshop proposal draft to ${mainExports}${path.sep}.`,
      "Retired the Skill Workshop proposal tables.",
      `Removed retired Skill Workshop proposal files from ${proposalsDir}.`,
    ],
    warnings: [],
  });

  const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
  expect(read(opsExports, "pending-procedure-1", "SKILL.md")).toBe("# Pending\n");
  expect(read(opsExports, "pending-procedure-1", "references", "notes.md")).toBe("notes\n");
  expect(read(mainExports, "quarantined-procedure-1", "SKILL.md")).toBe("# Kept export\n");
  expect(read(mainExports, "legacy-procedure-1", "SKILL.md")).toBe("# Legacy\n");
  expect(fs.readdirSync(mainExports).toSorted()).toEqual([
    "legacy-procedure-1",
    "quarantined-procedure-1",
  ]);
  expect(fs.existsSync(proposalsDir)).toBe(false);
  expect(
    openOpenClawStateDatabase({ env })
      .db.prepare(
        `SELECT name FROM sqlite_schema
          WHERE name LIKE 'skill_workshop_proposal%' OR name LIKE '%skill_workshop_collection_reviews%'`,
      )
      .all(),
  ).toEqual([]);

  await expect(retireSkillWorkshopProposals({ config, env })).resolves.toEqual({
    changes: [],
    warnings: [],
  });
});

it("keeps legacy bundles without a provable owner or record until every bundle is exported", async () => {
  const root = tempDirs.make("openclaw-retire-legacy-proposals-");
  const stateDir = path.join(root, "state");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const opsDir = path.join(root, "ops-agent");
  const opsWorkspace = path.join(root, "ops-workspace");
  const config: OpenClawConfig = {
    agents: {
      entries: {
        main: { default: true, agentDir: path.join(root, "main-agent") },
        ops: { agentDir: opsDir, workspace: opsWorkspace },
      },
    },
  };
  const proposalsDir = path.join(stateDir, "skill-workshop", "proposals");
  const opsExports = path.join(opsDir, "workshop-skills", ".archive", ".retired-proposals");
  const bundle = (id: string, record?: object) => {
    write(path.join(proposalsDir, id, "PROPOSAL.md"), `# ${id}\n`);
    if (record) {
      write(path.join(proposalsDir, id, "proposal.json"), JSON.stringify(record));
    }
  };
  // The legacy target skill sits in ops' workspace, which names its owner.
  bundle("workspace-procedure-1", {
    status: "pending",
    target: { skillDir: path.join(opsWorkspace, "skills", "deploy") },
  });
  bundle("unowned-procedure-1", { status: "quarantined" });
  bundle("orphan-procedure-1");

  const first = await retireSkillWorkshopProposals({ config, env });
  expect(first.changes).toEqual([
    `Exported 1 pending Skill Workshop proposal draft to ${opsExports}${path.sep}.`,
  ]);
  expect(first.warningDisposition).toBe("recoverable");
  expect(first.warnings.toSorted()).toEqual([
    expect.stringMatching(
      /^Could not tell which agent owns Skill Workshop proposal unowned-procedure-1;/,
    ),
    expect.stringMatching(/^Skill Workshop proposal orphan-procedure-1 has no record;/),
  ]);
  expect(fs.readFileSync(path.join(opsExports, "workspace-procedure-1", "SKILL.md"), "utf8")).toBe(
    "# workspace-procedure-1\n",
  );
  expect(fs.readdirSync(proposalsDir).toSorted()).toEqual([
    "orphan-procedure-1",
    "unowned-procedure-1",
    "workspace-procedure-1",
  ]);

  // After the operator resolves the flagged bundles, the legacy tree is retired.
  fs.rmSync(path.join(proposalsDir, "orphan-procedure-1"), { recursive: true });
  fs.rmSync(path.join(proposalsDir, "unowned-procedure-1"), { recursive: true });
  await expect(retireSkillWorkshopProposals({ config, env })).resolves.toEqual({
    changes: [`Removed retired Skill Workshop proposal files from ${proposalsDir}.`],
    warnings: [],
  });
  expect(fs.existsSync(proposalsDir)).toBe(false);
});
