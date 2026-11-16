import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const windowSchema = z.object({
  label: z.string(), kind: z.enum(['five-hour', 'weekly', 'model', 'other']),
  usedPercent: z.number().finite(), resetsAt: z.string().nullable(),
});
export const accountSchema = z.object({
  key: z.string(), providerId: z.string(), providerName: z.string(),
  hostIds: z.array(z.string()), hostNames: z.array(z.string()),
  email: z.string().nullable(), plan: z.string().nullable(),
  status: z.enum(['ok', 'stale', 'unavailable']), message: z.string().nullable(),
  fetchedAt: z.string().nullable(), windows: z.array(windowSchema),
  resetCount: z.number().int().nonnegative().nullable().default(null),
});
export const snapshotSchema = z.object({
  threadId: z.string(), providerId: z.string(), model: z.string().nullable(),
  hostId: z.string().nullable(), hostName: z.string().nullable(),
  binding: z.enum(['host-cli', 'uncertain', 'unavailable']),
  message: z.string().nullable(), account: accountSchema.nullable(),
});
export const rpcContract = defineRpcContract({
  thread: { input: z.object({ threadId: z.string().min(1), refresh: z.boolean().default(false) }), output: snapshotSchema },
  accounts: { input: z.object({ refresh: z.boolean().default(false) }), output: z.object({ accounts: z.array(accountSchema) }) },
  details: { input: z.object({ key: z.string().min(1).max(500) }), output: z.object({
    account: accountSchema.nullable(), threads: z.array(z.object({ id: z.string(), title: z.string(), hostName: z.string(), updatedAt: z.number() })),
  }) },
});
export type QuotaWindow = z.infer<typeof windowSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
