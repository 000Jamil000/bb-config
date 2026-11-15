import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import type { ClaudeRoute } from './contract';
const run = promisify(execFile);
type Env = Record<string, string | undefined>;
export type Peer = { address: string; port: number };
export type ClaudeSnapshot = { env: Env; peers: Peer[]; readable: boolean };
const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'CLAUDE_CODE_HTTPS_PROXY', 'CLAUDE_CODE_HTTP_PROXY'];
const gatewayKeys = ['ANTHROPIC_BASE_URL', 'AGENT_PROXY_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL'];
const cloudKeys = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const routeKeys = [...proxyKeys, ...gatewayKeys, ...cloudKeys, 'NO_PROXY', 'no_proxy', 'CLAUDE_CONFIG_DIR'];
function onlyRoute(env: Env): Env { return Object.fromEntries(routeKeys.filter(k => env[k]).map(k => [k, env[k]])); }
function result(state: ClaudeRoute['state'], message: string): ClaudeRoute { return { state, message, checkedAt: new Date().toISOString() }; }
export function isClaudeProcess(args: string[]): boolean {
  return args.some(a => ['claude', 'claude-code'].includes(basename(a)) || /[/\\](?:@anthropic-ai[/\\]claude-code|provider-claude-code)[/\\]/.test(a));
}
export function proxyEndpoint(env: Env): URL | null | 'ambiguous' {
  // Conflicting variables cannot reliably identify the CLI's chosen route.
  const urls = new Map<string, URL>();
  for (const key of proxyKeys) {
    if (!env[key]) continue;
    try {
      const url = new URL(env[key]!);
      if (!['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname) return 'ambiguous';
      urls.set(`${url.protocol}//${url.hostname}:${url.port}`, url);
    } catch { return 'ambiguous'; }
  }
  return urls.size > 1 ? 'ambiguous' : [...urls.values()][0] ?? null;
}
const address = (s: string) => s.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
export function classifyClaudeRoute(snapshot: ClaudeSnapshot, apiAddresses: string[], proxyAddresses: string[] = []): ClaudeRoute {
  if (!snapshot.readable) return result('unknown', 'Недостаточно прав для чтения параметров процесса Claude.');
  if (cloudKeys.some(k => snapshot.env[k] && snapshot.env[k] !== '0' && snapshot.env[k] !== 'false') || gatewayKeys.some(k => snapshot.env[k])) {
    return result('unknown', 'У Claude задан облачный провайдер или собственный API-адрес; прямой маршрут Anthropic не подтверждён.');
  }
  const proxy = proxyEndpoint(snapshot.env);
  if (proxy === 'ambiguous') return result('unknown', 'Параметры прокси неоднозначны; фактический маршрут не подтверждён.');
  const port = proxy ? Number(proxy.port || (proxy.protocol === 'https:' ? 443 : proxy.protocol.startsWith('socks') ? 1080 : 80)) : 0;
  const direct = snapshot.peers.some(p => p.port === 443 && apiAddresses.includes(address(p.address)));
  const proxied = !!proxy && snapshot.peers.some(p => p.port === port && proxyAddresses.includes(address(p.address)));
  if (direct && proxied) return result('unknown', 'Есть соединения и с Anthropic, и с прокси; маршрут запроса Claude неоднозначен.');
  if (proxied) return result('proxy', 'В процессе Claude этой папки обнаружено TCP-соединение с настроенным прокси. Доступность ответа API отдельно не проверяется.');
  if (direct) return result('direct', 'В процессе Claude этой папки обнаружено прямое TCP-соединение с IP api.anthropic.com. Системный VPN/TUN этой проверкой не определяется.');
  return result('unknown', proxy ? 'Прокси настроен, но активное соединение через него сейчас не обнаружено.' : 'Прокси в параметрах не обнаружен, но прямое соединение с Anthropic сейчас не подтверждено.');
}
export function linuxPeers(tables: string[], inodes: Set<string>): Peer[] {
  const peers: Peer[] = [];
  for (const table of tables) for (const line of table.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '01' || !inodes.has(fields[9])) continue;
    const [hex, port] = fields[2].split(':');
    const bytes = Buffer.from(hex, 'hex');
    // /proc uses native-endian 32-bit words, including for IPv6.
    if (bytes.length === 4) peers.push({ address: [...bytes].reverse().join('.'), port: parseInt(port, 16) });
    else if (bytes.length === 16) {
      for (let i = 0; i < 16; i += 4) bytes.subarray(i, i + 4).reverse();
      if (bytes.subarray(0, 12).equals(Buffer.from('00000000000000000000ffff', 'hex'))) {
        peers.push({ address: [...bytes.subarray(12)].join('.'), port: parseInt(port, 16) }); continue;
      }
      const ip = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':');
      // Node DNS uses compressed IPv6; normalize both using URL below.
      peers.push({ address: normalizeIp(ip), port: parseInt(port, 16) });
    }
  }
  return peers;
}
function normalizeIp(ip: string): string {
  const stripped = address(ip);
  if (!stripped.includes(':')) return stripped;
  try { return address(new URL(`http://[${stripped}]/`).hostname); } catch { return stripped; }
}
async function settingsEnv(cwd: string, configDir: string): Promise<Env | null> {
  let env: Env = {};
  // Read only named settings, never credentials, history, databases or transcripts.
  const files = [join(configDir, 'settings.json'), join(configDir, 'settings.local.json'), join(cwd, '.claude/settings.json'), join(cwd, '.claude/settings.local.json'), platform() === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json'];
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.env && typeof data.env === 'object') env = { ...env, ...onlyRoute(data.env) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  // Supplementary managed fragments can override the main managed file.
  const managedDir = platform() === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.d' : '/etc/claude-code/managed-settings.d';
  try { if ((await readdir(managedDir)).some(f => f.endsWith('.json'))) return null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
  return env;
}
async function linuxSnapshots(cwd: string, threadId: string | null, signal?: AbortSignal): Promise<ClaudeSnapshot[]> {
  const candidates: { pid: string; env: Env }[] = [];
  for (const pid of await readdir('/proc')) {
    signal?.throwIfAborted();
    if (!/^\d+$/.test(pid)) continue;
    let args: string[];
    try { args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean); } catch { continue; }
    if (!isClaudeProcess(args)) continue;
    try {
      if (await realpath(`/proc/${pid}/cwd`) !== cwd) continue;
      const raw = Object.fromEntries((await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').filter(s => s.includes('=')).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
      if (threadId && raw.BB_THREAD_ID && raw.BB_THREAD_ID !== threadId) continue;
      candidates.push({ pid, env: onlyRoute(raw) });
    } catch { return [{ env: {}, peers: [], readable: false }]; }
  }
  if (candidates.length !== 1) return candidates.map(() => ({ env: {}, peers: [], readable: false }));
  const { pid, env } = candidates[0];
  try {
    const inodes = new Set<string>();
    for (const fd of await readdir(`/proc/${pid}/fd`)) {
      try { const match = (await readlink(`/proc/${pid}/fd/${fd}`)).match(/^socket:\[(\d+)\]$/); if (match) inodes.add(match[1]); } catch { /* Raced with a closing descriptor. */ }
    }
    const tables = await Promise.all(['tcp', 'tcp6'].map(t => readFile(`/proc/${pid}/net/${t}`, 'utf8')));
    return [{ env, peers: linuxPeers(tables, inodes), readable: true }];
  } catch { return [{ env, peers: [], readable: false }]; }
}
export function macPeers(text: string): Peer[] {
  return text.split('\n').flatMap(line => {
    const match = line.match(/^n.*->(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
    return match ? [{ address: normalizeIp(match[1] || match[2]), port: Number(match[3]) }] : [];
  });
}
async function macSnapshots(cwd: string, signal?: AbortSignal): Promise<ClaudeSnapshot[]> {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,command='], { signal, timeout: 1500, maxBuffer: 4 * 1024 * 1024 });
  const matches: ClaudeSnapshot[] = [];
  for (const line of stdout.split('\n')) {
    signal?.throwIfAborted();
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match || !isClaudeProcess(match[2].split(/\s+/))) continue;
    const pid = match[1];
    try {
      const location = await run('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { signal, timeout: 1000 });
      const directory = location.stdout.split('\n').find(s => s.startsWith('n'))?.slice(1);
      if (!directory || await realpath(directory) !== cwd) continue;
      // Never log raw ps output: it can contain authentication environment values.
      const raw = await run('/bin/ps', ['eww', '-p', pid, '-o', 'command='], { signal, timeout: 1000, maxBuffer: 1024 * 1024 });
      const env: Env = {};
      for (const key of routeKeys) {
        const value = raw.stdout.match(new RegExp(`(?:^|\\s)${key}=([^\\s]*)`));
        if (value) env[key] = value[1];
      }
      let peers: Peer[] = [];
      try { peers = macPeers((await run('/usr/sbin/lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:ESTABLISHED', '-Fn'], { signal, timeout: 1000 })).stdout); } catch { /* No established sockets. */ }
      matches.push({ env, peers, readable: true });
    } catch { matches.push({ env: {}, peers: [], readable: false }); }
    if (matches.length > 1) break;
  }
  return matches;
}
const dnsCache = new Map<string, { at: number; addresses: string[] }>();
async function addresses(host: string): Promise<string[]> {
  const name = host.replace(/^\[|\]$/g, '');
  const cached = dnsCache.get(name);
  if (cached && Date.now() - cached.at < 30_000) return cached.addresses;
  const found = (await lookup(name, { all: true })).map(item => normalizeIp(item.address));
  if (dnsCache.size > 64) dnsCache.clear();
  dnsCache.set(name, { at: Date.now(), addresses: found });
  return found;
}
export async function inspectClaudeRoute(path: string | null, threadId: string | null, signal?: AbortSignal): Promise<ClaudeRoute> {
  if (!path) return result('unknown', 'Сначала выберите рабочую папку Claude.');
  if (!['linux', 'darwin'].includes(platform())) return result('unsupported', 'Проверка процессов поддерживает Linux и macOS.');
  try {
    const cwd = await realpath(resolve(path));
    const snapshots = platform() === 'linux' ? await linuxSnapshots(cwd, threadId, signal) : await macSnapshots(cwd, signal);
    if (!snapshots.length) return result('inactive', 'В этой папке нет запущенного процесса Claude; текущий сетевой маршрут не подтверждён.');
    if (snapshots.length !== 1) return result('unknown', 'В этой папке несколько процессов Claude; нельзя надёжно определить процесс этого треда.');
    const snapshot = snapshots[0];
    const config = await settingsEnv(cwd, snapshot.env.CLAUDE_CONFIG_DIR ? resolve(homedir(), snapshot.env.CLAUDE_CONFIG_DIR.replace(/^~\//, '')) : join(homedir(), '.claude'));
    if (!config) return result('unknown', 'Не удалось полностью прочитать настройки маршрута Claude.');
    snapshot.env = { ...snapshot.env, ...config };
    const proxy = proxyEndpoint(snapshot.env);
    const [api, remoteProxy] = await Promise.all([addresses('api.anthropic.com').catch(() => []), proxy && proxy !== 'ambiguous' ? addresses(proxy.hostname).catch(() => []) : []]);
    signal?.throwIfAborted();
    return classifyClaudeRoute(snapshot, api, remoteProxy);
  } catch { return result('unknown', 'Не удалось проверить процесс Claude на этой машине.'); }
}
