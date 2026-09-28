import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as observation from "@openclaw/fs-safe/watch";
import { afterEach, expect, it, vi } from "vitest";
import { createSourceObserver } from "../../scripts/watch-node-observation.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

// Keep Root admission and the transparent observation tap in the same package instance.
vi.mock("@openclaw/fs-safe/watch", async () => {
  const nodeModule = await import("node:module");
  return { ...nodeModule.createRequire(import.meta.url)("@openclaw/fs-safe/watch") };
});

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Manual proof branch only: real OS delivery and a post-close quiet period are intentional.
it.runIf(process.platform === "win32")(
  "delivers native Windows source edits and atomic replacement, then joins observation",
  async () => {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "require");
    const watchModule = createRequire(import.meta.url).resolve("@openclaw/fs-safe/watch");
    expect(
      JSON.parse(
        await fs.readFile(path.resolve(path.dirname(watchModule), "../package.json"), "utf8"),
      ),
    ).toMatchObject({ version: "0.21.1" });
    const root = await fs.realpath(directories.make("fs-safe-native-consumer-"));
    const source = path.join(root, "src");
    await fs.mkdir(source);
    const edited = path.join(source, "edited.ts");
    const replaced = path.join(source, "replaced.ts");
    await fs.writeFile(edited, "before edit");
    await fs.writeFile(replaced, "before replacement");
    const subscriptions: observation.WatchSubscription[] = [];
    const invalidations: Array<{
      reason: observation.WatchInvalidation["reason"];
      paths: string[];
    }> = [];
    const callbacks: Array<string | undefined> = [];
    const errors: unknown[] = [];
    const messages: string[] = [];
    const delivered: Array<{ operation: string; elapsedMs: number }> = [];
    let pending:
      | { file: string; completion: ReturnType<typeof Promise.withResolvers<void>> }
      | undefined;
    const watch = observation.watch;
    vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
      const subscription = watch(authority, {
        ...options,
        onInvalidate(hint) {
          invalidations.push({
            reason: hint.reason,
            paths:
              hint.changes?.map((change) => path.resolve(authority.rootReal, change.path)) ?? [],
          });
          options.onInvalidate(hint);
        },
      });
      subscriptions.push(subscription);
      return subscription;
    });
    const observer = createSourceObserver(["src"], {
      cwd: root,
      env: { CHOKIDAR_USEPOLLING: "false" },
      ignored: () => false,
      onChange(file) {
        callbacks.push(file);
        if (pending && file === pending.file) {
          pending.completion.resolve();
        }
      },
      onError(error) {
        errors.push(error);
        pending?.completion.reject(error);
      },
      onLog: (message) => messages.push(message),
    });
    try {
      await observer.ready;
      expect(messages).toEqual(["Watching sources (events)."]);
      expect(subscriptions.length).toBeGreaterThan(0);
      for (const subscription of subscriptions) {
        expect(subscription.health()).toMatchObject({ state: "ready", mode: "events" });
      }
      expect(callbacks).toEqual([]);

      async function mutate(file: string, operation: string, write: () => Promise<void>) {
        const completion = Promise.withResolvers<void>();
        pending = { file, completion };
        const first = invalidations.length;
        const started = performance.now();
        const deadline = setTimeout(
          () => completion.reject(new Error(`Native ${operation} delivery did not arrive`)),
          10_000,
        );
        try {
          await Promise.all([write(), completion.promise]);
          expect(
            invalidations
              .slice(first)
              .some((hint) => hint.reason === "event" && hint.paths.includes(file)),
          ).toBe(true);
          delivered.push({ operation, elapsedMs: performance.now() - started });
        } finally {
          clearTimeout(deadline);
          pending = undefined;
        }
      }

      await mutate(edited, "edit", () => fs.writeFile(edited, "after native edit"));
      expect(await fs.readFile(edited, "utf8")).toBe("after native edit");
      const stage = path.join(root, "replacement.stage");
      await fs.writeFile(stage, "after native atomic replacement");
      await mutate(replaced, "atomic replacement", () => fs.rename(stage, replaced));
      expect(await fs.readFile(replaced, "utf8")).toBe("after native atomic replacement");

      await observer.close();
      expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
        true,
      );
      const closedCallbacks = callbacks.length;
      const closedInvalidations = invalidations.length;
      await fs.writeFile(edited, "after joined close");
      await fs.writeFile(replaced, "also after joined close");
      await delay(1_000);
      expect(callbacks).toHaveLength(closedCallbacks);
      expect(invalidations).toHaveLength(closedInvalidations);
      expect(errors).toEqual([]);
      console.info(
        JSON.stringify({
          owner: "developer-source-observer",
          platform: process.platform,
          node: process.versions.node,
          fsSafe: "0.21.1",
          mode: "events",
          invalidation: "native-event",
          delivered,
          joinedSubscriptions: subscriptions.length,
          postCloseObservationMs: 1_000,
          postCloseCallbacks: callbacks.length - closedCallbacks,
          postCloseInvalidations: invalidations.length - closedInvalidations,
        }),
      );
    } finally {
      await observer.close();
    }
  },
  30_000,
);
