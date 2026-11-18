import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { hostContract, type RouteState, type StoredProxy } from './contract';
export function createRouting(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const key = (hostId: string) => `route:${hostId}`;
  const state = async (hostId: string) => (await bb.storage.kv.get<RouteState>(key(hostId))) ?? null;
  async function set(hostId: string, value: RouteState) {
    await bb.storage.kv.set(key(hostId), value); bb.realtime.publish('changed', {});
  }
  async function verify(hostId: string, route: RouteState) {
    if (route.phase !== 'ready' || !route.fingerprint) return false;
    try { return (await host.call('verify_native', { fingerprint: route.fingerprint }, { hostId })).matches; }
    catch { return false; }
  }
  async function prepare(hostId: string, proxy: StoredProxy | null) {
    return host.call('prepare_native', { proxy }, { hostId });
  }
  async function apply(hostId: string, proxy: StoredProxy | null) {
    const old = await state(hostId);
    if (old?.phase === 'ready' && old.proxyId === (proxy?.id ?? null) && await verify(hostId, old)) return;
    const prepared = await prepare(hostId, proxy);
    const base = { proxyId: proxy?.id ?? null, updatedAt: new Date().toISOString() };
    await set(hostId, { ...base, phase: 'switching', message: 'Переключение подключения' });
    try {
      const ids = new Set<string>();
      for (const archived of [false, true]) {
        for (let offset = 0; ; offset += 100) {
          const page = await bb.sdk.threads.list({ hostId, includeHidden: true, archived, limit: 100, offset });
          for (const thread of page) if (thread.providerId === 'codex') ids.add(thread.id);
          if (page.length < 100) break;
        }
      }
      for (const threadId of ids) {
        await bb.sdk.threads.stop({ threadId });
        const thread = await bb.sdk.threads.get({ threadId });
        if (!['idle', 'error'].includes(thread.status)) throw new Error('Остановка Codex ещё не подтверждена');
      }
      const result = await host.call('apply_native', { proxy, fingerprint: prepared.fingerprint }, { hostId });
      await set(hostId, { ...base, ...result, phase: 'ready', message: 'Настройки применены' });
    } catch {
      await set(hostId, { ...base, phase: 'error', message: 'Переключение не завершено. Повторите применение в настройках прокси' });
      throw new Error('Переключение не завершено; новые запросы Codex на этой машине приостановлены');
    }
  }
  bb.experimental_hooks.on('message.dispatch', async ctx => {
    if (ctx.thread.providerId !== 'codex' || !ctx.host) return { action: 'proceed' };
    const route = await state(ctx.host.id);
    if (!route) return { action: 'proceed' };
    if (route.phase !== 'ready') return { action: 'wait', reason: route.message };
    if (!await verify(ctx.host.id, route)) return { action: 'wait', reason: 'Настройки Codex изменились или машина недоступна. Повторите применение прокси' };
    return { action: 'proceed' };
  });
  return { state, set, prepare, apply, verify };
}
