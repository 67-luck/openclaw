import type { SkillsWorkshopListResult, SkillWorkshopChange } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import "./skill-workshop-page.ts";
import {
  createContext,
  createRuntimeConfigStub,
  type SkillWorkshopPageTestElement,
} from "./skill-workshop-page.test-support.ts";

const SKILL = "actual-budget-operations";
const VERSION = "20260929T010000000Z-patch";

const list: SkillsWorkshopListResult = {
  agentId: "research",
  mode: "auto",
  root: "/agents/research/workshop-skills",
  skills: [
    {
      name: SKILL,
      description: "Use when reconciling Actual Budget accounts",
      updatedAtMs: Date.now() - 60_000,
      sizeBytes: 900,
      files: ["SKILL.md"],
      useCount: 3,
    },
  ],
  archived: [
    {
      name: SKILL,
      live: true,
      versions: [{ id: VERSION, action: "patch", createdAtMs: Date.now() - 60_000 }],
    },
  ],
};

const change: SkillWorkshopChange = {
  id: "change-1",
  agentId: "research",
  skillName: SKILL,
  action: "patch",
  actor: "review",
  summary: "tightened reconciliation step",
  versionId: VERSION,
  createdAtMs: Date.now() - 60_000,
};

function workshopGateway() {
  return vi.fn(async (method: string) => {
    switch (method) {
      case "skills.workshop.list":
        return list;
      case "skills.workshop.changes":
        return { changes: [change] };
      case "skills.workshop.restore":
        return { change: { ...change, id: "change-2", action: "restore", actor: "user" } };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
}

async function mount(context: ApplicationContext) {
  const page = document.createElement(
    "openclaw-skill-workshop-page",
  ) as SkillWorkshopPageTestElement;
  page.context = context;
  document.body.append(page);
  await page.updateComplete;
  return page;
}

function button(page: HTMLElement, label: string) {
  return Array.from(page.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === label,
  );
}

afterEach(() => document.body.replaceChildren());

describe("Skill Workshop page", () => {
  it("lists learned skills and undoes a change by restoring its saved version", async () => {
    const request = workshopGateway();
    const page = await mount(
      createContext(request, {
        methods: ["skills.workshop.archive", "skills.workshop.restore"],
      }),
    );
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Use when reconciling Actual Budget accounts");
      expect(page.textContent).toContain("tightened reconciliation step");
    });
    expect(request).toHaveBeenCalledWith("skills.workshop.list", { agentId: "research" });

    button(page, "Undo")?.click();

    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "skills.workshop.list"),
      ).toHaveLength(2),
    );
    expect(request).toHaveBeenCalledWith("skills.workshop.restore", {
      agentId: "research",
      name: SKILL,
      versionId: VERSION,
    });
  });

  it("offers no undo to an operator without admin scope", async () => {
    const page = await mount(
      createContext(workshopGateway(), {
        methods: ["skills.workshop.archive", "skills.workshop.restore"],
        scopes: ["operator.read"],
      }),
    );
    await vi.waitFor(() => expect(page.textContent).toContain("tightened reconciliation step"));
    expect(button(page, "Undo")).toBeUndefined();
  });

  it("switches the learning mode through the config key", async () => {
    const runtimeConfig = createRuntimeConfigStub({
      sourceConfig: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    });
    const page = await mount(
      createContext(workshopGateway(), { methods: ["config.patch"], runtimeConfig }),
    );
    expect(button(page, "Auto")?.getAttribute("aria-pressed")).toBe("true");

    button(page, "Off")?.click();

    await vi.waitFor(() => expect(runtimeConfig.refresh).toHaveBeenCalled());
    expect(runtimeConfig.patch).toHaveBeenCalledExactlyOnceWith({
      raw: { skills: { workshop: { autonomous: { mode: "off" } } } },
      note: "Disable Skill Workshop learning",
    });
  });
});
