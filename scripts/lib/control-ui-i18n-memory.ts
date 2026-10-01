import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

export function encodeControlUiTranslationMemory(bytes: Uint8Array | string): Buffer {
  return gzipSync(bytes, { level: 6 });
}

export function decodeControlUiTranslationMemory(bytes: Uint8Array): Buffer {
  // A corrupt or truncated canonical file must not become an English fallback.
  return gunzipSync(bytes);
}

export function readControlUiTranslationMemoryText(filePath: string): string {
  return decodeControlUiTranslationMemory(readFileSync(filePath)).toString("utf8");
}
