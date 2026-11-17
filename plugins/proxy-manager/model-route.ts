import { inspectGateway } from './opencodex';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, copyFile, lstat, symlink, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';

export type ModelRoute = 'direct' | 'opencodex';
export const DIRECT_CODEX = 'https://chatgpt.com/backend-api/codex';
export const DIRECT_CLAUDE = 'https://api.anthropic.com';

/** Only the BB-owned config is changed. Native login and session files stay put. */
export function directConfig(text: string): string {
  const config = parse(text);
  config.model_provider = 'openai';
  config.openai_base_url = DIRECT_CODEX;
  config.experimental_realtime_ws_base_url = 'https://api.openai.com/v1';
  delete config.model_catalog_json;
  const providers = config.model_providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) delete (providers as Record<string, unknown>).openai;
  return stringify(config);
}

export function routeEnv(provider: string, mode: ModelRoute, codexHome?: string, gateway?: string) {
  if (provider === 'codex') {
    if (!codexHome) throw new Error('Не подготовлена конфигурация Codex для BB');
    return [{ name: 'CODEX_HOME', value: codexHome, reason: `BB model route: ${mode}` }];
  }
  if (provider === 'claude-code' && mode === 'opencodex' && !gateway) throw new Error('OpenCodex не проверен');
  if (provider === 'claude-code') return [{ name: 'ANTHROPIC_BASE_URL', value: mode === 'direct' ? DIRECT_CLAUDE : gateway!, reason: `BB model route: ${mode}` }];
  throw new Error('Маршрут этого провайдера пока не поддерживается');
}

async function optional(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}
async function seed(source: string, target: string) {
  try { await copyFile(source, target, constants.COPYFILE_EXCL); }
  catch (e) { if (!['ENOENT', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
}

const pending = new Map<string, Promise<unknown>>();
export function prepareModelRoute(provider: string, mode: ModelRoute, dataDir: string, sourceHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'))) {
  const key = `${dataDir}:${provider}`;
  const previous = pending.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => prepare(provider, mode, dataDir, sourceHome));
  pending.set(key, next);
  void next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => {});
  return next;
}
async function prepare(provider: string, mode: ModelRoute, dataDir: string, sourceHome: string) {
  const gateway = mode === 'opencodex' && (provider === 'codex' || provider === 'claude-code') ? await inspectGateway(provider, false, undefined, sourceHome) : null;
  if (gateway && gateway.state !== 'available') throw new Error(gateway.message);
  if (provider === 'claude-code' && mode === 'opencodex' && !gateway) throw new Error('OpenCodex не проверен');
  if (provider === 'claude-code') return { env: routeEnv(provider, mode, undefined, gateway?.endpoint), message: 'Адрес применяется только к Claude Code в BB' };
  if (provider !== 'codex') throw new Error('Провайдер не поддерживается');
  const sourceConfig = await optional(join(sourceHome, 'config.toml'));
  if (mode === 'opencodex') {
    return { env: routeEnv(provider, mode, sourceHome), message: 'BB использует обычный профиль Codex с локальным шлюзом' };
  }
  const home = resolve(dataDir, 'codex-direct');
  if (home === resolve(sourceHome)) throw new Error('Профиль BB совпадает с обычным профилем Codex');
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Share session directories so existing BB conversations can be resumed.
  // Credentials are seeded once into a private profile, never returned over RPC.
  for (const name of ['sessions', 'archived_sessions', 'skills', 'plugins', 'rules', 'memories', 'attachments', 'generated_images', 'vendor_imports']) {
    const source = join(sourceHome, name), target = join(home, name);
    try { if (!(await lstat(source)).isDirectory()) continue; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    try {
      await lstat(target);
      if (await realpath(target) !== await realpath(source)) throw new Error('Каталог истории профиля BB уже указывает на другое место');
    }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  await seed(join(sourceHome, 'auth.json'), join(home, 'auth.json'));
  await seed(join(sourceHome, 'AGENTS.md'), join(home, 'AGENTS.md'));
  const hooks = await optional(join(sourceHome, 'hooks.json'));
  if (hooks && await optional(join(home, 'hooks.json')) !== hooks) await writeFile(join(home, 'hooks.json'), hooks, { mode: 0o600 });
  const content = directConfig(sourceConfig);
  const target = join(home, 'config.toml');
  if (await optional(target) !== content) {
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, target);
  }
  return { env: routeEnv(provider, mode, home), message: 'Прямой профиль Codex для BB; история доступна, обычный config.toml не изменён' };
}
