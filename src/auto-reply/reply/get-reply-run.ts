import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { ReplyPayload } from "../types.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import { prepareReplyRunContext, type PreparedReplyRunContext } from "./get-reply-run-context.js";
import { executePreparedReplyRun } from "./get-reply-run-execute.js";
import type { RunPreparedReplyParams } from "./get-reply-run.types.js";
import { getPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import {
  prepareReplySourceInput,
  retireUnadoptedReplySource,
  retargetReplySourceForExecution,
} from "./reply-source-binding.js";

async function executePreparedReplyContext(context: PreparedReplyRunContext) {
  const admission = await prepareReplyRunAdmission(context);
  if (admission.kind === "reply") {
    return admission.reply;
  }

  return executePreparedReplyRun(admission);
}

/** Runs a prepared reply turn after session, prompt, queue, and policy state are resolved. */
export async function runPreparedReply(
  inputParams: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const source = prepareReplySourceInput(inputParams.sessionCtx, inputParams.cfg, inputParams.opts);
  const params = { ...inputParams, opts: source.options };
  try {
    retargetReplySourceForExecution({
      ctx: params.ctx,
      options: params.opts,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath:
        params.storePath ??
        resolveSessionStorePathCore(params.cfg.session?.store, { agentId: params.agentId }),
      agentId: params.agentId,
    });
    const context = await prepareReplyRunContext(params);
    if (context.kind === "reply") {
      return context.reply;
    }

    const dispatchRuntime = getPreparedReplyDispatchRuntime();
    if (!dispatchRuntime) {
      return await executePreparedReplyContext(context);
    }

    const { acquireAgentRunPreparedModelRuntime } =
      await import("../../agents/prepared-model-runtime.js");
    await using lease = await acquireAgentRunPreparedModelRuntime(
      {
        config: dispatchRuntime.config,
        agentId: dispatchRuntime.agentId,
        agentDir: dispatchRuntime.agentDir,
        allowGatewaySubagentBinding: true,
        workspaceDir: context.workspaceDir,
        runtimePluginSelections: [
          {
            provider: params.provider,
            modelId: params.model,
            runtime: context.thinkingRuntime,
          },
        ],
      },
      {
        catalogMode: "static",
        pluginGeneration: dispatchRuntime.pluginGeneration,
        abortSignal: params.opts?.abortSignal,
      },
    );
    let leaseActive = true;
    try {
      return await withPreparedModelRuntimePluginGenerationScope(
        lease.pluginGeneration,
        () =>
          withPluginRuntimeGenerationScope(lease.snapshot, () =>
            executePreparedReplyContext(context),
          ),
        () => (leaseActive ? lease.snapshot : undefined),
      );
    } finally {
      leaseActive = false;
    }
  } finally {
    if (source.created) {
      retireUnadoptedReplySource(source.input);
    }
  }
}
