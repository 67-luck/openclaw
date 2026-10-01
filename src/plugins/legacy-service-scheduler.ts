import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { capturePluginHttpRouteRegistry } from "./http-registry.js";
import { getBoundLegacyPluginSdkResourceHost } from "./legacy-sdk-resource-host.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { getPluginInstanceOwner } from "./plugin-instance-scope.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";
import { createPluginServiceSchedulerRunner } from "./service-scheduler-context.js";
import { createPluginServiceScheduler } from "./service-scheduler.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";

/** @deprecated Shipped V1 monitor/manager factories retain this lifetime until the next SDK major. */
export function createLegacyPluginServiceScheduler(): PluginServiceSchedulerV1 {
  const invocation = pluginInstanceInvocation.getStore();
  const owner = invocation && getPluginInstanceOwner(invocation.instance);
  const instance = owner?.instance;
  if (
    invocation &&
    (!instance ||
      instance !== invocation.instance ||
      !instance.hasActiveCall ||
      !instance.acceptingCalls ||
      owner?.revoked ||
      instance.lifecycle.signal.aborted)
  ) {
    throw new Error("Legacy service scheduling requires an active plugin invocation");
  }
  const runtime = owner && getPluginRegistryRuntime(owner.registry);
  const current = getPluginRuntimeGatewayRequestScope();
  const candidate =
    (runtime && getGatewayContextResolver(runtime)) ??
    current?.resolveGatewayContext ??
    current?.context?.resolveGatewayContext;
  const resolveGatewayContext = candidate && getCanonicalGatewayContextResolver(candidate);
  if (candidate && !resolveGatewayContext) {
    throw new Error("Legacy service scheduler cannot resolve its Gateway owner");
  }
  const host = withPluginRuntimeGatewayContextResolver(
    resolveGatewayContext,
    getBoundLegacyPluginSdkResourceHost,
    { inheritRequestScope: false },
  );
  const runWithHttpRouteRegistry = capturePluginHttpRouteRegistry();
  const root = host?.scheduler ?? new GatewayScheduler();
  const runOwned = createPluginServiceSchedulerRunner({
    registry: owner?.registry,
    record: owner?.record,
    instance,
    resolveGatewayContext,
  });
  const scheduler = createPluginServiceScheduler(root, (run) =>
    runWithHttpRouteRegistry(() => runOwned(run)),
  );
  return host
    ? scheduler
    : { ...scheduler, stop: () => scheduler.stop().finally(() => root.stop()) };
}
