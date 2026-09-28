import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfig, resetConfigRuntimeState } from "../config/config.js";

export async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  // These metadata fixtures change models/session routing, not the already-running ingress.
  // Preserve its auth mode and policy unless a case explicitly replaces gateway settings.
  const next = {
    ...config,
    gateway: {
      ...getRuntimeConfig().gateway,
      ...(isRecord(config.gateway) ? config.gateway : {}),
    },
  };
  await fs.writeFile(configPath, JSON.stringify(next, null, 2), "utf-8");
  resetConfigRuntimeState();
}
