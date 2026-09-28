/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLobsterdex } from "./lobster-dex.ts";
import {
  advanceUntil,
  createPet,
  spritePresent,
  type LobsterPetElement,
} from "./lobster-pet.test-support.ts";

const nebula = "clawmoji:v1.123abc.987654.7a0bcd.monocle.droopy.mighty.zoomy.1.1";
const sprig = "clawmoji:v1.22aabb.bb44aa.001122.party.perky.dainty.sleepy.0.0";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-09T12:00:00"));
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderNextFrame(element: LobsterPetElement): Promise<void> {
  await element.updateComplete;
  vi.advanceTimersToNextFrame();
  await element.updateComplete;
}

function resident(element: LobsterPetElement): HTMLElement {
  const sprite = element.querySelector<HTMLElement>(".lobster-pet:not(.lobster-pet--passer)");
  expect(sprite).not.toBeNull();
  return sprite!;
}

function createCustomPet(seed = 7): LobsterPetElement {
  const element = createPet(seed);
  element.clawmojiSource = nebula;
  element.clawmojiName = "Nebula";
  return element;
}

describe("selected Clawmoji composer visitor", () => {
  it.each([
    ["shy", 7, "2026-07-09"],
    ["elder", 644, "2026-07-09"],
    ["twins", 21, "2026-07-09"],
    ["Lobster Day", 7, "2026-09-25"],
    ["repository anniversary", 7, "2026-11-24"],
  ] as const)(
    "arrives immediately with its own appearance on a %s load",
    async (_label, seed, date) => {
      vi.setSystemTime(new Date(`${date}T12:00:00`));
      const element = createCustomPet(seed);
      await renderNextFrame(element);

      const sprite = resident(element);
      expect(sprite.title).toBe("Nebula");
      expect(sprite.style.getPropertyValue("--lob-shell")).toBe("#123abc");
      expect(sprite.style.getPropertyValue("--lob-claw")).toBe("#987654");
      expect(sprite.style.getPropertyValue("--lob-glint-seed")).toBe("#7a0bcd");
      expect(sprite.querySelector(".lob-monocle")).not.toBeNull();
      expect(sprite.querySelector(".lob-freckles")).not.toBeNull();
      expect(element.querySelector(".lobster-pet--twin, .lobster-pet--elder, .lob-cap")).toBeNull();
      expect(getLobsterdex().size).toBe(0);
    },
  );

  it("replaces the character, cancels its pending interaction, then restores ordinary visits", async () => {
    const element = createCustomPet();
    await renderNextFrame(element);
    resident(element).dispatchEvent(new MouseEvent("pointerdown", { button: 0 }));

    element.clawmojiSource = sprig;
    element.clawmojiName = "Sprig";
    await renderNextFrame(element);
    const replacement = resident(element);
    expect(replacement.title).toBe("Sprig");
    expect(replacement.style.getPropertyValue("--lob-shell")).toBe("#22aabb");
    expect(replacement.style.getPropertyValue("--lob-claw")).toBe("#bb44aa");
    expect(replacement.classList.contains("lobster-pet--party")).toBe(true);
    expect(replacement.querySelector(".lob-monocle, .lob-freckles")).toBeNull();
    await vi.advanceTimersByTimeAsync(650);
    await element.updateComplete;
    expect(resident(element).classList.contains("lobster-pet--act-pet")).toBe(false);
    expect(getLobsterdex().size).toBe(0);

    element.clawmojiSource = "data:image/png;base64,aGVsbG8=";
    await renderNextFrame(element);
    expect(spritePresent(element)).toBe(false);
    // The ordinary seed is shy again; the custom character's visit cannot survive.
    expect(await advanceUntil(element, () => spritePresent(element), 12_000)).toBe(false);
    element.mode = "offline";
    await renderNextFrame(element);
    const ordinary = resident(element);
    expect(ordinary.title).not.toBe("Sprig");
    expect(ordinary.style.getPropertyValue("--lob-shell")).not.toBe("#22aabb");
    expect(ordinary.style.getPropertyValue("--lob-shell")).not.toBe("#123abc");
    expect(getLobsterdex().size).toBe(1);
  });

  it.each(["visitsEnabled", "residentEnabled"] as const)(
    "respects %s when disabled and re-enabled",
    async (setting) => {
      const element = createCustomPet();
      await renderNextFrame(element);
      expect(spritePresent(element)).toBe(true);

      element[setting] = false;
      element.mode = "offline";
      await renderNextFrame(element);
      expect(spritePresent(element)).toBe(false);
      expect(await advanceUntil(element, () => spritePresent(element), 30_000)).toBe(false);

      element[setting] = true;
      await renderNextFrame(element);
      expect(resident(element).title).toBe("Nebula");
      expect(getLobsterdex().size).toBe(0);
    },
  );

  it("keeps the chosen character static with reduced motion across interactions and resumes", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    const element = createCustomPet();
    await renderNextFrame(element);
    const sprite = resident(element);
    expect(sprite.title).toBe("Nebula");
    expect(sprite.classList.contains("lobster-pet--entering")).toBe(false);
    sprite.dispatchEvent(new MouseEvent("pointerdown", { button: 0 }));
    sprite.dispatchEvent(new MouseEvent("pointerup", { button: 0 }));
    element.mode = "busy";
    document.dispatchEvent(new Event("visibilitychange"));
    await element.updateComplete;

    const acted = await advanceUntil(
      element,
      () => element.querySelector('[class*="lobster-pet--act-"]') !== null,
      30_000,
      100,
    );
    expect(acted).toBe(false);
    expect(spritePresent(element)).toBe(true);
    expect(getLobsterdex().size).toBe(0);
  });
});
