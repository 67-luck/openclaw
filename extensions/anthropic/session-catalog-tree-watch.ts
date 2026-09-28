import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { watch, type WatchSubscription } from "@openclaw/fs-safe/watch";

export type DirtyDirectoryWatch = {
  /** Direct-child names to re-read, or "all" when coverage is uncertain. */
  takeDirty(): "all" | Set<string>;
  close(): Promise<void>;
};

const WATCH_RETRY_MS = 5_000;

export function createDirtyDirectoryWatch(directory: string, depth = 2): DirtyDirectoryWatch {
  let subscription: WatchSubscription | undefined;
  let starting: Promise<void> | undefined;
  let dirty: "all" | Set<string> = "all";
  let retryAt = 0;
  let closed = false;
  const start = () => {
    starting = (async () => {
      await subscription?.close();
      subscription = undefined;
      // Catalog reads already trust a configured projects root through a symlink.
      const authority = await root(await fs.realpath(directory), { hardlinks: "allow" });
      if (closed) {
        return;
      }
      subscription = watch(authority, {
        mode: "auto",
        persistent: false,
        scopes: [{ path: ".", kind: "tree", depth }],
        onInvalidate: ({ changes }) => {
          if (!changes) {
            dirty = "all";
          } else if (dirty !== "all") {
            for (const change of changes) {
              const name = change.path.split(path.sep, 1)[0];
              if (!name || name === ".") {
                dirty = "all";
                break;
              }
              dirty.add(name);
            }
          }
        },
        onHealth: (health) => {
          if (health.state === "unavailable") {
            dirty = "all";
            retryAt = Date.now() + WATCH_RETRY_MS;
          }
        },
      });
      await subscription.ready;
    })()
      .catch(() => {
        dirty = "all";
        retryAt = Date.now() + WATCH_RETRY_MS;
      })
      .finally(() => {
        starting = undefined;
      });
  };
  start();
  return {
    takeDirty() {
      const state = subscription?.health().state;
      if (closed || starting || !subscription || state === "unavailable" || state === "closed") {
        if (!closed && !starting && Date.now() >= retryAt) {
          start();
        }
        return "all";
      }
      const result = dirty;
      dirty = new Set();
      return result;
    },
    async close() {
      closed = true;
      await starting;
      await subscription?.close();
    },
  };
}
