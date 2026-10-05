import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { OpenClawPluginServiceContext } from "./plugin-registration.types.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRegistry } from "./registry.js";
import { getGatewayContextResolver } from "./runtime/gateway-request-scope.js";
import { createPluginServiceCronGetter, type PluginServiceCronHost } from "./service-cron.js";
import { createPluginServiceScheduler } from "./service-scheduler.js";

/** Assemble the capabilities of one service lifetime without executing plugin work. */
export function createPluginServiceAutomationCapabilities(params: {
  registry: PluginRegistry;
  pluginId: string;
  serviceId: string;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
  scheduler?: GatewayScheduler;
  getCronService?: () => PluginServiceCronHost | null | undefined;
}) {
  const runtime = getPluginRegistryRuntime(params.registry);
  const common = {
    pluginId: params.pluginId,
    lease: params.lease,
    isStopping: params.isStopping,
    resolveGatewayContext: runtime ? getGatewayContextResolver(runtime) : undefined,
  };
  const serviceScheduler = params.scheduler
    ? createPluginServiceScheduler({
        ...common,
        scheduler: params.scheduler,
        serviceId: params.serviceId,
      })
    : undefined;
  const getCron = params.getCronService
    ? createPluginServiceCronGetter({ ...common, getCron: params.getCronService })
    : undefined;
  let mcpEvents: OpenClawPluginServiceContext["mcpEvents"];
  if (params.getCronService && runtime) {
    const getCronHost = params.getCronService;
    // Demand loading happens inside the already-retained service start/call,
    // never before services.ts has published that startup attempt's cleanup owner.
    const load = createLazyRuntimeSurface(
      () => import("./service-mcp-events.js"),
      (module) => module.createPluginServiceMcpEvents({ ...common, getCron: getCronHost }),
    );
    const bind = createLazyRuntimeMethodBinder(load);
    mcpEvents = {
      prepareSource: bind((service) => service.prepareSource),
    };
  }
  return { serviceScheduler, getCron, mcpEvents };
}
