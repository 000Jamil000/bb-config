import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { parse as parseEnv } from 'dotenv';
import type { StoredProxy } from './contract';
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
export function proxyEnv(proxy: StoredProxy | null) {
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const credentials = proxy && (proxy.username || proxy.password) ? `${encode(proxy.username)}:${encode(proxy.password)}@` : '';
  const url = proxy ? `${proxy.protocol}://${credentials}${proxy.host}:${proxy.port}` : '';
  return Object.fromEntries(proxyKeys.map(key => [key, key.toUpperCase() === 'NO_PROXY' ? proxy ? 'localhost,127.0.0.1,::1' : '*' : url]));
}
export function editEnv(text: string, proxy: StoredProxy | null) {
  const expected = { ...parseEnv(text), ...proxyEnv(proxy) };
  const kept = text.split(/\r?\n/).filter(line => !proxyKeys.some(key => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line))).join('\n').trimEnd();
  const result = kept + '\n' + Object.entries(proxyEnv(proxy)).map(([key, value]) => `${key}="${value}"`).join('\n') + '\n';
  if (!isDeepStrictEqual(parseEnv(result), expected)) throw new Error('Не удалось безопасно изменить многострочный .env');
  return result;
}
export function editConfig(text: string) {
  const parsed = parseToml(text);
  const features = parsed.features;
  if (features !== undefined && (typeof features !== 'object' || features === null || Array.isArray(features))) throw new Error('Некорректная таблица features');
  const expected = parseToml(text);
  expected.features ??= Object.create(null);
  Object.assign(expected.features as object, { system_proxy_fallback: false, respect_system_proxy: false });
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(line => /^\s*\[features\]\s*(?:#.*)?$/.test(line));
  let result: string;
  if (index >= 0) {
    let end = index + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
    const body = lines.slice(index + 1, end).filter(line => !/^\s*(system_proxy_fallback|respect_system_proxy)\s*=/.test(line));
    result = [...lines.slice(0, index + 1), 'system_proxy_fallback = false', 'respect_system_proxy = false', ...body, ...lines.slice(end)].join('\n');
  } else if (features === undefined) result = text.trimEnd() + '\n\n[features]\nsystem_proxy_fallback = false\nrespect_system_proxy = false\n';
  else throw new Error('Таблица features должна быть оформлена отдельной секцией [features]');
  if (!isDeepStrictEqual(parseToml(result), expected)) throw new Error('Не удалось сохранить остальные настройки Codex');
  return result;
}
function nativeHome() {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  if (!isAbsolute(home)) throw new Error('CODEX_HOME должен быть абсолютным путём');
  return home;
}
async function readOptional(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error('Ожидается небольшой обычный файл настроек Codex');
    return await readFile(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function snapshot(home: string) {
  const config = await readOptional(join(home, 'config.toml')), env = await readOptional(join(home, '.env'));
  return { config, env, fingerprint: createHash('sha256').update(JSON.stringify([home, config, env])).digest('hex') };
}
function routeFingerprint(home: string, files: { config: string | null; env: string | null }) {
  const env = parseEnv(files.env ?? '');
  const config = parseToml(files.config ?? '');
  const features = config.features as Record<string, unknown> | undefined;
  return createHash('sha256').update(JSON.stringify([home, proxyKeys.map(key => env[key] ?? null), features?.system_proxy_fallback, features?.respect_system_proxy])).digest('hex');
}
function checkInherited() {
  if (proxyKeys.some(key => !!process.env[key])) throw new Error('У процесса BB уже заданы proxy-переменные: они имеют приоритет над .env Codex');
}
export async function prepareNative(proxy: StoredProxy | null, home = nativeHome()) {
  checkInherited();
  const files = await snapshot(home);
  editConfig(files.config ?? ''); editEnv(files.env ?? '', proxy);
  return { home, fingerprint: files.fingerprint };
}
async function atomicWrite(path: string, content: string) {
  const temp = `${path}.proxy-${randomUUID()}`;
  try { await writeFile(temp, content, { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function applyNative(proxy: StoredProxy | null, expected: string, home = nativeHome()) {
  checkInherited();
  const files = await snapshot(home);
  if (files.fingerprint !== expected) throw new Error('Настройки Codex изменились во время переключения. Повторите применение');
  const config = editConfig(files.config ?? ''), env = editEnv(files.env ?? '', proxy);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const backup = join(home, '.bb-proxy-backups', randomUUID());
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await writeFile(join(backup, 'original.json'), JSON.stringify(files), { mode: 0o600, flag: 'wx' });
  try {
    await atomicWrite(join(home, 'config.toml'), config);
    await atomicWrite(join(home, '.env'), env);
  } catch {
    for (const [name, content] of [['config.toml', files.config], ['.env', files.env]] as const) {
      if (content === null) await unlink(join(home, name)).catch(() => {});
      else await atomicWrite(join(home, name), content);
    }
    throw new Error('Запись настроек не выполнена; сохранена резервная копия');
  }
  return { home, fingerprint: routeFingerprint(home, await snapshot(home)) };
}
export async function verifyNative(fingerprint: string, home = nativeHome()) {
  checkInherited();
  return { matches: routeFingerprint(home, await snapshot(home)) === fingerprint };
}
