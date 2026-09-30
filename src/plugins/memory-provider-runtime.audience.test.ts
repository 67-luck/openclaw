// Native memory providers against real session lineage, acquired through the
// registered slot owner.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AUDIENCE_CHILD_KEY,
  AUDIENCE_ROOT_KEY,
  NATIVE_PROVIDER_ID,
  childMemoryContext,
  withChildAudience,
  withNativeMemoryProvider,
} from "./memory-provider-runtime.audience.test-support.js";
import type {
  MemoryAudience,
  MemoryCallerContext,
  MemoryProviderHandle,
} from "./memory-provider-types.js";
import { getActiveMemoryProviderCore } from "./memory-runtime.js";

// Partitions records by the supplied audience and, as documented, calls
// `context.assertCurrent()` immediately before each read.
function partitionedProvider(
  context: MemoryCallerContext,
  reads: string[],
  beforeRead: () => Promise<void> = async () => {},
): MemoryProviderHandle {
  const audience = context.authority.kind === "session" ? context.authority.audience : undefined;
  return {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },
    search: async () => {
      await beforeRead();
      context.assertCurrent();
      reads.push(audience?.kind ?? "none");
      return {
        hits: audience
          ? [{ reference: { providerId: NATIVE_PROVIDER_ID, id: audience.kind }, excerpt: "fact" }]
          : [],
      };
    },
    get: async () => ({ status: "not_found" }),
    health: async () => ({ status: "ready" }),
    close: async () => {},
  };
}

it.each(["child reset", "parent lifecycle change"] as const)(
  "refuses a native provider's own pre-I/O guard after a %s mid-call",
  async (change) => {
    await withChildAudience(true, async ({ audience, root, child, write }) => {
      const reachedRead = createDeferredCore();
      const releaseRead = createDeferredCore();
      const reads: string[] = [];
      const openProvider = (context: MemoryCallerContext) =>
        partitionedProvider(context, reads, async () => {
          reachedRead.resolve();
          await releaseRead.promise;
        });
      await withNativeMemoryProvider(openProvider, async () => {
        const { provider } = await getActiveMemoryProviderCore({
          cfg: {},
          agentId: "main",
          context: childMemoryContext(audience),
        });
        const search = provider!.search({ query: "orders" });
        await reachedRead.promise;
        if (change === "child reset") {
          write(AUDIENCE_CHILD_KEY, { ...child, sessionId: randomUUID(), updatedAt: 2 });
        } else {
          write(AUDIENCE_ROOT_KEY, { ...root, lifecycleRevision: randomUUID(), updatedAt: 2 });
        }
        releaseRead.resolve();
        await expect(search).rejects.toThrow("memory audience is no longer current");
        expect(reads).toEqual([]);
        await provider!.close();
      });
    });
  },
);

it("gives a conversation caller only its host-minted conversation audience", async () => {
  await withChildAudience(false, async ({ audience, root }) => {
    expect(audience).toEqual({
      kind: "conversation",
      agentId: "main",
      sessionKey: AUDIENCE_ROOT_KEY,
      sessionId: root.sessionId,
    });
    const reads: string[] = [];
    const opened: Array<MemoryAudience | undefined> = [];
    const openProvider = (context: MemoryCallerContext) => {
      opened.push(context.authority.kind === "session" ? context.authority.audience : undefined);
      return partitionedProvider(context, reads);
    };
    await withNativeMemoryProvider(openProvider, async () => {
      const { provider } = await getActiveMemoryProviderCore({
        cfg: {},
        agentId: "main",
        context: childMemoryContext(audience),
      });
      const page = await provider!.search({ query: "orders" });
      expect(page.hits.map((entry) => entry.reference.id)).toEqual(["conversation"]);
      expect(opened[0]).toBe(audience);
      await provider!.close();

      // An owner-private shape is not a grant: the host refuses it before open().
      await expect(
        getActiveMemoryProviderCore({
          cfg: {},
          agentId: "main",
          context: childMemoryContext({ kind: "owner-private", agentId: "main" }),
        }),
      ).rejects.toThrow("host-minted memory audience");
      expect(opened).toHaveLength(1);
      expect(reads).toEqual(["conversation"]);
    });
  });
});
