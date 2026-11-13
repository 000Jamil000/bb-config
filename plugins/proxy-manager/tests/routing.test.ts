import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createRouting } from '../routing.ts';
const proxy = { id: 'de', name: 'DE', protocol: 'http' as const, host: 'proxy.test', port: 3128, username: '', password: '' };
const context = (providerId = 'codex') => makeMessageDispatchHookContext({ host: { id: 'mac' }, thread: { providerId } });
test('switch gates dispatch, stops only Codex on target host, then writes native config', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let stopping!: () => void;
  const entered = new Promise<void>(resolve => { stopping = resolve; });
  const { bb, harness } = createFakePluginHost({ pluginId: 'proxy-manager', sdk: { threads: {
    list: async (args: any) => { assert.equal(args.hostId, 'mac'); return args.archived ? [] : [makeThreadResponse({ id: 'codex-1', providerId: 'codex' }), makeThreadResponse({ id: 'claude-1', providerId: 'claude-code' })]; },
    stop: async ({ threadId }: any) => { calls.push(`stop:${threadId}`); stopping(); await waiting; return { ok: true }; },
    get: async () => makeThreadResponse({ status: 'idle' }),
  } }, experimental_callHostRpc: async ({ method, hostId }: any) => {
    assert.equal(hostId, 'mac'); calls.push(method);
    return method === 'verify_native' ? { matches: true } : { home: '/test/.codex', fingerprint: 'hash' };
  } } as any);
  try {
    const routing = createRouting(bb);
    const task = routing.apply('mac', proxy);
    await entered;
    const hook = harness.registrations.hooks['message.dispatch']!;
    assert.equal((await hook(context())).action, 'wait');
    assert.equal((await hook(context('claude-code'))).action, 'proceed');
    assert.ok(!calls.includes('apply_native'));
    release(); await task;
    assert.deepEqual(calls.slice(0, 3), ['prepare_native', 'stop:codex-1', 'apply_native']);
    assert.equal((await hook(context())).action, 'proceed');
    assert.equal((await routing.state('mac'))?.phase, 'ready');
  } finally { release(); await harness.lifecycle.dispose(); }
});
test('unconfirmed stop keeps Codex gated and never writes native files; drift gates later turns', async () => {
  let applyCalls = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: 'proxy-manager', sdk: { threads: {
    list: async (args: any) => args.archived ? [] : [makeThreadResponse({ id: 'c', providerId: 'codex' })],
    stop: async () => ({ ok: true }), get: async () => makeThreadResponse({ status: 'stopping' }),
  } }, experimental_callHostRpc: async ({ method }: any) => {
    if (method === 'apply_native') applyCalls++;
    return method === 'verify_native' ? { matches: false } : { home: '/test/.codex', fingerprint: 'hash' };
  } } as any);
  try {
    const routing = createRouting(bb);
    await assert.rejects(routing.apply('mac', proxy)); assert.equal(applyCalls, 0);
    const hook = harness.registrations.hooks['message.dispatch']!;
    assert.equal((await hook(context())).action, 'wait');
    await routing.set('mac', { phase: 'ready', proxyId: 'de', fingerprint: 'hash', message: '', updatedAt: new Date().toISOString() });
    assert.equal((await hook(context())).action, 'wait');
    assert.equal((await hook(context('claude-code'))).action, 'proceed');
  } finally { await harness.lifecycle.dispose(); }
});
