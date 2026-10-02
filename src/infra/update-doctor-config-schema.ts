import { z } from "zod";

const contentVersion = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .nullable();
const databaseGenerations = z.record(z.string(), z.string().nullable());
export const UpdateDoctorDatabaseWriteReceiptSchema = z.object({
  unchanged: z.boolean(),
  fromGenerations: databaseGenerations.optional(),
  generations: databaseGenerations,
  attribution: z
    .object({
      runId: z.string().min(1),
      beforeContentVersions: z.record(z.string(), contentVersion),
      afterContentVersions: z.record(z.string(), contentVersion),
      unattributedPaths: z.array(z.string()),
      writes: z.array(
        z.object({
          path: z.string(),
          migrationId: z.string().min(1),
          fromContentVersion: contentVersion,
          toContentVersion: contentVersion,
        }),
      ),
    })
    .optional(),
});

export const UpdateDoctorConfigChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), key: z.string() }),
  z.object({ kind: z.literal("migration"), message: z.string() }),
]);

export const UpdateDoctorConfigWriteRefusalSchema = z.object({
  reason: z.string(),
  message: z.string(),
  keys: z.array(z.string()),
});
