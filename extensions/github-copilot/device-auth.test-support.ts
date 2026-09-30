import { expect, vi } from "vitest";

export async function runDeviceAuthWithFakeTimers<T>(
  run: (openUrl: (url: string) => Promise<void>) => T | Promise<T>,
): Promise<T> {
  vi.useFakeTimers();
  try {
    let notifyDeviceCodeShown!: () => void;
    const deviceCodeShown = new Promise<void>((resolve) => {
      notifyDeviceCodeShown = resolve;
    });
    const pending = Promise.resolve(run(async () => notifyDeviceCodeShown()));
    const openedBeforeCompletion = await Promise.race([
      deviceCodeShown.then(() => true),
      pending.then(() => false),
    ]);
    expect(openedBeforeCompletion).toBe(true);
    // Browser handoff follows the profile, device-code, and prompt work.
    await vi.advanceTimersByTimeAsync(1_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

export function buildDeviceFlowFetchMock(domain: string, accessToken: string) {
  return vi.fn(async (input: unknown, _init?: RequestInit) => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input);
    if (target === `https://${domain}/login/device/code`) {
      return Response.json({
        device_code: "device-code-stub",
        user_code: "ABCD-1234",
        verification_uri: `https://${domain}/login/device`,
        expires_in: 900,
        interval: 0,
      });
    }
    if (target === `https://${domain}/login/oauth/access_token`) {
      return Response.json({ access_token: accessToken, token_type: "bearer" });
    }
    throw new Error(`unexpected fetch in github-copilot device flow test: ${target}`);
  });
}

export async function runDeviceAuthWithTty<T>(
  fn: (openUrl: (url: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    return await runDeviceAuthWithFakeTimers(fn);
  } finally {
    vi.unstubAllGlobals();
    if (isTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }
}
