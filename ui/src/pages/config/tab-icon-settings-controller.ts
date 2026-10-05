import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, type UiSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { uploadsEnabled } from "../../lib/uploads.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { fileToTabIconImage } from "./tab-icon-image.ts";
import type { TabIconViewProps } from "./view-tab-icon.ts";

type TabIconSettingsHost = ReactiveControllerHost & {
  readonly isConnected: boolean;
  readonly pageId: ConfigPageId;
};

type TabIconSettingsOptions = {
  getContext: () => ApplicationContext;
  getPreference: () => UiSettings["tabIcon"];
  applySettings: (patch: Pick<UiSettings, "tabIcon">) => void;
};

/** Owns only the page's upload intent; ConfigPage retains settings application. */
export class TabIconSettingsController implements ReactiveController {
  private error: string | null = null;
  private pendingUpload: { controller: AbortController; isCurrent: () => boolean } | null = null;

  constructor(
    private readonly host: TabIconSettingsHost,
    private readonly options: TabIconSettingsOptions,
  ) {
    host.addController(this);
  }

  get props(): TabIconViewProps {
    const context = this.options.getContext();
    const agentId = context.agentSelection.state.selectedId;
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === agentId);
    return {
      tabIconAgentAvatar: agent
        ? resolveAgentAvatarUrl(agent, context.agentIdentity.get(agentId))
        : null,
      tabIcon: this.options.getPreference(),
      tabIconBusy: this.pendingUpload !== null,
      tabIconError: this.error,
      tabIconUploadsEnabled: uploadsEnabled(context.config),
      setTabIconMode: (mode) => {
        this.cancelUpload();
        this.options.applySettings({ tabIcon: { ...this.options.getPreference(), mode } });
      },
      onTabIconFileChange: (file) => void this.upload(file),
      onRemoveTabIconImage: () => {
        this.cancelUpload();
        this.options.applySettings({ tabIcon: { mode: "custom" } });
      },
    };
  }

  hostUpdate() {
    const context = this.options.getContext();
    if (this.host.pageId === "appearance" && context.gateway.snapshot.phase === "connected") {
      void context.agentIdentity.ensure([context.agentSelection.state.selectedId]);
    }
    if (this.pendingUpload && !this.pendingUpload.isCurrent()) {
      this.cancelUpload();
    }
  }

  hostDisconnected() {
    this.cancelUpload();
  }

  cancelUpload() {
    if (!this.pendingUpload && this.error === null) {
      return;
    }
    this.pendingUpload?.controller.abort();
    this.pendingUpload = null;
    this.error = null;
    this.host.requestUpdate();
  }

  async upload(file: File) {
    this.cancelUpload();
    if (!uploadsEnabled(this.options.getContext().config)) {
      this.error = t("common.uploadsDisabled");
      this.host.requestUpdate();
      return;
    }
    if (
      !this.host.isConnected ||
      this.host.pageId !== "appearance" ||
      this.options.getPreference()?.mode !== "custom"
    ) {
      return;
    }
    const context = this.options.getContext();
    const gateway = context.gateway;
    const config = context.config;
    const phase = gateway.snapshot.phase;
    const client = gateway.snapshot.client;
    const gatewayUrl = gateway.connection.gatewayUrl;
    const profileId = gateway.snapshot.selfUser?.id;
    const selection = context.settingsAgentSelection;
    const selectionRevision = selection.intentRevision;
    const preference = JSON.stringify(this.options.getPreference());
    const controller = new AbortController();
    const isCurrent = () =>
      !controller.signal.aborted &&
      this.host.isConnected &&
      this.host.pageId === "appearance" &&
      this.options.getContext() === context &&
      gateway.snapshot.phase === phase &&
      gateway.snapshot.client === client &&
      gateway.connection.gatewayUrl === gatewayUrl &&
      gateway.snapshot.selfUser?.id === profileId &&
      selection.intentRevision === selectionRevision &&
      JSON.stringify(this.options.getPreference()) === preference &&
      uploadsEnabled(config);
    this.pendingUpload = { controller, isCurrent };
    this.host.requestUpdate();
    try {
      const result = await fileToTabIconImage(file, config, controller.signal);
      if (!isCurrent() || JSON.stringify(loadSettings().tabIcon) !== preference) {
        return;
      }
      if (result.ok) {
        this.options.applySettings({ tabIcon: { mode: "custom", image: result.image } });
      } else if (result.reason !== "cancelled") {
        this.error = t(
          result.reason === "too-large"
            ? "configView.appearance.tabIcon.tooLarge"
            : result.reason === "too-detailed"
              ? "configView.appearance.tabIcon.tooDetailed"
              : "configView.appearance.tabIcon.unusable",
        );
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.pendingUpload?.controller === controller) {
        this.pendingUpload = null;
        this.host.requestUpdate();
      }
    }
  }
}
