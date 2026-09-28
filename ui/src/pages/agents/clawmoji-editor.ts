import { html, nothing } from "lit";
import {
  ClawmojiSchema,
  parseClawmojiSource,
  type Clawmoji,
} from "../../../../src/shared/clawmoji.js";
import { clawmojiLook } from "../../components/clawmoji-look.ts";
import { lobsterLookStyle, renderLobsterSvg } from "../../components/lobster-pet-look.ts";
import { withPromiseModalHost } from "../../components/promise-modal-host.ts";
import { t } from "../../i18n/index.ts";
import { downloadTextFile } from "../../lib/download.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { clawmojiAvatar } from "./clawmoji-avatar.ts";
import "../../styles/lobster-pet.css";
import "./clawmoji-editor.css";

const DEFAULT: Clawmoji = {
  version: 1,
  shell: "#ff6b5a",
  claws: "#db4f43",
  eyes: "#00e5cc",
  accessory: "none",
  antennae: "perky",
  clawSize: "regular",
  personality: "friendly",
  freckles: false,
  tailFan: false,
};
const PRESETS: Clawmoji[] = [
  DEFAULT,
  {
    ...DEFAULT,
    shell: "#8353b7",
    claws: "#ad85d3",
    eyes: "#f6d36f",
    accessory: "crown",
    personality: "showoff",
  },
  {
    ...DEFAULT,
    shell: "#67bce0",
    claws: "#a0dcf1",
    eyes: "#ffd166",
    accessory: "sprout",
    personality: "sleepy",
    antennae: "droopy",
  },
  {
    ...DEFAULT,
    shell: "#efce75",
    claws: "#db6a82",
    eyes: "#f7edf1",
    accessory: "monocle",
    freckles: true,
  },
  {
    ...DEFAULT,
    shell: "#ed91b9",
    claws: "#b35989",
    eyes: "#d1f4eb",
    accessory: "party",
    personality: "zoomy",
    tailFan: true,
  },
];

export function showClawmojiEditor(source: string | null): Promise<string | null> {
  return withPromiseModalHost<string | null>(undefined, (modal) => {
    let recipe = parseClawmojiSource(source) ?? PRESETS[0]!;
    let error: string | null = null;
    let importEpoch = 0;
    const label = (key: string) => t(`agents.identity.clawmoji.${key}`);
    const update = (next: Partial<Clawmoji>) => {
      importEpoch += 1;
      recipe = { ...recipe, ...next };
      error = null;
      paint();
    };
    const preview = (value: Clawmoji) => {
      const look = clawmojiLook(value);
      return html`<span
        class="clawmoji-editor__sprite"
        style=${`${lobsterLookStyle(look)};--lob-glint:${value.eyes}`}
        >${renderLobsterSvg(look, { standalone: true })}</span
      >`;
    };
    async function importDesign(event: Event) {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      const epoch = ++importEpoch;
      try {
        if (file.size > 4096) throw new Error(label("invalid"));
        const parsed = ClawmojiSchema.safeParse(JSON.parse(await file.text()));
        if (!parsed.success) throw new Error(label("invalid"));
        if (modal.settled || epoch !== importEpoch) return;
        update(parsed.data);
      } catch {
        if (modal.settled || epoch !== importEpoch) return;
        error = label("invalid");
        paint();
      }
    }
    const select = <K extends "accessory" | "antennae" | "clawSize" | "personality">(
      key: K,
    ) => html` <label class="field"
      ><span>${label(key)}</span>
      <select
        aria-label=${label(key)}
        .value=${recipe[key]}
        @change=${(event: Event) => update({ [key]: (event.target as HTMLSelectElement).value })}
      >
        ${ClawmojiSchema.shape[key].options.map(
          (value) =>
            html`<option value=${value} ?selected=${recipe[key] === value}>
              ${label(value)}
            </option>`,
        )}
      </select>
    </label>`;
    function paint() {
      modal.render(
        () => html` <openclaw-modal-dialog
          class="clawmoji-editor-dialog"
          label=${label("title")}
          description=${label("subtitle")}
          @modal-cancel=${() => modal.finish(null)}
        >
          <form
            class="clawmoji-editor"
            @submit=${(event: Event) => {
              event.preventDefault();
              try {
                modal.finish(clawmojiAvatar(recipe));
              } catch (reason) {
                error = formatUiError(reason);
                paint();
              }
            }}
          >
            <header>
              <h2>${label("title")}</h2>
              <p>${label("subtitle")}</p>
            </header>
            <div class="clawmoji-editor__body">
              <div class="clawmoji-editor__preview">
                ${preview(recipe)}
                <span class="clawmoji-editor__badge">${label("alive")}</span>
                <p>${label("capabilities")}</p>
              </div>
              <div class="clawmoji-editor__controls">
                <div class="clawmoji-editor__presets" role="group" aria-label=${label("presets")}>
                  ${PRESETS.map(
                    (preset, index) =>
                      html`<button
                        type="button"
                        class="btn"
                        title=${label(`preset${index}`)}
                        aria-label=${label(`preset${index}`)}
                        @click=${() => update(preset)}
                      >
                        ${preview(preset)}
                      </button>`,
                  )}
                </div>
                <div class="clawmoji-editor__colors">
                  ${(["shell", "claws", "eyes"] as const).map(
                    (key) =>
                      html`<label class="field"
                        ><span>${label(key)}</span
                        ><input
                          type="color"
                          aria-label=${label(key)}
                          .value=${recipe[key]}
                          @input=${(event: Event) =>
                            update({ [key]: (event.target as HTMLInputElement).value })}
                      /></label>`,
                  )}
                </div>
                <div class="clawmoji-editor__options">
                  ${select("accessory")}${select("personality")}${select("antennae")}${select(
                    "clawSize",
                  )}
                </div>
                <div class="clawmoji-editor__checks">
                  ${(["freckles", "tailFan"] as const).map(
                    (key) =>
                      html`<label
                        ><input
                          type="checkbox"
                          .checked=${recipe[key]}
                          @change=${(event: Event) =>
                            update({ [key]: (event.target as HTMLInputElement).checked })}
                        />${label(key)}</label
                      >`,
                  )}
                </div>
              </div>
            </div>
            ${error ? html`<p role="alert" class="clawmoji-editor__error">${error}</p>` : nothing}
            <footer>
              <div class="clawmoji-editor__sharing">
                <button
                  type="button"
                  class="btn btn--sm"
                  @click=${() =>
                    modal.host.querySelector<HTMLInputElement>('input[type="file"]')?.click()}
                >
                  ${label("import")}
                </button>
                <input type="file" accept=".json,application/json" hidden @change=${importDesign} />
                <button
                  type="button"
                  class="btn btn--sm"
                  @click=${() =>
                    downloadTextFile(
                      "my.clawmoji.json",
                      `${JSON.stringify(recipe, null, 2)}\n`,
                      "application/json",
                    )}
                >
                  ${label("export")}
                </button>
              </div>
              <button type="button" class="btn" @click=${() => modal.finish(null)}>
                ${t("common.cancel")}
              </button>
              <button type="submit" class="btn primary">${label("use")}</button>
            </footer>
          </form>
        </openclaw-modal-dialog>`,
      );
    }
    paint();
  });
}
