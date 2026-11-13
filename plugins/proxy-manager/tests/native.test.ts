import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseEnv } from 'dotenv';
import { applyNative, prepareNative, verifyNative, editConfig, editEnv } from '../native-codex.ts';
const proxy = { id: 'de', name: 'DE', protocol: 'http' as const, host: 'proxy.test', port: 3128, username: 'user', password: 'a$HOME#\'"\\\n' };
test('native config preserves unrelated values and comments while disabling both bypass flags', () => {
  const original = '# personal\nmodel="example"\n[features]\n# keep\nsystem_proxy_fallback = true\nother=true\n[projects."/tmp"]\ntrust_level="trusted"\n';
  const next = editConfig(original);
  assert.ok(next.includes('# personal')); assert.ok(next.includes('# keep'));
  assert.deepEqual(JSON.parse(JSON.stringify(parseToml(next))), { model: 'example', features: { system_proxy_fallback: false, respect_system_proxy: false, other: true }, projects: { '/tmp': { trust_level: 'trusted' } } });
  assert.throws(() => editConfig('features = {other=true}'));
});
test('dotenv encodes credentials without interpolation and preserves unrelated settings', () => {
  const next = editEnv('KEEP="yes"\nhttps_proxy="http://old"\nNO_PROXY="*"\n', proxy);
  const env = parseEnv(next);
  assert.equal(env.KEEP, 'yes'); assert.equal(env.https_proxy, env.HTTPS_PROXY);
  assert.ok(!env.HTTPS_PROXY!.includes('$HOME')); assert.equal(decodeURIComponent(new URL(env.HTTPS_PROXY!).password), proxy.password);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  const direct = parseEnv(editEnv(next, null)); assert.equal(direct.HTTPS_PROXY, ''); assert.equal(direct.NO_PROXY, '*');
});
test('native apply creates private backups and refuses changed files before writing', async () => {
  const keys = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'];
  const inherited = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const home = await mkdtemp(join(tmpdir(), 'bb-native-test-'));
  try {
    await writeFile(join(home, 'config.toml'), '# original\nmodel="example"\n');
    const prepared = await prepareNative(proxy, home);
    await writeFile(join(home, '.env'), 'KEEP=changed\n');
    await assert.rejects(applyNative(proxy, prepared.fingerprint, home));
    assert.equal(await readFile(join(home, '.env'), 'utf8'), 'KEEP=changed\n');
    const current = await prepareNative(proxy, home);
    const applied = await applyNative(proxy, current.fingerprint, home);
    assert.notEqual(applied.fingerprint, current.fingerprint);
    const configPath = join(home, 'config.toml');
    await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('model="example"', 'model="other"'));
    assert.equal((await verifyNative(applied.fingerprint, home)).matches, true);
    assert.equal((await stat(join(home, '.env'))).mode & 0o777, 0o600);
    assert.equal(parseEnv(await readFile(join(home, '.env'), 'utf8')).KEEP, 'changed');
    assert.equal((parseToml(await readFile(join(home, 'config.toml'), 'utf8')).features as any).system_proxy_fallback, false);
    await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('system_proxy_fallback = false', 'system_proxy_fallback = true'));
    assert.equal((await verifyNative(applied.fingerprint, home)).matches, false);
  } finally {
    await rm(home, { recursive: true, force: true });
    for (const key of keys) { if (inherited[key] === undefined) delete process.env[key]; else process.env[key] = inherited[key]; }
  }
});
