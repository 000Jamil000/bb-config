import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const statusSchema = z.object({ state: z.enum(['ready', 'clean', 'unavailable']), message: z.string(), hostName: z.string().optional() });
export const contract = defineRpcContract({
  status: {
    input: z.object({ threadId: z.string().min(1) }), output: statusSchema,
    tags: input => ['push-state:' + input.threadId],
  },
});
export const hostContract = defineRpcContract({
  status: { input: z.object({ path: z.string().min(1) }), output: statusSchema, experimental_retryable: true },
});
