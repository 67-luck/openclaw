/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings, type UiSettings } from "../../app/settings.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConfigPage } from "./config-page.ts";
import * as tabIconImage from "./tab-icon-image.ts";
import type { TabIconSettingsController } from "./tab-icon-settings-controller.ts";

const IMAGE = {
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
  fileName: "icon.png",
};
const upload = vi.fn<typeof tabIconImage.fileToTabIconImage>();
type TestPage = {
  context: ApplicationContext;
  settings: UiSettings;
  pageId: string;
  tabIconSettings: TabIconSettingsController;
  resetConfigViewState: () => void;
};
function createPage() {
  patchSettings({ tabIcon: { mode: "custom" } });
  const page = new ConfigPage();
  const state = page as unknown as TestPage;
  const connected = vi.spyOn(page, "isConnected", "get").mockReturnValue(true);
  const gateway = {
    connection: { gatewayUrl: "ws://gateway.test" },
    snapshot: { phase: "connected", client: {}, selfUser: { id: "alice" } },
  };
  const selection = { intentRevision: 0 };
  const baseConfig = createApplicationConfigCapability({ resourceBasePath: "" });
  const config = { ...baseConfig, current: { ...baseConfig.current } };
  const refresh = vi.fn();
  state.context = {
    gateway,
    settingsAgentSelection: selection,
    agentSelection: { state: { selectedId: "main" } },
    agents: { state: { agentsList: null } },
    agentIdentity: { ensure: async () => {} },
    config,
    theme: { refresh },
  } as unknown as ApplicationContext;
  state.settings = loadSettings();
  state.pageId = "appearance";
  return { page, state, gateway, selection, config, refresh, connected };
}
const picked = () => new File(["image"], "icon.png", { type: "image/png" });

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  upload.mockReset();
  vi.spyOn(tabIconImage, "fileToTabIconImage").mockImplementation(upload);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConfigPage tab icon upload intent", () => {
  it("does not read files when uploads are disabled", async () => {
    const { state, config } = createPage();
    config.current.uploadsEnabled = false;
    await state.tabIconSettings.upload(picked());
    expect(upload).not.toHaveBeenCalled();
    expect(state.tabIconSettings.props.tabIconError).toBeTruthy();
    expect(state.tabIconSettings.props.tabIconBusy).toBe(false);
  });
  it("applies a current processed upload and preserves it across source changes", async () => {
    upload.mockResolvedValue({ ok: true, image: IMAGE });
    const { state, refresh } = createPage();
    await state.tabIconSettings.upload(picked());
    expect(loadSettings().tabIcon).toEqual({ mode: "custom", image: IMAGE });
    state.tabIconSettings.props.setTabIconMode("agent");
    expect(loadSettings().tabIcon).toEqual({ mode: "agent", image: IMAGE });
    state.tabIconSettings.props.setTabIconMode("default");
    expect(loadSettings().tabIcon).toEqual({ mode: "default", image: IMAGE });
    state.tabIconSettings.props.onRemoveTabIconImage();
    expect(loadSettings().tabIcon).toEqual({ mode: "custom" });
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(state.tabIconSettings.props.tabIconBusy).toBe(false);
  });

  const invalidations: Record<
    string,
    (fixture: ReturnType<typeof createPage>, signal: AbortSignal) => void
  > = {
    mode: ({ state }) => state.tabIconSettings.props.setTabIconMode("default"),
    remove: ({ state }) => state.tabIconSettings.props.onRemoveTabIconImage(),
    reset: ({ state }) => state.resetConfigViewState(),
    profile: ({ gateway }) => {
      gateway.snapshot.selfUser.id = "bob";
    },
    gateway: ({ gateway }) => {
      gateway.connection.gatewayUrl = "ws://other.test";
    },
    client: ({ gateway }) => {
      gateway.snapshot.client = {};
    },
    selection: ({ selection }) => {
      selection.intentRevision++;
    },
    policy: ({ config }) => {
      config.current.uploadsEnabled = false;
    },
    unmount: ({ connected }) => connected.mockReturnValue(false),
    disconnect: ({ page, state }, signal) => {
      page.disconnectedCallback();
      expect(signal.aborted).toBe(true);
      expect(state.tabIconSettings.props.tabIconBusy).toBe(false);
    },
    page: ({ state }) => {
      state.pageId = "advanced";
    },
    preference: () => patchSettings({ tabIcon: { mode: "agent" } }),
  };
  it.each(Object.entries(invalidations))(
    "does not apply a late upload after %s changes",
    async (name, invalidate) => {
      const pending = createDeferred<tabIconImage.TabIconImageResult>();
      upload.mockReturnValue(pending.promise);
      const fixture = createPage();
      const { state, refresh } = fixture;
      const work = state.tabIconSettings.upload(picked());
      const signal = upload.mock.calls[0]?.[2];
      if (!signal) {
        throw new Error("Expected the upload cancellation signal");
      }
      expect(signal.aborted).toBe(false);
      invalidate(fixture, signal);
      pending.resolve({ ok: true, image: IMAGE });
      await work;
      expect(loadSettings().tabIcon?.image).toBeUndefined();
      expect(state.tabIconSettings.props.tabIconBusy).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(name === "mode" || name === "remove" ? 1 : 0);
    },
  );

  it("keeps newer selection busy when a superseded upload completes", async () => {
    const first = createDeferred<tabIconImage.TabIconImageResult>();
    const second = createDeferred<tabIconImage.TabIconImageResult>();
    upload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { state } = createPage();
    const oldWork = state.tabIconSettings.upload(picked());
    const newWork = state.tabIconSettings.upload(picked());
    first.resolve({ ok: true, image: IMAGE });
    await oldWork;
    expect(state.tabIconSettings.props.tabIconBusy).toBe(true);
    expect(loadSettings().tabIcon?.image).toBeUndefined();
    second.resolve({ ok: true, image: { ...IMAGE, fileName: "latest.png" } });
    await newWork;
    expect(state.tabIconSettings.props.tabIconBusy).toBe(false);
    expect(loadSettings().tabIcon?.image?.fileName).toBe("latest.png");
  });

  it("shows a recoverable processing error without discarding the previous image", async () => {
    const { state } = createPage();
    state.settings = patchSettings({ tabIcon: { mode: "custom", image: IMAGE } });
    upload.mockResolvedValue({ ok: false, reason: "unusable" });
    await state.tabIconSettings.upload(picked());
    expect(loadSettings().tabIcon?.image).toEqual(IMAGE);
    expect(state.tabIconSettings.props.tabIconError).toContain("Choose a PNG, JPG or WebP image");
    upload.mockResolvedValue({ ok: true, image: IMAGE });
    await state.tabIconSettings.upload(picked());
    expect(state.tabIconSettings.props.tabIconError).toBeNull();
  });
});
