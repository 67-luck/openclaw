import { z } from "zod";

export const NODE_INSTALLED_APP_LAUNCH_COMMAND = "device.apps.launch";
export const InstalledAppIdSchema = z.string().regex(/^linux-desktop:[A-Za-z0-9_.-]+\.desktop$/);
export const InstalledAppRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const InstalledAppLaunchRequestSchema = z.strictObject({
  appId: InstalledAppIdSchema,
  appRevision: InstalledAppRevisionSchema,
});
export type InstalledAppLaunchRequest = z.infer<typeof InstalledAppLaunchRequestSchema>;
export const InstalledAppListToolParamsSchema = z.strictObject({
  action: z.literal("app_list"),
  node: z.string().min(1).max(256),
  query: z.string().min(1).max(256).optional(),
  limit: z.number().int().positive().max(20).optional(),
});
/** Gateway-added identity for the node's independent per-agent execution policy. */
export const InstalledAppLaunchDispatchSchema = InstalledAppLaunchRequestSchema.extend({
  agentId: z.string().min(1).max(256),
});
export const InstalledAppLaunchReadySchema = InstalledAppLaunchRequestSchema.extend({
  type: z.literal("installed-app-launch.ready"),
});
export const InstalledAppLaunchPermitSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("installed-app-launch.allow"),
    validForMs: z.number().int().positive().max(5000),
  }),
  z.strictObject({ type: z.literal("installed-app-launch.deny") }),
]);

/** Closed tool shape: no Gateway override, implicit target, arguments, or environment. */
export const InstalledAppLaunchToolParamsSchema = InstalledAppLaunchRequestSchema.extend({
  action: z.literal("app_launch"),
  node: z.string().min(1).max(256),
});
