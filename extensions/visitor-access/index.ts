import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createVisitorAccessReader } from "./src/access.js";
import { VisitorPolicyClient } from "./src/cloudflare.js";
import { visitorConfigSchema, visitorPluginSchema } from "./src/config.js";
import { VisitorAccessError, visitorErrorText } from "./src/errors.js";
import { profileUsesVisitorRole, resolveVisitorRole } from "./src/roles.js";
import { visitorRuntimeStore, type VisitorRuntime } from "./src/runtime.js";
import { createVisitorTools } from "./src/tools.js";
import { VisitorAccessService, type VisitorGrant } from "./src/visitors.js";

function registerVisitorPlugin(api: OpenClawPluginApi): void {
  if (api.registrationMode === "cli-metadata") {
    return;
  }
  for (const name of ["visitor_invite", "visitor_revoke", "visitor_list"]) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (ctx) => createVisitorTools(ctx).find((tool) => tool.name === name),
      },
      { name },
    );
  }
  if (api.registrationMode !== "full") {
    return;
  }
  const config = visitorConfigSchema.parse(api.pluginConfig);
  const store = api.runtime.state.openKeyedStore<VisitorGrant>({
    namespace: "visitor-grants",
    // Fixed storage bound survives config reload; maxVisitors controls admission.
    maxEntries: 500,
    overflowPolicy: "reject-new",
  });
  let runtime: VisitorRuntime | undefined;
  const requireService = () => {
    if (!runtime) {
      throw new VisitorAccessError("Visitor access is starting; retry shortly.");
    }
    return runtime.service;
  };

  api.registerGatewayAccessPolicy({
    resume({ profile, grantId }) {
      return requireService().resume(profile.emails, grantId);
    },
    authorize({ config: currentConfig, profile, requiredByRole }) {
      const roles = currentConfig.gateway?.roles;
      if (
        !requiredByRole ||
        !profileUsesVisitorRole(roles, { id: profile.profileId, role: profile.assignedRole })
      ) {
        return undefined;
      }
      resolveVisitorRole(currentConfig);
      return requireService().authorize(profile.emails);
    },
  });

  api.registerService({
    id: "visitor-access-expiry",
    apiVersion: 2,
    async start({ scheduler }) {
      scheduler.signal.throwIfAborted();
      if (visitorRuntimeStore.tryGetRuntime()) {
        throw new Error("A visitor-access Gateway service is already running.");
      }
      const service = new VisitorAccessService(
        config,
        store,
        new VisitorPolicyClient(config, fetch, scheduler.signal),
        api.logger,
        createVisitorAccessReader(api.runtime),
        scheduler,
      );
      runtime = { service, errorText: (error) => visitorErrorText(error, config.apiToken) };
      await service.initialize();
      scheduler.signal.throwIfAborted();
      const current = visitorRuntimeStore.tryGetRuntime();
      if (current && current !== runtime) {
        service.close();
        throw new Error("A visitor-access Gateway service is already running.");
      }
      visitorRuntimeStore.setRuntime(runtime);
      const sweep = () =>
        service.sweep().catch((error: unknown) => {
          if (!scheduler.signal.aborted) {
            api.logger.error(
              `visitor-access sweep failed: ${visitorErrorText(error, config.apiToken)}`,
            );
          }
        });
      scheduler.schedule({ id: "sweep", delayMs: 3_600_000, everyMs: 3_600_000, run: sweep });
      await sweep();
    },
    async stop({ scheduler }) {
      runtime?.service.close();
      await scheduler.stop();
      await runtime?.service.waitForIdle();
      if (visitorRuntimeStore.tryGetRuntime() === runtime) {
        visitorRuntimeStore.clearRuntime();
      }
    },
  });
}

export default definePluginEntry({
  id: "visitor-access",
  name: "Visitor Access",
  description: "Internal Cloudflare Access visitor grants with managed expiry.",
  configSchema: visitorPluginSchema,
  register: registerVisitorPlugin,
});
