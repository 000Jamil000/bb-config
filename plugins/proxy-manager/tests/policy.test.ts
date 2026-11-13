import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { curlConfig } from '../transport.ts';
const input = { name: 'DE', protocol: 'http' as const, host: 'proxy.example.test', port: 8080, username: 'test-user', password: 'test-secret' };
async function setup(options: Record<string, unknown> = {}) {
  const host = createFakePluginHost({ pluginId: 'proxy-manager', experimental_callHostRpc: async ({ method }: any) => method === 'verify_native' ? { matches: true } : { home: '/test/.codex', fingerprint: 'test-fingerprint' }, sdk: {
    threads: { list: async () => [], stop: async () => ({ ok: true }), get: async () => ({ status: 'idle' }) },
    hosts: { providerCliStatus: async () => ({ codex: { installed: true, versionUnsupported: false }, 'claude-code': { installed: false, versionUnsupported: false } }), list: async () => [makeHostResponse({ id: 'host_test', name: 'Test', status: 'connected' })], get: async () => makeHostResponse({ id: 'host_test', status: 'connected' }) },
    providers: { list: async () => [{ id: 'codex', displayName: 'Codex', available: true }, { id: 'claude-code', displayName: 'Claude', available: false }] },
  }, ...options } as any);
  await plugin(host.bb); return host;
}
test('public RPCs never return proxy credentials; duplicate names are rejected', async () => {
  const { harness } = await setup();
  try {
    const added = await harness.behavior.callRpc('add', input) as any;
    assert.equal(added.authenticated, true);
    const list = await harness.behavior.callRpc('list', null);
    assert.ok(!JSON.stringify(list).includes('test-secret')); assert.ok(!JSON.stringify(list).includes('test-user'));
    await assert.rejects(harness.behavior.callRpc('add', { ...input, name: 'de' }));
  } finally { await harness.lifecycle.dispose(); }
});
test('unavailable CLI cannot be bound; a bound proxy cannot be removed', async () => {
  const { harness } = await setup();
  try {
    const added = await harness.behavior.callRpc('add', input) as any;
    await assert.rejects(harness.behavior.callRpc('bind', { hostId: 'host_test', providerId: 'claude-code', proxyId: added.id }));
    await harness.behavior.callRpc('bind', { hostId: 'host_test', providerId: 'codex', proxyId: added.id });
    await assert.rejects(harness.behavior.callRpc('remove', { id: added.id }));
    await harness.behavior.callRpc('bind', { hostId: 'host_test', providerId: 'codex', proxyId: null });
    assert.deepEqual(await harness.behavior.callRpc('remove', { id: added.id }), { removed: true });
  } finally { await harness.lifecycle.dispose(); }
});
test('concurrent adds preserve both records', async () => {
  const { harness } = await setup();
  try {
    await Promise.all([harness.behavior.callRpc('add', input), harness.behavior.callRpc('add', { ...input, name: 'USA' })]);
    const list = await harness.behavior.callRpc('list', null) as any; assert.equal(list.proxies.length, 2);
  } finally { await harness.lifecycle.dispose(); }
});
test('curl receives credentials via escaped stdin config and disables inherited bypass', () => {
  const config = curlConfig({ ...input, id: 'p', password: 'quote"\nline' });
  assert.ok(config.includes('noproxy = ""')); assert.ok(config.includes('quote\\"\\nline'));
  assert.equal(curlConfig(null), 'proxy = ""\nnoproxy = "*"\n');
});
const context = { hostId: 'host_test', threadId: 'thread_test', projectId: null };
test('applying native Codex routing contributes no provider environment', async () => {
  const { harness } = await setup();
  try {
    const added = await harness.behavior.callRpc('add', input) as any;
    await harness.behavior.callRpc('bind', { hostId: 'host_test', providerId: 'codex', proxyId: added.id });
    assert.deepEqual(await harness.behavior.resolveProviderEnv('codex', context), []);
    assert.deepEqual(await harness.behavior.resolveProviderEnv('claude-code', context), []);
    const list = await harness.behavior.callRpc('list', null) as any;
    assert.equal(list.routes.host_test.phase, 'ready');
  } finally { await harness.lifecycle.dispose(); }
});
test('catalog availability is insufficient when executable is missing on the chosen machine', async () => {
  const { harness } = await setup({ experimental_callHostRpc: async ({ method }: any) => method === 'verify_native' ? { matches: true } : { home: '/test/.codex', fingerprint: 'test-fingerprint' }, sdk: {
    threads: { list: async () => [], stop: async () => ({ ok: true }), get: async () => ({ status: 'idle' }) },
    hosts: { providerCliStatus: async () => ({ codex: { installed: false, versionUnsupported: false } }), get: async () => makeHostResponse({ id: 'host_test', status: 'connected' }) },
    providers: { list: async () => [{ id: 'codex', displayName: 'Codex', available: true }] },
  } });
  try {
    const providers = await harness.behavior.callRpc('providers', { hostId: 'host_test' }) as any;
    assert.equal(providers[0].available, false); assert.equal(providers[0].message, 'CLI не установлен');
    await assert.rejects(harness.behavior.callRpc('bind', { hostId: 'host_test', providerId: 'codex', proxyId: null }));
  } finally { await harness.lifecycle.dispose(); }
});
test('an applied route reports native configuration status', async () => {
  const { harness } = await setup();
  try {
    const added = await harness.behavior.callRpc('add', input) as any;
    await harness.behavior.callRpc('bind', { hostId: 'host_test', providerId: 'codex', proxyId: added.id });
    const route = await harness.behavior.callRpc('route_context', { threadId: null, hostId: 'host_test', environmentId: null, providerId: 'codex' }) as any;
    assert.equal(route.proxyName, 'DE'); assert.equal(route.applied, true); assert.equal(route.warning, null);
  } finally { await harness.lifecycle.dispose(); }
});

