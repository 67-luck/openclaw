import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { TabIconPreference } from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { defaultControlUiFavicon } from "../../app/control-ui-environment-presentation.runtime.ts";
import { icons } from "../../components/icons.ts";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
} from "../../components/identity-avatar-view.ts";
import { renderSettingsRow, renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
export type TabIconViewProps = {
  tabIcon: TabIconPreference | undefined;
  tabIconAgentAvatar?: string | null;
  tabIconBusy: boolean;
  tabIconError: string | null;
  tabIconUploadsEnabled: boolean;
  setTabIconMode: (mode: TabIconPreference["mode"]) => void;
  onTabIconFileChange: (file: File) => void;
  onRemoveTabIconImage: () => void;
};

export function renderTabIconSection(props: TabIconViewProps) {
  const image = props.tabIcon?.image;
  const mode = props.tabIcon?.mode ?? "default";
  const defaultIcon = html`<img src=${defaultControlUiFavicon()} alt="" />`;
  const optionLabel = (
    label: string,
    source: string | null,
    fallback: TemplateResult = defaultIcon,
  ) => {
    const view = { imageUrl: source, pending: false };
    return html`<span class="settings-tab-icon__option">
      <span
        class=${identityAvatarClass("identity-avatar--agent settings-tab-icon__preview", view)}
        aria-hidden="true"
      >
        ${renderIdentityAvatarImage({ view, fallbackSelector: ".settings-tab-icon__preview", className: "identity-avatar__image" })}
        <span class="identity-avatar__fallback">${fallback}</span> </span
      >${label}
    </span>`;
  };
  let fileInput: HTMLInputElement | undefined;
  const label = image
    ? t("configView.appearance.tabIcon.replaceImage", { name: image.fileName })
    : t("configView.appearance.tabIcon.chooseImage");
  return html`
    <section
      id=${APPEARANCE_SETTINGS_TARGET_IDS.tabIcon}
      class="settings-section settings-tab-icon"
    >
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.appearance.tabIcon.title")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.appearance.tabIcon.source"),
          stackedOnNarrow: true,
          control: renderSettingsSegmented({
            value: mode,
            options: [
              {
                value: "default",
                label: optionLabel(t("configView.appearance.tabIcon.default"), null),
              },
              {
                value: "agent",
                label: optionLabel(
                  t("configView.appearance.tabIcon.agent"),
                  props.tabIconAgentAvatar ?? null,
                ),
              },
              {
                value: "custom",
                label: optionLabel(
                  t("configView.appearance.tabIcon.custom"),
                  image?.dataUrl ?? null,
                  icons.image,
                ),
              },
            ],
            ariaLabel: t("configView.appearance.tabIcon.sourceLabel"),
            onChange: props.setTabIconMode,
          }),
        })}
        ${
          mode === "custom"
            ? renderSettingsRow({
                title: t("configView.appearance.tabIcon.image"),
                description: t("configView.appearance.tabIcon.formats"),
                stackedOnNarrow: true,
                control: html`
                  <div class="settings-file" aria-busy=${String(props.tabIconBusy)}>
                    <button
                      type="button"
                      class="btn settings-file__value"
                      aria-label=${label}
                      title=${props.tabIconUploadsEnabled ? label : uploadsDisabledMessage()}
                      ?disabled=${!props.tabIconUploadsEnabled}
                      @click=${() => fileInput?.click()}
                    >
                      <span class="settings-file__thumbnail" aria-hidden="true">
                        ${image ? html`<img src=${image.dataUrl} alt="" />` : icons.image}
                      </span>
                      <span class="settings-file__name">
                        ${image ? image.fileName : t("configView.appearance.tabIcon.chooseImage")}
                      </span>
                    </button>
                    ${
                      image
                        ? html`
                            <button
                              type="button"
                              class="btn settings-file__remove"
                              aria-label=${t("configView.appearance.tabIcon.removeImage")}
                              title=${t("configView.appearance.tabIcon.removeImage")}
                              @click=${props.onRemoveTabIconImage}
                            >
                              ${icons.x}
                            </button>
                          `
                        : nothing
                    }
                    <input
                      ${ref((element) => {
                        fileInput = element instanceof HTMLInputElement ? element : undefined;
                      })}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      aria-label=${t("configView.appearance.tabIcon.chooseImage")}
                      ?disabled=${!props.tabIconUploadsEnabled}
                      hidden
                      @change=${(event: Event) => {
                        const input = event.currentTarget;
                        if (!(input instanceof HTMLInputElement)) {
                          return;
                        }
                        const file = input.files?.[0];
                        input.value = "";
                        if (file) {
                          props.onTabIconFileChange(file);
                        }
                      }}
                    />
                  </div>
                `,
              })
            : nothing
        }
      </div>
      ${
        props.tabIconError
          ? html`<p class="settings-status settings-status--error" role="alert">
              ${props.tabIconError}
            </p>`
          : nothing
      }
    </section>
  `;
}
