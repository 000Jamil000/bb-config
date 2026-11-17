import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { inspectGateway } from '../opencodex';
import { routeEnv, prepareModelRoute } from '../model-route';

test('gateway identity, nonstandard port, independent provider setup and fresh availability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-gateway-'));
  const config = join(root, 'gateway.json');
  let requests = 0; let identity = 'opencodex';
  const server = createServer((req, res) => {
    requests++; assert.equal(req.url, '/healthz');
    res.end(JSON.stringify({ service: identity, status: 'ok' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal((await inspectGateway('codex', true, config, root)).state, 'unconfigured');
    assert.equal(requests, 0);
    await writeFile(config, JSON.stringify({ port, providers: { openai: {}, anthropic: {} } }));
    assert.equal((await inspectGateway('codex', true, config, root)).state, 'unconfigured');
    const claude = await inspectGateway('claude-code', true, config, root);
    assert.equal(claude.state, 'available');
    assert.equal(routeEnv('claude-code', 'opencodex', undefined, claude.endpoint)[0]?.value, `http://127.0.0.1:${port}`);
    await writeFile(join(root, 'config.toml'), `openai_base_url="http://localhost:${port}/v1"\n`);
    assert.equal((await inspectGateway('codex', true, config, root)).state, 'available');
    const count = requests;
    await inspectGateway('codex', false, config, root);
    assert.equal(requests, count);
    identity = 'some-other-local-proxy';
    assert.equal((await inspectGateway('codex', true, config, root)).state, 'unavailable');
    await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()));
    assert.equal((await inspectGateway('claude-code', true, config, root)).state, 'unavailable');
    const direct = await prepareModelRoute('codex', 'direct', join(root, 'bb'), root);
    assert.equal(direct.env[0]?.name, 'CODEX_HOME');
    assert.equal(routeEnv('claude-code', 'direct')[0]?.value, 'https://api.anthropic.com');
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
