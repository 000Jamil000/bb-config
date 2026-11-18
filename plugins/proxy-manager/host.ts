import { inspectGateway } from './opencodex';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { inspectClaudeRoute } from './claude-route';
import { hostContract } from './contract';
import { prepareNative, applyNative, verifyNative } from './native-codex';
import { checkConnection, probeConnection } from './transport';
import { prepareModelRoute } from './model-route';
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    inspect_gateway: async ({ providerId, force }) => { const { state, message } = await inspectGateway(providerId, force); return { state, message }; },
    prepare_model_route: ({ providerId, mode }, ctx) => prepareModelRoute(providerId, mode, ctx.experimental_paths.dataDir),
    claude_route: ({ path, threadId }, ctx) => inspectClaudeRoute(path, threadId, ctx.signal),
    check: async ({ proxy, previous }, ctx) => previous ? probeConnection(proxy, previous, ctx.signal) : checkConnection(proxy, ctx.signal),
    prepare_native: async ({ proxy }) => prepareNative(proxy),
    apply_native: async ({ proxy, fingerprint }) => applyNative(proxy, fingerprint),
    verify_native: async ({ fingerprint }) => verifyNative(fingerprint),
  },
});
