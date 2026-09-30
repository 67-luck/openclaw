// Released memory plugins read and build `MemoryFlushPlan`; its shape must stay stable.
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  MemoryFlushFilePlanDraft,
  MemoryFlushPlan,
  MemoryFlushToolsPlan,
} from "./memory-core-host-runtime-core.js";
import type { MemoryPluginCapability } from "./memory-host-core.js";

type ResolverResult = NonNullable<
  ReturnType<NonNullable<MemoryPluginCapability["flushPlanResolver"]>>
>;

// A consumer written against the released type reads every field without narrowing.
function describeReleasedPlan(plan: MemoryFlushPlan): string {
  return `${plan.relativePath}:${plan.softThresholdTokens}/${plan.forceFlushTranscriptBytes}/${plan.reserveTokensFloor}`;
}

describe("MemoryFlushPlan compatibility", () => {
  it("keeps the released file plan's required fields", () => {
    expectTypeOf<MemoryFlushPlan["relativePath"]>().toEqualTypeOf<string>();
    expectTypeOf<MemoryFlushPlan["softThresholdTokens"]>().toEqualTypeOf<number>();
    expectTypeOf<MemoryFlushPlan["forceFlushTranscriptBytes"]>().toEqualTypeOf<number>();
    expectTypeOf<MemoryFlushPlan["reserveTokensFloor"]>().toEqualTypeOf<number>();
    const plan: MemoryFlushPlan = {
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_024,
      reserveTokensFloor: 20_000,
      prompt: "flush",
      systemPrompt: "flush",
      relativePath: "memory/2026-10-02.md",
    };
    expect(describeReleasedPlan(plan)).toBe("memory/2026-10-02.md:4000/1024/20000");
  });

  it("lets a resolver return a released plan, a file draft, or a tools plan", () => {
    expectTypeOf<MemoryFlushPlan>().toMatchTypeOf<ResolverResult>();
    expectTypeOf<MemoryFlushFilePlanDraft>().toMatchTypeOf<ResolverResult>();
    expectTypeOf<MemoryFlushToolsPlan>().toMatchTypeOf<ResolverResult>();
    const resolver: NonNullable<MemoryPluginCapability["flushPlanResolver"]> = () => ({
      prompt: "flush",
      systemPrompt: "flush",
      persistenceToolNames: ["provider_save"],
    });
    expect(resolver({})).toMatchObject({ persistenceToolNames: ["provider_save"] });
    // Released readers that optional-chain the resolver result keep their field types.
    expectTypeOf<ResolverResult["relativePath"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ResolverResult["softThresholdTokens"]>().toEqualTypeOf<number | undefined>();
  });
});
