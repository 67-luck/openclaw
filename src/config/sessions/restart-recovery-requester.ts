import { z } from "zod";

const identifier = z.string().min(1).max(512);
const requesterSchema = z.strictObject({
  version: z.literal(1),
  agentId: identifier,
  sessionKey: identifier,
  sessionId: identifier,
  storePath: z.string().min(1).max(4096),
  lifecycleRevision: identifier.nullable(),
  sourceRunId: identifier,
  profileId: identifier,
  scopes: z.array(identifier).min(1).max(128),
  grant: z.strictObject({ pluginId: identifier, grantId: z.uuid() }).nullable(),
  aliasBindingIds: z.array(z.uuid()).max(128),
  role: identifier.nullable(),
  rolePolicy: z.string().max(32 * 1024),
  modelPolicyMembership: z
    .string()
    .min(1)
    .max(32 * 1024),
});

/** Original admission facts only; recovery must reconstruct and revalidate live authority. */
export type RestartRecoveryRequester = Readonly<z.infer<typeof requesterSchema>>;

/** No missing, legacy, or malformed record can imply a System requester. */
export function normalizeRestartRecoveryRequester(
  value: unknown,
): RestartRecoveryRequester | undefined {
  const parsed = requesterSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 64 * 1024) {
    return undefined;
  }
  try {
    const policy: unknown = JSON.parse(parsed.data.rolePolicy);
    if (policy !== null && (typeof policy !== "object" || Array.isArray(policy))) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    ...parsed.data,
    scopes: [...new Set(parsed.data.scopes)].toSorted(),
    aliasBindingIds: [...new Set(parsed.data.aliasBindingIds)].toSorted(),
  };
}
