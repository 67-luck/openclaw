import "../../styles/settings.css";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { renderTabIconSection, type TabIconViewProps } from "./view-tab-icon.ts";

registerSettingsEnglish();
const IMAGE = {
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
  fileName: "workspace-mark.png",
};
const containers: HTMLElement[] = [];
function mount(overrides: Partial<TabIconViewProps> = {}) {
  const props: TabIconViewProps = {
    tabIcon: undefined,
    tabIconBusy: false,
    tabIconError: null,
    tabIconUploadsEnabled: true,
    setTabIconMode: vi.fn(),
    onTabIconFileChange: vi.fn(),
    onRemoveTabIconImage: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const update = () => render(renderTabIconSection(props), container);
  update();
  return { container, props, update };
}
function button(container: HTMLElement, selector: string) {
  const result = container.querySelector<HTMLButtonElement>(selector);
  if (!result) {
    throw new Error("Missing button: " + selector);
  }
  return result;
}
afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  vi.restoreAllMocks();
});

describe("browser tab icon settings", () => {
  it("shows one Choose image affordance and never a fabricated image", () => {
    const { container, props } = mount({ tabIcon: { mode: "custom" } });
    expect(container.querySelector(".settings-row__desc")?.textContent).toBe("PNG, JPG or WebP");
    expect(button(container, ".settings-file__value").textContent).toContain("Choose image…");
    expect(container.querySelector(".settings-file img")).toBeNull();
    expect(container.querySelector('wa-radio[value="custom"] .identity-avatar__image')).toBeNull();
    expect(container.querySelector(".settings-file__remove")).toBeNull();
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    const open = vi.spyOn(input, "click").mockImplementation(() => {});
    button(container, ".settings-file__value").click();
    expect(open).toHaveBeenCalledOnce();
    const picked = new File(["image"], "icon.png", { type: "image/png" });
    const files = new DataTransfer();
    files.items.add(picked);
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onTabIconFileChange).toHaveBeenCalledWith(picked);
    expect(input.value).toBe("");
  });

  it("keeps the filename in its joined control with a separate remove action", async () => {
    const { container, props, update } = mount({
      tabIcon: { mode: "custom", image: IMAGE },
      tabIconAgentAvatar: IMAGE.dataUrl,
    });
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    const open = vi.spyOn(input, "click").mockImplementation(() => {});
    expect(container.querySelector(".settings-file__name")?.textContent?.trim()).toBe(
      IMAGE.fileName,
    );
    expect(container.querySelector(".settings-row__desc")?.textContent).toBe("PNG, JPG or WebP");
    expect(container.textContent).not.toContain("Change image");
    expect(container.querySelector(".settings-file img")?.getAttribute("src")).toBe(IMAGE.dataUrl);
    for (const source of ["agent", "custom"]) {
      expect(
        container
          .querySelector(`wa-radio[value="${source}"] .identity-avatar__image`)
          ?.getAttribute("src"),
      ).toBe(IMAGE.dataUrl);
    }
    await container.querySelector("wa-radio-group")!.updateComplete;
    await Promise.all(
      [...container.querySelectorAll("wa-radio")].map((radio) => radio.updateComplete),
    );
    const agentImage = container.querySelector<HTMLImageElement>(
      'wa-radio[value="agent"] .identity-avatar__image',
    )!;
    expect(getComputedStyle(agentImage).objectFit).toBe("contain");
    expect(container.querySelector('wa-radio[value="default"] img')?.getAttribute("src")).toContain(
      "favicon.svg",
    );
    button(container, ".settings-file__value").click();
    expect(open).toHaveBeenCalledOnce();
    button(container, ".settings-file__remove").click();
    expect(props.onRemoveTabIconImage).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    props.tabIcon = { mode: "custom" };
    update();
    expect(container.querySelector('wa-radio[value="custom"] .identity-avatar__image')).toBeNull();
    expect(button(container, ".settings-file__value").textContent).toContain("Choose image…");
  });

  it("leaves retry available while showing an error and disables only uploads under policy", () => {
    const { container, props, update } = mount({
      tabIcon: { mode: "custom", image: IMAGE },
      tabIconError: "Choose another image.",
    });
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Choose another image.");
    expect(button(container, ".settings-file__value").disabled).toBe(false);
    props.tabIconUploadsEnabled = false;
    update();
    expect(button(container, ".settings-file__value").disabled).toBe(true);
    expect(button(container, ".settings-file__remove").disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>("input[type=file]")?.disabled).toBe(true);
  });
});
