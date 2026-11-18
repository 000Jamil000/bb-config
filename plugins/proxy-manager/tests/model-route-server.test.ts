import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeHostResponse, makeThreadResponse, makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../server';

test('BB route applies only to selected provider and defers active runtime stop until idle', async () => {
  const stopped: string[] = [];
  let broken = false, failStop = false;
  const live: Record<string, string> = { active: 'active' };
  const { bb, harness } = createFakePluginHost({ pluginId: 'proxy-manager', sdk: {
    hosts: { get: async () => makeHostResponse({ id: 'h', status: 'connected' }) },
    threads: {
      list: async () => [makeThreadResponse({ id: 'idle', providerId: 'codex', status: 'idle' }), makeThreadResponse({ id: 'active', providerId: 'codex', status: 'active' }), makeThreadResponse({ id: 'claude', providerId: 'claude-code', status: 'idle' })],
      get: async ({ threadId }: any) => makeThreadResponse({ id: threadId, providerId: 'codex', status: live[threadId] ?? 'idle' }),
      stop: async ({ threadId }: any) => { if (failStop) throw new Error('stop failed'); stopped.push(threadId); return { ok: true }; },
    },
  }, experimental_callHostRpc: async ({ method, input }: any) => {
    if (method === 'inspect_gateway') {
      assert.equal(input.force, true);
      return { state: broken ? 'unavailable' : 'available', message: 'gateway status' };
    }
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
    live.active = 'idle';
    await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'active', providerId: 'codex', status: 'idle' }), lastAssistantText: 'OK' });
    assert.deepEqual(stopped, ['idle', 'active']);
    broken = true;
    await assert.rejects(harness.behavior.callRpc('set_model_route', { hostId: 'h', providerId: 'codex', mode: 'opencodex' }));
    assert.equal((await harness.behavior.callRpc('model_routes', null))[0]?.mode, 'direct');
    const guard = harness.registrations.hooks['message.dispatch']!;
    const held = await guard(makeMessageDispatchHookContext({ host: { id: 'h' }, thread: { providerId: 'codex' } }));
    assert.equal(held.action, 'wait');
    // A held message is retried on its own: the gateway may return without any event.
    assert.ok((held as any).sendAt > Date.now());
    // The start itself still gets the route prepared before the machine went away.
    assert.equal((await harness.behavior.resolveProviderEnv('codex', ctx))[0]?.value, '/bb/direct');
    broken = false;
    // A thread that cannot be stopped does not undo or fail the change; it is retried when idle.
    failStop = true; stopped.length = 0;
    const changed = await harness.behavior.callRpc('set_model_route', { hostId: 'h', providerId: 'codex', mode: 'opencodex' });
    assert.equal(changed.mode, 'opencodex');
    assert.deepEqual(stopped, []);
    failStop = false;
    await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'idle', providerId: 'codex', status: 'idle' }), lastAssistantText: 'OK' });
    assert.deepEqual(stopped, ['idle']);
    // Inherit: the record is gone and nothing is contributed any more.
    assert.equal(await harness.behavior.callRpc('set_model_route', { hostId: 'h', providerId: 'codex', mode: 'inherit' }), null);
    assert.deepEqual(await harness.behavior.callRpc('model_routes', null), []);
    assert.deepEqual(await harness.behavior.resolveProviderEnv('codex', ctx), []);
    assert.equal((await guard(makeMessageDispatchHookContext({ host: { id: 'h' }, thread: { providerId: 'codex' } }))).action, 'proceed');
  } finally { await harness.lifecycle.dispose(); }
});
