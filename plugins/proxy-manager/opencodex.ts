import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';

export type GatewayStatus = { state: 'unconfigured' | 'unavailable' | 'available'; message: string; endpoint?: string };
const cache = new Map<string, { until: number; result: Promise<GatewayStatus> }>();
export const nativeCodexHome = () => resolve(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'));
export const gatewayConfigPath = () => join(process.env.OPENCODEX_HOME?.trim() || join(homedir(), '.opencodex'), 'config.json');

// No credentials, model calls, process starts or configuration writes.
export async function inspectGateway(provider: 'codex' | 'claude-code', force = false,
  configPath = gatewayConfigPath(), sourceHome = nativeCodexHome()): Promise<GatewayStatus> {
  const key = `${configPath}:${sourceHome}:${provider}`;
  const hit = cache.get(key);
  if (!force && hit && hit.until > Date.now()) return hit.result;
  const result = inspect(provider, configPath, sourceHome);
  cache.set(key, { until: Date.now() + 30_000, result });
  // Bound retained entries even when a host changes its configured paths.
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return result;
}
async function inspect(provider: 'codex' | 'claude-code', configPath: string, sourceHome: string): Promise<GatewayStatus> {
  const missing: GatewayStatus = { state: 'unconfigured', message: 'OpenCodex не настроен' };
  let endpoint: string;
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const entry = config.providers?.[provider === 'codex' ? 'openai' : 'anthropic'];
    if (!entry || typeof entry !== 'object' || entry.enabled === false ||
      !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) return missing;
    endpoint = `http://127.0.0.1:${config.port}`;
    if (provider === 'codex') {
      const native = parse(await readFile(join(sourceHome, 'config.toml'), 'utf8'));
      const providerName = native.model_provider ?? 'openai';
      const override = (native.model_providers as Record<string, { base_url?: unknown }> | undefined)?.[String(providerName)]?.base_url;
      const url = new URL(String(override ?? native.openai_base_url));
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        Number(url.port || 80) !== config.port || url.pathname.replace(/\/$/, '') !== '/v1' || url.username || url.password || url.search || url.hash) return missing;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM')
      return { state: 'unavailable', message: 'Не удалось прочитать настройки OpenCodex' };
    return missing;
  }
  try {
    const response = await fetch(`${endpoint}/healthz`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    // Bound the body as well as the request time; never return server data to the UI.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No health response');
    let body = ''; const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        body += decoder.decode(part.value, { stream: true });
        if (body.length > 16_384) throw new Error('Health response too large');
      }
    } finally { await reader.cancel(); }
    const health = JSON.parse(body);
    if (!response.ok || health.service !== 'opencodex' || health.status !== 'ok') throw new Error('Not OpenCodex');
    return { state: 'available', message: 'OpenCodex доступен. Доступ к моделям зависит от авторизации.', endpoint };
  } catch {
    return { state: 'unavailable', message: 'OpenCodex настроен, но не запущен или недоступен' };
  }
}
