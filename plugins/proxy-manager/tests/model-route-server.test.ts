import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeHostResponse, makeThreadResponse, makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../server';

test('BB route applies only to selected provider and defers active runtime stop until idle', async () => {
  const stopped: string[] = [];
  let broken = false;
  const { bb, harness } = createFakePluginHost({ pluginId: 'proxy-manager', sdk: {
    hosts: { get: async () => makeHostResponse({ id: 'h', status: 'connected' }) },
    threads: {
      list: async () => [makeThreadResponse({ id: 'idle', providerId: 'codex', status: 'idle' }), makeThreadResponse({ id: 'active', providerId: 'codex', status: 'active' }), makeThreadResponse({ id: 'claude', providerId: 'claude-code', status: 'idle' })],
      stop: async ({ threadId }: any) => { stopped.push(threadId); return { ok: true }; },
    },
  }, experimental_callHostRpc: async ({ method }: any) => {
    assert.equal(method, 'prepare_model_route');
    if (broken) throw new Error('offline');
    return { env: [{ name: 'CODEX_HOME', value: '/bb/direct', reason: 'BB route' }], message: 'prepared' };
  } } as any);
  try {
    await plugin(bb);
    await harness.behavior.callRpc('set_model_route', { hostId: 'h', providerId: 'codex', mode: 'direct' });
    assert.deepEqual(stopped, ['idle']);
    const ctx = { hostId: 'h', threadId: null, projectId: null };
    assert.equal((await harness.behavior.resolveProviderEnv('codex', ctx))[0]?.name, 'CODEX_HOME');
    assert.deepEqual(await harness.behavior.resolveProviderEnv('claude-code', ctx), []);
    await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'active', providerId: 'codex', status: 'idle' }), lastAssistantText: 'OK' });
    assert.deepEqual(stopped, ['idle', 'active']);
    broken = true;
    const guard = harness.registrations.hooks['message.dispatch']!;
    assert.equal((await guard(makeMessageDispatchHookContext({ host: { id: 'h' }, thread: { providerId: 'codex' } }))).action, 'wait');
  } finally { await harness.lifecycle.dispose(); }
});
