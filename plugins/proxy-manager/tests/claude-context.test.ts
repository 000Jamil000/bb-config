import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
test('Claude route reads its actual host and folder, ignores stale selection and never reuses Codex connectivity', async () => {
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: 'proxy-manager', settings: { vault: '[]' }, sdk: {
    threads: { get: async () => makeThreadResponse({ id: 'claude-thread', providerId: 'claude-code', environmentId: 'env-claude' }) },
    environments: { get: async () => ({ hostId: 'host-claude', path: '/test/project' }) },
    hosts: { get: async () => makeHostResponse({ id: 'host-claude', status: 'connected' }) },
  }, experimental_callHostRpc: async ({ method, input, hostId }: any) => {
    calls.push(method);
    assert.equal(method, 'claude_route');
    assert.equal(hostId, 'host-claude');
    assert.deepEqual(input, { path: '/test/project', threadId: 'claude-thread' });
    return { state: 'unknown', message: 'No active connection', checkedAt: new Date().toISOString() };
  } } as any);
  try {
    await plugin(bb);
    await bb.storage.kv.set('check:host-claude:direct', { ok: true, ip: '192.0.2.1', country: null, city: null, openaiStatus: 401, message: 'Codex only', checkedAt: new Date().toISOString(), latencyMs: 1 });
    const input = { threadId: 'claude-thread', hostId: 'wrong-selection', environmentId: null, providerId: 'codex' };
    const route = await harness.behavior.callRpc('route_context', input) as any;
    assert.equal(route.providerId, 'claude-code');
    assert.equal(route.check, null);
    assert.equal(route.applied, false);
    assert.equal(route.claudeRoute.state, 'unknown');
    await harness.behavior.callRpc('route_context', input);
    assert.deepEqual(calls, ['claude_route']);
    assert.equal(harness.inspection.sdk.callsTo('threads.stop').length, 0);
  } finally { await harness.lifecycle.dispose(); }
});
