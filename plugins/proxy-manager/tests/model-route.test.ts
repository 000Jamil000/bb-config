import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, utimes } from 'node:fs/promises';
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
    assert.deepEqual(routeEnv('claude-code', mode, undefined, 'http://127.0.0.1:12345').map(e => e.name), ['ANTHROPIC_BASE_URL']);
  }
  assert.throws(() => routeEnv('unknown', 'direct'));
});

test('preparation preserves native config, shares history, and keeps one credential store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-route-test-'));
  const source = join(root, 'native'); const data = join(root, 'bb');
  await mkdir(source, { recursive: true });
  const original = 'openai_base_url="http://127.0.0.1:10100/v1"\n';
  await writeFile(join(source, 'config.toml'), original);
  await writeFile(join(source, 'auth.json'), '{"fixture":true}');
  const first = await prepareModelRoute('codex', 'direct', data, source);
  const home = first.env[0]!.value;
  assert.equal(await readFile(join(source, 'config.toml'), 'utf8'), original);
  // The native profile had no sessions yet: the shared folder is created, never two separate ones.
  assert.equal(await realpath(join(home, 'sessions')), await realpath(join(source, 'sessions')));
  // A refresh written in place reaches the native profile at once.
  await writeFile(join(home, 'auth.json'), '{"refreshed":1}');
  assert.equal(await readFile(join(source, 'auth.json'), 'utf8'), '{"refreshed":1}');
  // A refresh that replaced the link with a file of its own is carried over by the next preparation.
  await rm(join(home, 'auth.json'));
  await writeFile(join(home, 'auth.json'), '{"refreshed":2}');
  await utimes(join(home, 'auth.json'), new Date(), new Date(Date.now() + 5000));
  await prepareModelRoute('codex', 'direct', data, source);
  assert.equal(await readFile(join(source, 'auth.json'), 'utf8'), '{"refreshed":2}');
  assert.equal(await realpath(join(home, 'auth.json')), await realpath(join(source, 'auth.json')));
  // A new login in the native profile is what BB uses next.
  await writeFile(join(source, 'auth.json'), '{"account":"other"}');
  await prepareModelRoute('codex', 'direct', data, source);
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), '{"account":"other"}');
  assert.equal((await prepareModelRoute('claude-code', 'direct', data, source)).env[0]!.value, 'https://api.anthropic.com');
});

test('proxy environment, hooks and instructions follow the native profile, removal included', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-route-test-'));
  const source = join(root, 'native'); const data = join(root, 'bb');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'config.toml'), '');
  await writeFile(join(source, '.env'), 'HTTPS_PROXY=http://127.0.0.1:1\n');
  await writeFile(join(source, 'hooks.json'), '{"hooks":1}');
  await writeFile(join(source, 'AGENTS.md'), 'first');
  const home = (await prepareModelRoute('codex', 'direct', data, source)).env[0]!.value;
  assert.equal(await readFile(join(home, '.env'), 'utf8'), 'HTTPS_PROXY=http://127.0.0.1:1\n');
  await writeFile(join(source, 'AGENTS.md'), 'second');
  await rm(join(source, 'hooks.json'));
  await rm(join(source, '.env'));
  await prepareModelRoute('codex', 'direct', data, source);
  assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), 'second');
  await assert.rejects(readFile(join(home, 'hooks.json')));
  await assert.rejects(readFile(join(home, '.env')));
});

test('OpenCodex selection refuses a nonlocal native route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-route-test-'));
  await writeFile(join(root, 'config.toml'), 'openai_base_url="https://example.org/v1"');
  await assert.rejects(prepareModelRoute('codex', 'opencodex', join(root, 'bb'), root));
});