test('initial activation on idle applies once and clears the armed request', async () => {
  const { harness } = await setup();
  let stopped = false;
  harness.sdk.stub('threads.get', async () => makeThreadResponse({ id: 'thread_test', providerId: 'codex', environmentId: 'env_test', status: stopped ? 'idle' : 'active' }));
  harness.sdk.stub('environments.get', async () => ({ hostId: 'host_test' }) as any);
  harness.sdk.stub('threads.list', async (args: any) => args.archived ? [] : [makeThreadResponse({ id: 'thread_test', providerId: 'codex' })]);
  harness.sdk.stub('threads.stop', async () => { stopped = true; return { ok: true }; });
  try {
    const added = await harness.behavior.callRpc('add', input) as any;
    const armed = await harness.behavior.runCli(['arm', 'thread_test', 'host_test', added.id]);
    assert.equal(armed.exitCode, 0); assert.equal(stopped, false);
    await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thread_test', status: 'idle' }), lastAssistantText: 'done' });
    assert.equal(stopped, true);
    const list = await harness.behavior.callRpc('list', null) as any;
    assert.equal(list.routes.host_test.phase, 'ready');
    const count = harness.inspection.sdk.callsTo('threads.stop').length;
    await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thread_test', status: 'idle' }), lastAssistantText: 'done' });
    assert.equal(harness.inspection.sdk.callsTo('threads.stop').length, count);
  } finally { await harness.lifecycle.dispose(); }
});

test('background monitor updates failure and recovery without touching Claude', async () => {
  let healthy = true;
  let checks = 0;
  const { bb, harness } = await setup({ experimental_callHostRpc: async ({ method, hostId }: any) => {
    if (method === 'check') {
      assert.equal(hostId, 'host_test'); checks++;
      return { ok: healthy, ip: '192.0.2.1', country: 'DE', city: null, openaiStatus: healthy ? 401 : null, message: healthy ? 'ok' : 'offline', checkedAt: new Date().toISOString(), latencyMs: 1 };
    }
    return method === 'verify_native' ? { matches: true } : { home: '/test/.codex', fingerprint: 'test-fingerprint' };
  } });
  try {
    const added = await harness.behavior.callRpc('add', input) as any;
    await harness.behavior.callRpc('bind', { hostId: 'host_test', providerId: 'codex', proxyId: added.id });
    await bb.storage.kv.set('bindings', [
      { hostId: 'host_test', providerId: 'codex', proxyId: added.id },
      { hostId: 'claude_host', providerId: 'claude-code', proxyId: added.id },
    ]);
    for (const ok of [true, false, true]) {
      healthy = ok;
      const before = checks;
      const service = harness.behavior.runService('connection-monitor');
      try {
        let observed = false;
        for (let i = 0; i < 50; i++) {
          await new Promise(resolve => setImmediate(resolve));
          const list = await harness.behavior.callRpc('list', null) as any;
          if (checks > before && list.checks[`host_test:${added.id}`]?.ok === ok) { observed = true; break; }
        }
        assert.equal(observed, true, JSON.stringify({ checks, before, ok, logs: harness.logEntries })); assert.equal(checks, before + 1);
      } finally { service.controller.abort(); await service.done; }
    }
  } finally { await harness.lifecycle.dispose(); }
});
