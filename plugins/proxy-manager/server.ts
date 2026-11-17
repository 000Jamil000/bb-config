import { setTimeout as delay } from 'node:timers/promises';
import { createRouting } from './routing';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { hostContract, rpcContract, storedProxy, bindingSchema, modelRouteInput, modelRouteState, redact, parseProxyFile, type ClaudeRoute, type Check, type StoredProxy, type RouteContext, type RouteState, type ModelRouteState } from './contract';
export type { rpcContract } from './contract';
export default async function plugin(bb: BbPluginApi) {
  const secrets = bb.settings.define({ vault: { type: 'string', label: 'Хранилище учётных данных прокси', secret: true } });
  const routing = createRouting(bb, false);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const modelKey = (hostId: string, providerId: string) => `model-route:${hostId}:${providerId}`;
  async function modelRoutes(): Promise<ModelRouteState[]> {
    const result: ModelRouteState[] = [];
    for (const key of await bb.storage.kv.list('model-route:')) result.push(modelRouteState.parse(await bb.storage.kv.get(key)));
    return result;
  }
  for (const providerId of ['codex', 'claude-code'] as const) {
    bb.providers.experimental_contributeEnv(providerId, async ctx => {
      const saved = await bb.storage.kv.get<ModelRouteState>(modelKey(ctx.hostId, providerId));
      if (!saved) return [];
      const prepared = await host.call('prepare_model_route', { providerId, mode: saved.mode }, { hostId: ctx.hostId });
      return prepared.env;
    });
  }
  // Environment resolvers are fail-open in the SDK; hold a message if preparation fails.
  bb.experimental_hooks.on('message.dispatch', async ctx => {
    const native = await routing.guard(ctx);
    if (native.action === 'wait') return { action: 'wait', reason: native.reason! };
    if (!ctx.host || !['codex', 'claude-code'].includes(ctx.thread.providerId)) return { action: 'proceed' };
    const saved = await bb.storage.kv.get<ModelRouteState>(modelKey(ctx.host.id, ctx.thread.providerId));
    if (!saved) return { action: 'proceed' };
    try { await host.call('prepare_model_route', { providerId: saved.providerId, mode: saved.mode }, { hostId: ctx.host.id }); }
    catch { return { action: 'wait', reason: 'Не удалось подготовить выбранный маршрут модели. Проверьте Подключения → Маршрут моделей BB' }; }
    return { action: 'proceed' };
  });
  async function setModelRoute(input: z.infer<typeof modelRouteInput>) {
    return serialize(async () => {
      const machine = await bb.sdk.hosts.get({ hostId: input.hostId });
      if (machine.status !== 'connected') throw new Error('Машина недоступна');
      const prepared = await host.call('prepare_model_route', input, { hostId: input.hostId });
      const state = { ...input, message: prepared.message, updatedAt: new Date().toISOString() };
      await bb.storage.kv.set(modelKey(input.hostId, input.providerId), state);
      // Release only this provider's idle BB runtimes. Active turns finish first.
      for (let offset = 0; ; offset += 100) {
        const rows = await bb.sdk.threads.list({ hostId: input.hostId, includeHidden: true, limit: 100, offset });
        for (const thread of rows) if (thread.providerId === input.providerId) {
          if (thread.status === 'idle' || thread.status === 'error') await bb.sdk.threads.stop({ threadId: thread.id });
          else await bb.storage.kv.set(`model-restart:${thread.id}`, true);
        }
        if (rows.length < 100) break;
      }
      bb.realtime.publish('changed', {});
      await bb.experimental_hooks.recheck('message.dispatch');
      return state;
    });
  }
  async function read(): Promise<StoredProxy[]> { const { vault } = await secrets.get(); return z.array(storedProxy).parse(JSON.parse(vault || '[]')); }
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> { const next = queue.then(fn); queue = next.catch(() => {}); return next; }
  async function add(input: Omit<StoredProxy, 'id'>) { return serialize(async () => {
    const proxies = await read();
    if (proxies.some(p => p.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) throw new Error('Прокси с таким именем уже существует');
    if (proxies.length >= 100) throw new Error('Можно добавить до 100 прокси');
    const p = { ...input, id: randomUUID() }; await secrets.experimental_set({ vault: JSON.stringify([...proxies, p]) });
    bb.realtime.publish('changed', {}); return redact(p);
  }); }
  async function remove(id: string) { return serialize(async () => {
    const proxies = await read(); const next = proxies.filter(p => p.id !== id);
    if (next.length === proxies.length) return { removed: false };
    if ((await bindings()).some(b => b.proxyId === id)) throw new Error('Прокси используется: сначала измените подключения CLI');
    await secrets.experimental_set({ vault: JSON.stringify(next) });
    bb.realtime.publish('changed', {}); return { removed: true };
  }); }
  const checksInFlight = new Map<string, Promise<Check>>();
  function check(hostId: string, proxyId: string | null, signal?: AbortSignal, heartbeat = false): Promise<Check> {
    const key = `${hostId}:${proxyId ?? 'direct'}`;
    const running = checksInFlight.get(key);
    if (running) return running;
    const task = performCheck(hostId, proxyId, signal, heartbeat).finally(() => checksInFlight.delete(key));
    checksInFlight.set(key, task);
    return task;
  }
  async function performCheck(hostId: string, proxyId: string | null, signal?: AbortSignal, heartbeat = false) {
    const proxy = proxyId === null ? null : (await read()).find(p => p.id === proxyId);
    if (proxy === undefined) throw new Error('Прокси не найден');
    const machine = await bb.sdk.hosts.get({ hostId });
    let result: Check;
    try {
      if (machine.status !== 'connected') throw new Error('Машина не подключена');
      const previous = heartbeat ? (await bb.storage.kv.get<Check>(`check:${hostId}:${proxyId ?? 'direct'}`)) ?? undefined : undefined;
      result = await host.call('check', { proxy, ...(previous ? { previous } : {}) }, { hostId, signal });
    }
    catch { result = { ok: false, ip: null, country: null, city: null, openaiStatus: null, message: 'Проверка на выбранной машине не выполнена', checkedAt: new Date().toISOString(), latencyMs: 0 }; }
    signal?.throwIfAborted();
    await bb.storage.kv.set(`check:${hostId}:${proxyId ?? 'direct'}`, result);
    bb.realtime.publish('changed', {}); return result;
  }
  async function list() {
    const checks: Record<string, Check> = {};
    const rows = await bb.storage.kv.list('check:');
    for (const key of rows) checks[key.slice(6)] = (await bb.storage.kv.get<Check>(key))!;
    const routes: Record<string, RouteState> = {};
    for (const key of await bb.storage.kv.list('route:')) routes[key.slice(6)] = (await bb.storage.kv.get<RouteState>(key))!;
    return { proxies: (await read()).map(redact), bindings: await bindings(), checks, routes };
  }
  async function bindings() { return z.array(bindingSchema).parse((await bb.storage.kv.get('bindings')) ?? []); }
  async function bind(input: z.infer<typeof bindingSchema>) { return serialize(async () => {
    const machine = await bb.sdk.hosts.get({ hostId: input.hostId });
    if (machine.status !== 'connected') throw new Error('Машина недоступна');
    const available = await providers(input.hostId, true);
    if (input.providerId !== 'codex' || !available.some(p => p.id === input.providerId && p.available)) throw new Error('CLI недоступен или пока не поддерживается');
    if (input.proxyId !== null && !(await read()).some(p => p.id === input.proxyId)) throw new Error('Прокси не найден');
    const proxy = input.proxyId === null ? null : (await read()).find(p => p.id === input.proxyId)!;
    await routing.apply(input.hostId, proxy);
    const next = (await bindings()).filter(b => b.hostId !== input.hostId || b.providerId !== input.providerId);
    await bb.storage.kv.set('bindings', [...next, input]); bb.realtime.publish('changed', {}); await bb.experimental_hooks.recheck('message.dispatch'); return input;
  }); }
  async function loadProviders(hostId: string) {
    const [catalog, installation] = await Promise.all([
      bb.sdk.providers.list({ hostId }), bb.sdk.hosts.providerCliStatus({ hostId }),
    ]);
    return catalog.map(p => {
      const cli = installation[p.id];
      const available = p.available && cli?.installed === true && !cli.versionUnsupported;
      const message = !cli ? 'Не удалось подтвердить наличие CLI' : !cli.installed ? 'CLI не установлен' : cli.versionUnsupported ? 'Версия CLI не поддерживается' : !p.available ? 'Провайдер недоступен' : 'CLI доступен';
      return { id: p.id, name: p.displayName, installed: cli?.installed === true, available, message };
    });
  }
  const providerCache = new Map<string, { entries: Awaited<ReturnType<typeof loadProviders>>; expiresAt: number }>();
  const providerRequests = new Map<string, Promise<Awaited<ReturnType<typeof loadProviders>>>>();
  async function providers(hostId: string, force = false) {
    const cached = providerCache.get(hostId);
    if (!force && cached && Date.now() < cached.expiresAt) return cached.entries;
    const running = providerRequests.get(hostId);
    if (running) return running;
    const request = loadProviders(hostId).then(entries => {
      providerCache.set(hostId, { entries, expiresAt: Date.now() + 60_000 });
      return entries;
    }).finally(() => providerRequests.delete(hostId));
    providerRequests.set(hostId, request);
    return request;
  }
  bb.background.service('connection-monitor', {
    async start(signal) {
      while (!signal.aborted) {
        const started = Date.now();
        for (const binding of await bindings()) {
          if (signal.aborted) return;
          if (binding.providerId !== 'codex') continue;
          const route = await routing.state(binding.hostId);
          if (route?.phase !== 'ready' || route.proxyId !== binding.proxyId) continue;
          try { await check(binding.hostId, binding.proxyId, signal, true); }
          catch { if (signal.aborted) return; }
        }
        try { await delay(Math.max(1000, 30_000 - (Date.now() - started)), undefined, { signal }); }
        catch { if (signal.aborted) return; throw new Error('Мониторинг подключения прерван'); }
      }
    },
  });
  const claudeChecks = new Map<string, { at: number; result: Promise<ClaudeRoute> }>();
  function inspectClaude(hostId: string, path: string | null, threadId: string | null): Promise<ClaudeRoute> {
    const key = JSON.stringify([hostId, path, threadId]);
    const cached = claudeChecks.get(key);
    if (cached && Date.now() - cached.at < 4000) return cached.result;
    const result = host.call('claude_route', { path, threadId }, { hostId, timeoutMs: 7000 })
      .catch((): ClaudeRoute => ({ state: 'unknown', message: 'Проверка процесса Claude недоступна.', checkedAt: new Date().toISOString() }));
    if (claudeChecks.size > 100) claudeChecks.clear();
    claudeChecks.set(key, { at: Date.now(), result });
    return result;
  }
  bb.rpc.register(rpcContract, {
    route_context: async (input): Promise<RouteContext | null> => {
      let hostId = input.hostId, providerId = input.providerId;
      let path: string | null = null;
      if (input.threadId) {
        const thread = await bb.sdk.threads.get({ threadId: input.threadId });
        providerId = thread.providerId;
        if (thread.environmentId) {
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          hostId = environment.hostId; path = environment.path;
        }
      } else if (input.environmentId) {
        const environment = await bb.sdk.environments.get({ environmentId: input.environmentId });
        hostId = environment.hostId; path = environment.path;
      }
      if (!hostId || !providerId) return null;
      const machine = await bb.sdk.hosts.get({ hostId });
      const modelMode = (await bb.storage.kv.get<ModelRouteState>(modelKey(hostId, providerId)))?.mode ?? null;
      const binding = (await bindings()).find(b => b.hostId === hostId && b.providerId === providerId);
      const proxyId = binding?.proxyId ?? null;
      const proxy = proxyId ? (await read()).find(p => p.id === proxyId) : null;
      const route = providerId === 'codex' ? await routing.state(hostId) : null;
      const applied = !!route && await routing.verify(hostId, route);
      const warning = route ? applied ? null : route.phase === 'ready' ? 'Файлы настроек изменены или машина недоступна' : route.message : binding?.proxyId ? 'Настройка ещё не применена' : null;
      const claudeRoute = providerId === 'claude-code' && machine.status === 'connected'
        ? await inspectClaude(hostId, path, input.threadId) : null;
      return { modelMode, claudeRoute, hostId, hostName: machine.name, providerId, proxyId, proxyName: proxyId ? proxy?.name ?? 'Прокси не найден' : null, connected: machine.status === 'connected', check: providerId === 'codex' ? (await bb.storage.kv.get<Check>(`check:${hostId}:${proxyId ?? 'direct'}`)) ?? null : null, applied, warning };
    },
    model_routes: modelRoutes, set_model_route: setModelRoute,
    list, add, bind, remove: ({ id }) => remove(id), check: ({ hostId, proxyId }) => check(hostId, proxyId),
    machines: async () => (await bb.sdk.hosts.list()).map(h => ({ id: h.id, name: h.name, connected: h.status === 'connected' })),
    providers: ({ hostId, force }) => providers(hostId, force),
  });
  bb.events.on('thread.idle', async ({ thread }) => {
    if (await bb.storage.kv.get(`model-restart:${thread.id}`)) {
      await bb.storage.kv.delete(`model-restart:${thread.id}`);
      await bb.sdk.threads.stop({ threadId: thread.id });
    }
    const armed = await bb.storage.kv.get<z.infer<typeof bindingSchema> & { threadId: string }>('armed');
    if (!armed || armed.threadId !== thread.id) return;
    await bb.storage.kv.delete('armed');
    try { await bind(armed); } catch { bb.log.warn('Автоматическое применение Codex не завершено'); }
  });
  bb.cli.register({
    name: 'proxy-manager', summary: 'Прокси: список, импорт и проверка с выбранной машины',
    commands: [
      { name: 'model-route', summary: 'Маршрут моделей только в BB; системный VPN сохраняется', usage: 'bb proxy-manager model-route [<host-id> <codex|claude-code> <direct|opencodex>]' },
      { name: 'prepare', summary: 'Проверить возможность применения без изменений', usage: 'bb proxy-manager prepare <host-id> <proxy-id|direct>' },
      { name: 'apply', summary: 'Применить маршрут Codex и остановить его треды на машине', usage: 'bb proxy-manager apply <host-id> <proxy-id|direct>' },
      { name: 'arm', summary: 'Первое применение после завершения указанного треда', usage: 'bb proxy-manager arm <thread-id> <host-id> <proxy-id|direct>' },
      { name: 'list', summary: 'Список без паролей', usage: 'bb proxy-manager list' },
      { name: 'import', summary: 'Импорт файла Host/Port/Username/Password', usage: 'bb proxy-manager import <name> <absolute-file>' },
      { name: 'check', summary: 'Проверка прокси или прямого подключения', usage: 'bb proxy-manager check <host-id> <proxy-id|direct>' },
      { name: 'remove', summary: 'Удаление прокси', usage: 'bb proxy-manager remove <proxy-id>' },
    ],
    async run(argv) {
      const [command, ...args] = argv.filter(a => a !== '--json');
      try {
        let output: unknown;
        if (command === 'model-route' && args.length === 0) output = await modelRoutes();
        else if (command === 'model-route' && args.length === 3) output = await setModelRoute(modelRouteInput.parse({ hostId: args[0], providerId: args[1], mode: args[2] }));
        else if (command === 'prepare' && args.length === 2) {
          const proxy = args[1] === 'direct' ? null : (await read()).find(p => p.id === args[1]);
          if (proxy === undefined) throw new Error('Прокси не найден');
          output = await routing.prepare(args[0]!, proxy);
        }
        else if (command === 'apply' && args.length === 2) output = await bind({ hostId: args[0]!, providerId: 'codex', proxyId: args[1] === 'direct' ? null : args[1]! });
        else if (command === 'arm' && args.length === 3) {
          const [threadId, hostId, selected] = args as [string, string, string];
          const thread = await bb.sdk.threads.get({ threadId });
          if (!thread.environmentId || (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId !== hostId || thread.providerId !== 'codex') throw new Error('Тред не соответствует машине Codex');
          if (!(await providers(hostId)).some(p => p.id === 'codex' && p.available)) throw new Error('Codex недоступен');
          const proxy = selected === 'direct' ? null : (await read()).find(p => p.id === selected);
          if (proxy === undefined) throw new Error('Прокси не найден');
          await routing.prepare(hostId, proxy);
          const input = { threadId, hostId, providerId: 'codex', proxyId: proxy?.id ?? null };
          await bb.storage.kv.set('armed', input);
          await routing.set(hostId, { phase: 'switching', proxyId: input.proxyId, message: 'Первое применение после завершения текущего ответа', updatedAt: new Date().toISOString() });
          output = { scheduled: true, threadId, hostId };
          if (thread.status === 'idle' || thread.status === 'error') { await bb.storage.kv.delete('armed'); output = await bind(input); }
        }
        else if (command === 'list' && args.length === 0) output = await list();
        else if (command === 'import' && args.length === 2) {
          const path = args[1]!; if (!path.startsWith('/') || !(await stat(path)).isFile() || (await stat(path)).size > 65536) throw new Error('Ожидается абсолютный путь к небольшому текстовому файлу');
          output = await add(parseProxyFile(await readFile(path, 'utf8'), args[0]!));
        } else if (command === 'check' && args.length === 2) output = await check(args[0]!, args[1] === 'direct' ? null : args[1]!);
        else if (command === 'remove' && args.length === 1) output = await remove(args[0]!);
        else return { exitCode: 1, stderr: 'Команды: list; import <name> <absolute-file>; check <host-id> <proxy-id|direct>; remove <proxy-id>' };
        return { exitCode: 0, stdout: JSON.stringify(output) };
      } catch { return { exitCode: 1, stderr: 'Операция не выполнена. Проверьте параметры, доступность машины и уникальность имени.' }; }
    },
  });
}
