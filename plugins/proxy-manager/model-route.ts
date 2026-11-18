import { inspectGateway } from './opencodex';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, copyFile, lstat, stat, symlink, realpath, rm, utimes } from 'node:fs/promises';
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
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
async function replace(target: string, content: string) {
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, target);
}
/** A managed copy follows its source: rewritten when it differs, removed when the source is gone. */
async function mirror(source: string, target: string) {
  let content: string;
  try { content = await readFile(source, 'utf8'); }
  catch (e) { if (!missing(e)) throw e; await rm(target, { force: true }); return; }
  if (await optional(target) !== content) await replace(target, content);
}
/**
 * One credential store for both profiles. Where a file link is possible the BB
 * profile's auth.json is a link to the native one. If the CLI replaced that link
 * with a file of its own (an atomic rewrite after a token refresh), or no link can
 * be made, the newer of the two files wins and is carried to the other side, so a
 * rotated refresh token or a new login reaches both.
 */
export async function shareAuth(source: string, target: string) {
  const info = async (path: string) => { try { return await lstat(path); } catch (e) { if (missing(e)) return null; throw e; } };
  const [native, own] = [await info(source), await info(target)];
  if (own?.isSymbolicLink()) {
    if (native && await realpath(target).catch(() => '') === await realpath(source)) return;
    await rm(target, { force: true });
  } else if (own && (!native || own.mtimeMs > native.mtimeMs)) {
    // The BB profile holds the fresher credentials: the native profile gets them first.
    await replace(source, await readFile(target, 'utf8'));
    await rm(target, { force: true });
  } else if (own) await rm(target, { force: true });
  if (!await info(source)) return;
  try { await symlink(source, target, 'file'); }
  catch (e) {
    // No privilege for file links (Windows without Developer Mode): a copy that keeps the source's time.
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    await copyFile(source, target);
    const times = await stat(source);
    await utimes(target, times.atime, times.mtime);
  }
}

const HISTORY = ['sessions', 'archived_sessions'];
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
  // Forced: this decides what a starting agent gets, so a cached answer about an earlier config is not enough.
  const gateway = mode === 'opencodex' && (provider === 'codex' || provider === 'claude-code') ? await inspectGateway(provider, true, undefined, sourceHome) : null;
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
    // History must never split: the shared folders exist before either side can create its own.
    if (HISTORY.includes(name)) await mkdir(source, { recursive: true });
    // stat, not lstat: a native folder that is itself a link is still the folder to share.
    try { if (!(await stat(source)).isDirectory()) continue; } catch (e) { if (missing(e)) continue; throw e; }
    let existing: Awaited<ReturnType<typeof lstat>> | null = null;
    try { existing = await lstat(target); } catch (e) { if (!missing(e)) throw e; }
    if (existing && await realpath(target).catch(() => '') === await realpath(source)) continue;
    if (existing?.isSymbolicLink()) await rm(target, { force: true });
    else if (existing) throw new Error(`Каталог ${name} профиля BB разошёлся с обычным профилем Codex. Перенесите его содержимое в ${source} и удалите ${target}`);
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  await shareAuth(join(sourceHome, 'auth.json'), join(home, 'auth.json'));
  // Instructions, hooks and the proxy environment of the native profile apply here too, and stop applying when removed there.
  for (const name of ['AGENTS.md', 'hooks.json', '.env']) await mirror(join(sourceHome, name), join(home, name));
  const content = directConfig(sourceConfig);
  const target = join(home, 'config.toml');
  if (await optional(target) !== content) await replace(target, content);
  return { env: routeEnv(provider, mode, home), message: 'Прямой профиль Codex для BB; история доступна, обычный config.toml не изменён' };
}
