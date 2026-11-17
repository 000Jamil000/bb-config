import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { directConfig, prepareModelRoute, routeEnv } from '../model-route';

test('direct profile removes gateway catalog and provider override while preserving user tools', () => {
  const c = parse(directConfig('model="gpt-6-astra"\nmodel_catalog_json="gateway.json"\nopenai_base_url="http://127.0.0.1:10100/v1"\n[model_providers.openai]\nbase_url="http://127.0.0.1:10100/v1"\n[mcp_servers.test]\ncommand="node"\n'));
  assert.equal(c.openai_base_url, 'https://chatgpt.com/backend-api/codex');
  assert.equal(c.model_catalog_json, undefined);
  assert.equal((c.model_providers as any).openai, undefined);
  assert.equal((c.mcp_servers as any).test.command, 'node');
});

test('routing env never changes OS proxies or exposes credentials', () => {
  for (const mode of ['direct', 'opencodex'] as const) {
    assert.deepEqual(routeEnv('codex', mode, '/private/profile').map(e => e.name), ['CODEX_HOME']);
    assert.deepEqual(routeEnv('claude-code', mode).map(e => e.name), ['ANTHROPIC_BASE_URL']);
  }
  assert.throws(() => routeEnv('unknown', 'direct'));
});

test('preparation preserves native config, shares history, and does not overwrite refreshed profile login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-route-test-'));
  const source = join(root, 'native'); const data = join(root, 'bb');
  await mkdir(join(source, 'sessions'), { recursive: true });
  const original = 'openai_base_url="http://127.0.0.1:10100/v1"\n';
  await writeFile(join(source, 'config.toml'), original);
  await writeFile(join(source, 'auth.json'), '{"fixture":true}');
  const first = await prepareModelRoute('codex', 'direct', data, source);
  const home = first.env[0]!.value;
  assert.equal(await readFile(join(source, 'config.toml'), 'utf8'), original);
  assert.equal(await realpath(join(home, 'sessions')), await realpath(join(source, 'sessions')));
  await writeFile(join(home, 'auth.json'), '{"refreshed":true}');
  await prepareModelRoute('codex', 'direct', data, source);
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), '{"refreshed":true}');
  assert.equal(await readFile(join(source, 'auth.json'), 'utf8'), '{"fixture":true}');
  assert.equal((await prepareModelRoute('codex', 'opencodex', data, source)).env[0]!.value, source);
});

test('OpenCodex selection refuses a nonlocal native route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-route-test-'));
  await writeFile(join(root, 'config.toml'), 'openai_base_url="https://example.org/v1"');
  await assert.rejects(prepareModelRoute('codex', 'opencodex', join(root, 'bb'), root));
});
