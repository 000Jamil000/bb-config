import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const sourceSchema = z.object({ kind: z.enum(['workspace', 'host', 'thread-storage']), threadId: z.string().nullable(), environmentId: z.string().nullable(), projectId: z.string().nullable(), experimental_hostId: z.string().optional() });
export const targetSchema = z.object({ path: z.string().min(1).max(8192), source: sourceSchema, action: z.enum(['open', 'save']).default('open') });
export const bundleSchema = z.object({ main: z.string(), entries: z.array(z.object({ path: z.string(), content: z.string(), sha256: z.string() })).max(100) });
export const hostContract = defineRpcContract({
  info: { input: z.null(), output: z.object({ platform: z.string() }) },
  read: { input: z.object({ path: z.string() }), output: bundleSchema },
  open: { input: z.object({ bundle: bundleSchema, action: z.enum(['open', 'save']) }), output: z.object({ path: z.string(), application: z.string() }) },
  launch: { input: z.object({ path: z.string() }), output: z.object({ path: z.string(), application: z.string() }) },
});
export const rpcContract = defineRpcContract({ open: { input: targetSchema, output: z.object({ path: z.string(), application: z.string() }) } });
