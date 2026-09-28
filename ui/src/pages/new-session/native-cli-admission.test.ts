import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import type { NewSessionRouteData } from "./location.ts";
import { page } from "./route.ts";
import "./new-session-page-entry.ts";

const models = [{ id: "model-one", name: "Model One", provider: "example" }];
const catalogResult = (id = "anthropic", capable = true, hosts = true) => ({
  catalogs: [
    {
      id,
      label: "Native CLI",
      capabilities: { startTerminal: capable },
      hosts: hosts ? [{ hostId: "gateway:local", label: "Gateway", canStartTerminal: true }] : [],
    },
  ],
});

// The picker action uses DraftPlaceState's real navigation callback, then the registered loader.
async function fixture(catalogId = "anthropic") {
  const probe = createDeferred<unknown>();
  const f = createDraftFixture({
    methods: ["sessions.catalog.list"],
    modelCatalog: async () => ({ models }),
    request: async (method, params) =>
      method === "sessions.catalog.list"
        ? (params as { metadataOnly?: boolean }).metadataOnly
          ? catalogResult(catalogId)
          : probe.promise
        : {},
  });
  const gateway = createApplicationGateway(f.context.gateway.snapshot);
  Object.assign(f.context, { gateway: gateway.gateway });
  Object.assign(f.context.agents.state, {
    connected: true,
    client: gateway.gateway.snapshot.client,
  });
  Object.assign(f.context, { chatAttachmentHandoff: createChatAttachmentHandoff(gateway.gateway) });
  let loaded: Promise<NewSessionRouteData> | undefined;
  const navigate: typeof f.context.navigate = vi.fn((_route, options) => {
    loaded = page.loader!(f.context, {
      location: { search: options?.search ?? "" },
      cause: "navigation",
    } as never) as Promise<NewSessionRouteData>;
  });
  Object.assign(f.context, { navigate });
  f.place.modelControl.load(f.context, "main", true);
  f.place.modelControl.loadCatalogTargets(f.context, "main", true);
  // Resolve the finite request/reader microtask chain, not a timer or a poll.
  for (let step = 0; step < 8; step++) {
    await Promise.resolve();
  }
  const container = document.createElement("div");
  const draw = () =>
    render(
      f.place.modelControl.render({
        context: f.context,
        agentId: f.place.agentId,
        agent: f.place.selectedAgent(),
        sending: false,
      }),
      container,
    );
  draw();
  const select = () => {
    draw();
    const row = container.querySelector<HTMLButtonElement>(
      `[data-chat-model-target="${catalogId}"]`,
    );
    expect(row).not.toBeNull();
    row!.click();
  };
  const settle = async () => {
    for (let step = 0; step < 8; step++) {
      await Promise.resolve();
    }
    draw();
  };
  return {
    ...f,
    probe,
    gateway,
    container,
    draw,
    select,
    settle,
    loaded: () => loaded,
    dispose: () => {
      f.flow.disconnect();
      f.place.modelControl.reset();
      f.context.chatAttachmentHandoff.dispose();
    },
  };
}

afterEach(() => {
  document.querySelectorAll("openclaw-new-session-page").forEach((p) => p.remove());
  localStorage.clear();
  sessionStorage.clear();
});

