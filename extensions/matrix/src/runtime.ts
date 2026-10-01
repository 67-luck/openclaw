import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setMatrixRuntime,
  getRuntime: getMatrixRuntime,
  tryGetRuntime: getOptionalMatrixRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "matrix",
  errorMessage: "Matrix runtime not initialized",
});

export type MatrixRuntimeLifecycle = Required<
  Pick<OpenClawPluginApi["lifecycle"], "signal" | "onDispose">
> & { scheduler?: PluginServiceSchedulerV1 };

const runtimeLifecycles = createPluginRuntimeStore<WeakMap<PluginRuntime, MatrixRuntimeLifecycle>>({
  key: "matrix:runtime-lifecycles",
  errorMessage: "Matrix runtime lifecycle not initialized",
});

export function setMatrixRuntimeLifecycle(
  runtime: PluginRuntime,
  lifecycle: OpenClawPluginApi["lifecycle"],
): void {
  if (lifecycle.signal && lifecycle.onDispose) {
    let lifecycles = runtimeLifecycles.tryGetRuntime();
    if (!lifecycles) {
      lifecycles = new WeakMap();
      runtimeLifecycles.setRuntime(lifecycles);
    }
    lifecycles.set(runtime, {
      signal: lifecycle.signal,
      onDispose: lifecycle.onDispose,
    });
  }
}

export function getMatrixRuntimeLifecycle(): MatrixRuntimeLifecycle | undefined {
  const runtime = getOptionalMatrixRuntime();
  return runtime ? runtimeLifecycles.tryGetRuntime()?.get(runtime) : undefined;
}

export function setMatrixServiceScheduler(
  runtime: PluginRuntime,
  scheduler: PluginServiceSchedulerV1 | undefined,
): MatrixRuntimeLifecycle {
  const lifecycle = runtimeLifecycles.tryGetRuntime()?.get(runtime);
  if (!lifecycle) {
    throw new Error("Matrix service requires its registered runtime lifecycle");
  }
  lifecycle.scheduler = scheduler;
  return lifecycle;
}

export { getMatrixRuntime, getOptionalMatrixRuntime, setMatrixRuntime };
