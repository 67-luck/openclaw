import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import {
  normalizeTabIconPreference,
  TAB_ICON_FILE_NAME_MAX_LENGTH,
  type TabIconPreference,
} from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import {
  AVATAR_MAX_BYTES,
  USER_PROFILE_AVATAR_MIME_TYPES,
} from "../../../../src/shared/avatar-limits.js";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import { assertUploadsEnabled } from "../../lib/uploads.ts";

export type TabIconImageResult =
  | { ok: true; image: NonNullable<TabIconPreference["image"]> }
  | { ok: false; reason: "unusable" | "too-large" | "too-detailed" | "cancelled" };

/** Only processed raster bytes enter preferences; source files are never a fallback. */
export async function fileToTabIconImage(
  file: File,
  config: ApplicationConfigCapability,
  signal: AbortSignal,
): Promise<TabIconImageResult> {
  assertUploadsEnabled(config);
  if (signal.aborted) {
    return { ok: false, reason: "cancelled" };
  }
  if (!USER_PROFILE_AVATAR_MIME_TYPES.some((type) => type === file.type)) {
    return { ok: false, reason: "unusable" };
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const fileName =
    Array.from(file.name)
      .filter((character) => !containsAsciiControlCharacter(character))
      .join("")
      .trim()
      .slice(0, TAB_ICON_FILE_NAME_MAX_LENGTH) || "tab-icon.png";
  try {
    const bitmap = await createImageBitmap(file);
    try {
      if (signal.aborted) {
        return { ok: false, reason: "cancelled" };
      }
      assertUploadsEnabled(config);
      if (!bitmap.width || !bitmap.height) {
        return { ok: false, reason: "unusable" };
      }
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) {
        return { ok: false, reason: "unusable" };
      }
      for (const edge of [32, 16]) {
        canvas.width = edge;
        canvas.height = edge;
        const scale = edge / Math.max(bitmap.width, bitmap.height);
        const width = bitmap.width * scale;
        const height = bitmap.height * scale;
        context.clearRect(0, 0, edge, edge);
        context.drawImage(bitmap, (edge - width) / 2, (edge - height) / 2, width, height);
        for (const type of ["image/webp", "image/png"]) {
          const dataUrl = canvas.toDataURL(type, 0.8);
          // Reserve the longest mode name so every source change keeps the image within quota.
          const preference = normalizeTabIconPreference({
            mode: "default",
            image: { dataUrl, fileName },
          });
          if (preference?.image) {
            return { ok: true, image: preference.image };
          }
        }
      }
      return { ok: false, reason: "too-detailed" };
    } finally {
      bitmap.close();
    }
  } catch {
    return { ok: false, reason: signal.aborted ? "cancelled" : "unusable" };
  }
}