describe("registered native CLI admission", () => {
  it("reuses the successful picker target in the registered navigation loader", async () => {
    const f = await fixture();
    try {
      f.select();
      f.probe.resolve(catalogResult());
      for (let step = 0; step < 8; step++) {
        await Promise.resolve();
      }
      expect(f.context.navigate).toHaveBeenCalledOnce();
      expect(await f.loaded()).toMatchObject({
        catalogId: "anthropic",
        startTerminal: true,
        terminalHosts: [{ hostId: "gateway:local", label: "Gateway" }],
      });
      expect(
        f.request.mock.calls.filter(
          ([method, params]) =>
            method === "sessions.catalog.list" &&
            !(params as { metadataOnly?: boolean }).metadataOnly,
        ),
      ).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("does not reuse prepared metadata after navigation loses its owner", async () => {
    const f = await fixture();
    try {
      const navigate = vi.fn();
      Object.assign(f.context, { navigate });
      f.select();
      f.probe.resolve(catalogResult());
      await f.settle();
      expect(navigate).toHaveBeenCalledOnce();
      f.place.modelControl.load(f.context, "research", true);
      const result = await page.loader!(f.context, {
        location: { search: "?agent=main&catalog=anthropic" },
        cause: "navigation",
      } as never);
      expect(result).toMatchObject({ catalogId: "anthropic" });
      expect(
        f.request.mock.calls.filter(
          ([method, params]) =>
            method === "sessions.catalog.list" &&
            !(params as { metadataOnly?: boolean }).metadataOnly,
        ),
      ).toHaveLength(2);
    } finally {
      f.dispose();
    }
  });

  it.each(["anthropic", "third-party-terminal"])(
    "retains the current draft and retries unavailable %s",
    async (catalogId) => {
      const f = await fixture(catalogId);
      try {
        f.flow.setMessage("Keep my unsent task", []);
        const model = f.place.modelControl.selected;
        f.select();
        f.draw();
        expect(f.container.querySelector('[aria-busy="true"]')).not.toBeNull();
        f.probe.resolve(catalogResult(catalogId, true, false));
        await f.settle();
        const row = f.container.querySelector<HTMLButtonElement>(
          `[data-chat-model-target="${catalogId}"]`,
        );
        expect(row?.getAttribute("aria-label")).toContain("No native CLI is available");
        expect(row?.textContent).toContain("Retry");
        expect(f.context.navigate).not.toHaveBeenCalled();
        expect(f.flow.message).toBe("Keep my unsent task");
        expect(f.place.modelControl.selected).toBe(model);
        f.request.mockImplementation(async (method) =>
          method === "sessions.catalog.list" ? catalogResult(catalogId) : { models },
        );
        f.select();
        await f.settle();
        expect(await f.loaded()).toMatchObject({ catalogId, startTerminal: true });
        expect(
          f.request.mock.calls.filter(
            ([method, params]) =>
              method === "sessions.catalog.list" &&
              !(params as { metadataOnly?: boolean }).metadataOnly,
          ),
        ).toHaveLength(2);
      } finally {
        f.dispose();
      }
    },
  );

  it.each(["missing catalog", "missing capability", "request failure"] as const)(
    "recovers from %s without replacing the draft",
    async (failure) => {
      const f = await fixture();
      try {
        f.flow.setMessage("Retain this draft", []);
        f.select();
        if (failure === "request failure") {
          f.probe.reject(new Error("temporarily unavailable"));
        } else {
          f.probe.resolve(
            failure === "missing catalog" ? { catalogs: [] } : catalogResult("anthropic", false),
          );
        }
        await f.settle();
        expect(
          f.container
            .querySelector('[data-chat-model-target="anthropic"]')
            ?.getAttribute("aria-label"),
        ).toContain("This session target is unavailable");
        expect(f.flow.message).toBe("Retain this draft");
        expect(f.context.navigate).not.toHaveBeenCalled();
        f.request.mockImplementation(async (method) =>
          method === "sessions.catalog.list" ? catalogResult() : { models },
        );
        f.select();
        await f.settle();
        expect(await f.loaded()).toMatchObject({ catalogId: "anthropic", startTerminal: true });
      } finally {
        f.dispose();
      }
    },
  );

  it("does not probe machines on picker open, search, or ordinary model selection", async () => {
    const f = await fixture();
    try {
      const picker = f.container.querySelector<HTMLDetailsElement>("details")!;
      picker.open = true;
      picker.dispatchEvent(new Event("toggle"));
      const search = f.container.querySelector<HTMLInputElement>('input[type="search"]')!;
      expect(search).not.toBeNull();
      search.value = "Model";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      f.container
        .querySelector<HTMLButtonElement>('[data-chat-model-option="example/model-one"]')!
        .click();
      await f.settle();
      expect(f.place.modelControl.selected).toBe("example/model-one");
      expect(f.request.mock.calls.filter(([method]) => method === "sessions.catalog.list")).toEqual(
        [
          [
            "sessions.catalog.list",
            { agentId: "main", metadataOnly: true },
            { signal: expect.any(AbortSignal) },
          ],
        ],
      );
    } finally {
      f.dispose();
    }
  });

  it.each(["client", "identity", "hello", "credentials", "agent", "model", "disabled"] as const)(
    "does not navigate after the pending target loses its %s owner",
    async (change) => {
      const f = await fixture();
      try {
        f.select();
        const snapshot = f.gateway.gateway.snapshot;
        if (change === "client") {
          f.gateway.publish({ ...snapshot, client: new Proxy(snapshot.client!, {}) });
        }
        if (change === "identity") {
          f.gateway.publish({ ...snapshot, selfUser: { id: "another-user" } });
        }
        if (change === "hello") {
          f.gateway.publish({ ...snapshot, hello: { ...snapshot.hello! } });
        }
        if (change === "credentials") {
          Object.assign(f.gateway.gateway, { connectionRevision: 1 });
        }
        if (change === "agent") {
          f.place.modelControl.load(f.context, "research", true);
        }
        if (change === "disabled") {
          f.place.modelControl.loadCatalogTargets(f.context, "main", false);
        }
        if (change === "model") {
          f.draw();
          const option = f.container.querySelector<HTMLButtonElement>(
            '[data-chat-model-option="example/model-one"]',
          );
          expect(option).not.toBeNull();
          option!.click();
        }
        f.probe.resolve(catalogResult());
        for (let step = 0; step < 8; step++) {
          await Promise.resolve();
        }
        expect(f.context.navigate).not.toHaveBeenCalled();
        f.draw();
        expect(
          f.container.querySelector('[data-chat-model-target="anthropic"][aria-busy="true"]'),
        ).toBeNull();
      } finally {
        f.dispose();
      }
    },
  );

  it.each(["normal", "native", "unavailable"] as const)(
    "keeps the canonical header for %s",
    async (state) => {
      const element = document.createElement("openclaw-new-session-page") as HTMLElement & {
        data: NewSessionRouteData;
        updateComplete: Promise<boolean>;
      };
      element.data = {
        agentId: "main",
        requestedAgentId: "main",
        catalogId: state === "normal" ? "" : "anthropic",
        catalogLabel: state === "native" ? "Claude Code" : "",
        model: "",
        startTerminal: state === "native",
        terminalHosts: state === "native" ? [{ hostId: "gateway:local", label: "Gateway" }] : [],
      };
      document.body.append(element);
      await element.updateComplete;
      await element.updateComplete;
      expect(element.querySelector(".agent-chat__hint")?.textContent?.trim()).toBe(
        "Pick where this session works, then say what to do.",
      );
    },
  );
});
