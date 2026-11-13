import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract } from './contract';
import { prepareNative, applyNative, verifyNative } from './native-codex';
import { checkConnection, probeConnection } from './transport';
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    check: async ({ proxy, previous }, ctx) => previous ? probeConnection(proxy, previous, ctx.signal) : checkConnection(proxy, ctx.signal),
    prepare_native: async ({ proxy }) => prepareNative(proxy),
    apply_native: async ({ proxy, fingerprint }) => applyNative(proxy, fingerprint),
    verify_native: async ({ fingerprint }) => verifyNative(fingerprint),
  },
});
