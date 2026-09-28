import { afterEach, expect, it } from "vitest";
import { parseClawmojiSource } from "../../../../src/shared/clawmoji.js";
import { showClawmojiEditor } from "./clawmoji-editor.ts";

afterEach(() => document.body.replaceChildren());

it("creates an independently decodable avatar with the edited character recipe", async () => {
  const result = showClawmojiEditor(null);
  expect(
    (document.querySelector('select[aria-label="Claw size"]') as HTMLSelectElement).value,
  ).toBe("regular");
  (document.querySelector('button[aria-label="Royal"]') as HTMLButtonElement).click();
  const shell = document.querySelector('input[type="color"]') as HTMLInputElement;
  shell.value = "#7045b8";
  shell.dispatchEvent(new Event("input", { bubbles: true }));
  (document.querySelector('button[type="submit"]') as HTMLButtonElement).click();
  const avatar = await result;
  expect(avatar).not.toBeNull();
  expect(parseClawmojiSource(avatar)).toMatchObject({
    shell: "#7045b8",
    accessory: "crown",
    personality: "showoff",
  });
  expect(avatar!.length).toBeLessThan(16_000);
  // Decode as a separate image document: page variables/styles cannot fix a broken export.
  const image = new Image();
  image.src = avatar!;
  await image.decode();
  expect(image.naturalWidth).toBe(96);
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  const reopened = showClawmojiEditor(avatar);
  expect((document.querySelector('input[type="color"]') as HTMLInputElement).value).toBe("#7045b8");
  document.querySelector("openclaw-modal-dialog")!.dispatchEvent(new Event("modal-cancel"));
  expect(await reopened).toBeNull();
});
