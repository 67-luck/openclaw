import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { editIdentityClawmoji, resetIdentityDraft } from "./identity-actions.ts";

const editor = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock("./clawmoji-editor.ts", () => ({ showClawmojiEditor: editor }));
beforeEach(() => editor.mockReset());

function setup() {
  const base = createApplicationConfigCapability({ resourceBasePath: "" });
  return {
    host: {
      identityDraft: { name: null, emoji: null, avatar: null },
      identitySaving: false,
      identityError: null,
    },
    config: { ...base, current: { ...base.current, uploadsEnabled: true } },
  };
}

describe("clawmoji identity selection", () => {
  it("keeps the embedded character intact for the existing identity save", async () => {
    const { host, config } = setup();
    const avatar =
      "data:image/svg+xml;clawmoji=v1.ff6b5a.db4f43.00e5cc.none.perky.regular.friendly.0.0;base64,PHN2Zy8+";
    editor.mockResolvedValue(avatar);
    await editIdentityClawmoji(host, null, config, () => true);
    expect(host.identityDraft.avatar).toBe(avatar);
    expect(host.identityError).toBeNull();
  });

  it.each(["reset", "connection", "policy"] as const)(
    "discards an editor result after %s changes",
    async (change) => {
      const { host, config } = setup();
      let finish!: (value: string) => void;
      editor.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      let current = true;
      const pending = editIdentityClawmoji(host, null, config, () => current);
      await vi.waitFor(() => expect(editor).toHaveBeenCalledOnce());
      if (change === "reset") resetIdentityDraft(host);
      if (change === "connection") current = false;
      if (change === "policy") config.current.uploadsEnabled = false;
      finish("data:image/svg+xml;base64,PHN2Zy8+");
      await pending;
      expect(host.identityDraft.avatar).toBeNull();
      expect(host.identityError).toBe(change === "policy" ? uploadsDisabledMessage() : null);
    },
  );
});
