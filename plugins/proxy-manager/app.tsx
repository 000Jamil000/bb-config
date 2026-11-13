import { useCallback, useEffect, useState, type FormEvent, type SVGProps } from 'react';
import { definePluginApp, useRealtime, useRpc, useComposer } from '@get-bb/plugin-sdk/app';
import type { rpcContract, Check, RouteContext, RouteState } from './contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import './proxy-ui.css';
function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  const paths: Record<string, string> = {
    Plus: 'M12 5v14M5 12h14',
    Laptop: 'M5 4h14v12H5zM3 16h18l1 4H2z',
    Server: 'M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6',
    RefreshCw: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M18 18A8 8 0 0 1 4 12',
    Network: 'M9 2h6v6H9zM2 16h6v6H2zM16 16h6v6h-6zM12 8v4M5 16v-4h14v4',
    Trash2: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    Settings2: 'M9.5 3h5l.5 2 2 1 2-.5 2.5 4-1.5 1.5v2l1.5 1.5-2.5 4-2-.5-2 1-.5 2h-5l-.5-2-2-1-2 .5-2.5-4L4.5 13v-2L3 9.5l2.5-4 2 .5 2-1 .5-2zM15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] ?? paths.Network}/></svg>;
}
type ProxyView = { id: string; name: string; protocol: 'http' | 'https'; host: string; port: number; authenticated: boolean };
type Machine = { id: string; name: string; connected: boolean };
type Provider = { id: string; name: string; available: boolean; message: string };
type Binding = { hostId: string; providerId: string; proxyId: string | null };
const selectClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm';
function Dot({ check, offline, checking, live = false }: { check?: Check; offline?: boolean; checking?: boolean; live?: boolean }) {
  const stale = check && Date.now() - Date.parse(check.checkedAt) > (live ? 90_000 : 5 * 60_000);
  const label = offline ? 'Машина офлайн' : checking ? 'Проверяется' : !check ? 'Не проверено' : stale ? 'Проверка устарела' : check.ok ? 'Доступен' : 'Недоступен';
  const color = offline ? 'bg-red-500' : checking ? 'bg-amber-500' : !check || stale ? 'bg-slate-400' : check.ok ? 'bg-emerald-500' : 'bg-red-500';
  return <span role="img" aria-label={label} title={check ? `${label}. ${check.message}. ${new Date(check.checkedAt).toLocaleString()}` : label} className={`inline-block size-2.5 shrink-0 rounded-full ${color} ${live && check?.ok && !stale && !offline ? 'proxy-dot-live' : ''}`} />;
}
function ProxiesPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [proxies, setProxies] = useState<ProxyView[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [providers, setProviders] = useState<Record<string, Provider[]>>({});
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [routes, setRoutes] = useState<Record<string, RouteState>>({});
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [hostId, setHostId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const emptyForm = { name: '', protocol: 'http' as 'http' | 'https', host: '', port: '3128', username: '', password: '' };
  const [form, setForm] = useState(emptyForm);
  const [, tick] = useState(0);
  const report = useCallback((e: unknown) => setError(e instanceof Error ? e.message : 'Операция не выполнена'), []);
  const refresh = useCallback(async () => {
    try { const data = await rpc.call('list'); setProxies(data.proxies); setBindings(data.bindings); setChecks(data.checks); setRoutes(data.routes); }
    catch (e) { report(e); }
  }, [rpc, report]);
  const discover = useCallback(async () => {
    try {
      const hosts = await rpc.call('machines'); setMachines(hosts); setHostId(old => old || hosts.find(h => h.connected)?.id || '');
      await Promise.all(hosts.filter(h => h.connected).map(async h => {
        try { setProviders(old => ({ ...old, [h.id]: [] })); const entries = await rpc.call('providers', { hostId: h.id }); setProviders(old => ({ ...old, [h.id]: entries })); setProviderErrors(old => ({ ...old, [h.id]: '' })); }
        catch { setProviderErrors(old => ({ ...old, [h.id]: 'Не удалось получить список CLI' })); }
      }));
    } catch (e) { report(e); }
    finally { setLoading(false); }
  }, [rpc, report]);
  useEffect(() => { void refresh(); void discover(); const timer = setInterval(() => { tick(x => x + 1); void refresh(); }, 5000); return () => clearInterval(timer); }, [refresh, discover]);
  useRealtime('changed', refresh);
  const action = async (key: string, fn: () => Promise<unknown>) => {
    if (pending[key]) return; setPending(old => ({ ...old, [key]: true })); setError('');
    try { await fn(); await refresh(); } catch (e) { report(e); } finally { setPending(old => ({ ...old, [key]: false })); }
  };
  const bind = (machine: string, proxyId: string | null) => action(`bind:${machine}`, async () => {
    await rpc.call('bind', { hostId: machine, providerId: 'codex', proxyId });
    await rpc.call('check', { hostId: machine, proxyId });
  });
  const add = (event: FormEvent) => { event.preventDefault(); void action('add', async () => {
    await rpc.call('add', { ...form, port: Number(form.port) }); setForm(emptyForm); setAdding(false);
  }); };
  const machine = machines.find(m => m.id === hostId);
  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-3xl space-y-9 px-6 py-7">
    <header className="flex items-center justify-between gap-4">
      <div><h1 className="text-lg font-semibold tracking-tight">Подключения</h1><p className="mt-1 text-sm text-muted-foreground">Прокси для Codex · проверка каждые 30 секунд</p></div>
      <Button size="sm" onClick={() => { setError(''); setAdding(true); }}><Icon name="Plus" className="mr-1.5 size-4"/>Добавить прокси</Button>
    </header>
    {error && !adding && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    <section className="space-y-3">
      <div className="flex items-center justify-between"><h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Машины</h2><Button size="icon" variant="ghost" className="size-7" aria-label="Обновить машины" onClick={() => void discover()}><Icon name="RefreshCw" className="size-3.5"/></Button></div>
      {loading && <p className="text-sm text-muted-foreground">Загрузка…</p>}
      {machines.map(m => <div key={m.id} className="overflow-hidden rounded-xl border border-border/70">
        <div className="flex items-center gap-2.5 bg-muted/30 px-4 py-3"><Icon name={m.name.toLowerCase().includes('mac') ? 'Laptop' : 'Server'} className="size-4 text-muted-foreground"/><h3 className="min-w-0 flex-1 truncate text-sm font-medium">{m.name}</h3><span className={`size-1.5 rounded-full ${m.connected ? 'bg-emerald-500' : 'bg-slate-400'}`} title={m.connected ? 'Машина на связи' : 'Машина офлайн'}/>{!m.connected && <span className="text-xs text-muted-foreground">Офлайн</span>}</div>
        {providerErrors[m.id] ? <p className="px-4 py-3 text-xs text-destructive">{providerErrors[m.id]}</p> : m.connected && !providers[m.id]?.length ? <p className="px-4 py-3 text-xs text-muted-foreground">Проверяю CLI…</p> : <div className="divide-y divide-border/50">{(providers[m.id] ?? []).filter(p => p.available || p.id === 'codex').map(p => {
          const binding = bindings.find(b => b.hostId === m.id && b.providerId === p.id);
          const route = routes[m.id];
          const enabled = m.connected && p.available && p.id === 'codex';
          const busy = pending[`bind:${m.id}`] || route?.phase === 'switching';
          const check = checks[`${m.id}:${binding?.proxyId ?? 'direct'}`];
          const needsApply = enabled && route?.phase !== 'ready';
          return <div key={p.id} className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2.5">
            <span className="min-w-24 flex-1 text-sm">{p.name}</span>
            {!enabled ? <span className="text-xs text-muted-foreground">{!p.available ? p.message : p.id !== 'codex' ? 'Без изменений' : 'Офлайн'}</span> : <div className="flex items-center gap-2">
              <Dot live check={route?.phase === 'ready' ? check : undefined} checking={!!busy}/>
              <select aria-label={`Прокси Codex · ${m.name}`} title="Смена прокси остановит текущие ответы Codex" className="h-8 max-w-48 rounded-md border-0 bg-muted/50 px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={binding?.proxyId ?? 'direct'} disabled={!!busy} onChange={e => void bind(m.id, e.target.value === 'direct' ? null : e.target.value)}>
                <option value="direct">Напрямую</option>{proxies.map(proxy => <option key={proxy.id} value={proxy.id}>{proxy.name}</option>)}
              </select>
              {busy ? <span className="text-xs text-muted-foreground">Переключение…</span> : needsApply ? <Button size="sm" variant="ghost" className="h-8" onClick={() => void bind(m.id, binding?.proxyId ?? null)}>{route?.phase === 'error' ? 'Повторить' : 'Включить'}</Button> : check && !check.ok ? <span role="img" aria-label={check.message} title={check.message} className="text-amber-600">⚠</span> : null}
            </div>}
          </div>;
        })}</div>}
      </div>)}
      <p className="text-xs text-muted-foreground">При смене прокси ответы Codex остановятся. История сохранится.</p>
    </section>
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Прокси <span className="ml-1 opacity-60">{proxies.length}</span></h2><select aria-label="Проверять прокси с машины" title="Машина для проверки" className="max-w-56 truncate rounded bg-transparent py-1 text-xs text-muted-foreground" value={hostId} onChange={e => setHostId(e.target.value)}>{machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
      {!proxies.length ? <button onClick={() => setAdding(true)} className="w-full rounded-xl border border-dashed border-border p-7 text-sm text-muted-foreground hover:bg-muted/30">＋ Добавить первый прокси</button> : <div className="divide-y divide-border/60">{proxies.map(p => {
        const key = `${hostId}:${p.id}`, result = checks[key];
        return <div key={p.id} className="flex items-center gap-3 py-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground"><Icon name="Network" className="size-4"/></span>
          <div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-sm font-medium">{p.name}<Dot check={result} offline={!!machine && !machine.connected} checking={pending[key]}/></p><p className="mt-0.5 truncate text-xs text-muted-foreground">{p.host}:{p.port}{result?.country ? ` · ${result.country}` : ''}</p></div>
          <Button size="icon" variant="ghost" className="size-8" aria-label={`Проверить ${p.name}`} disabled={!machine?.connected || pending[key]} onClick={() => void action(key, () => rpc.call('check', { hostId, proxyId: p.id }))}><Icon name="RefreshCw" className={`size-3.5 ${pending[key] ? 'animate-spin' : ''}`}/></Button>
          <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label={`Удалить ${p.name}`} disabled={bindings.some(b => b.proxyId === p.id) || pending[`remove:${p.id}`]} onClick={() => void action(`remove:${p.id}`, () => rpc.call('remove', { id: p.id }))}><Icon name="Trash2" className="size-3.5"/></Button>
        </div>;
      })}</div>}
    </section>
    <details className="text-xs text-muted-foreground"><summary className="w-fit cursor-pointer">Как работает подключение</summary><p className="mt-2 max-w-xl leading-relaxed">Прокси применяется на выбранной машине ко всем сессиям Codex с общими настройками, включая новые запуски вне BB. Цвет показывает доступность маршрута, а не вход в аккаунт. Claude не изменяется.</p></details>
    <Dialog open={adding} onOpenChange={setAdding}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Новый прокси</DialogTitle><DialogDescription>HTTP или HTTPS с поддержкой CONNECT.</DialogDescription></DialogHeader>
      <form onSubmit={add} className="space-y-4" autoComplete="off">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <label className="block space-y-1.5 text-sm"><span>Название</span><Input autoFocus required maxLength={80} placeholder="Например, DE" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/></label>
        <div className="grid grid-cols-[1fr_85px] gap-3"><label className="space-y-1.5 text-sm"><span>Адрес</span><Input required placeholder="IP или хост" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })}/></label><label className="space-y-1.5 text-sm"><span>Порт</span><Input required type="number" min={1} max={65535} value={form.port} onChange={e => setForm({ ...form, port: e.target.value })}/></label></div>
        <label className="flex items-center justify-between text-sm"><span>Протокол</span><select className={selectClass} value={form.protocol} onChange={e => setForm({ ...form, protocol: e.target.value as 'http' | 'https' })}><option value="http">HTTP</option><option value="https">HTTPS</option></select></label>
        <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">Логин и пароль <span className="text-xs text-muted-foreground">· если нужны</span></summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><Input aria-label="Логин прокси" placeholder="Логин" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}/><Input aria-label="Пароль прокси" type="password" autoComplete="new-password" placeholder="Пароль" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}/></div></details>
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setAdding(false)}>Отмена</Button><Button type="submit" disabled={pending.add}>{pending.add ? 'Добавляю…' : 'Добавить'}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </div></div>;
}

function RouteBadge() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const selection = composer.selection;
  const threadId = composer.scope.kind === 'new-thread' ? null : composer.scope.threadId;
  const environment = selection?.environment;
  const hostId = environment?.type === 'host' ? environment.hostId ?? null : environment?.type === 'provider' && environment.machine?.type === 'existing' ? environment.machine.hostId : null;
  const environmentId = environment?.type === 'reuse' ? environment.environmentId : null;
  const providerId = selection?.providerId ?? null;
  const [route, setRoute] = useState<RouteContext | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    try { const next = await rpc.call('route_context', { threadId, hostId, environmentId, providerId }); setRoute(next); setError(false); }
    catch { setRoute(null); setError(true); }
  }, [rpc, threadId, hostId, environmentId, providerId]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  useRealtime('changed', refresh);
  if (!route && !error) return null;
  if (route && route.providerId !== 'codex') return null;
  const warning = error ? 'Не удалось проверить подключение' : !route?.connected ? 'Машина офлайн' : route.warning || (route.check && !route.check.ok ? route.check.message : null);
  const detail = route ? `${route.hostName} · Codex · ${route.applied ? 'Проверка каждые 30 секунд' : 'Не применено'}` : 'Подключение Codex';
  return <div className="proxy-route flex w-fit items-center gap-1.5 px-1 text-xs text-muted-foreground" aria-label="Прокси Codex" title={detail}>
    <Icon name="Network" className="size-3.5" aria-label="Прокси"/>
    <Dot live check={route?.applied ? route.check ?? undefined : undefined} offline={route ? !route.connected : true}/>
    <span>{route?.proxyName ?? 'Напрямую'}</span>
    {warning && <span role="img" aria-label={warning} title={warning} className="text-amber-600">⚠</span>}
    <a href="/plugins/proxy-manager/proxies" aria-label="Настройки прокси" title="Настройки прокси" className="proxy-route-settings inline-flex size-6 items-center justify-center rounded hover:bg-muted focus-visible:outline focus-visible:outline-2">
      <Icon name="Settings2" className="size-3.5"/>
    </a>
  </div>;
}
export default definePluginApp(app => {
  app.composer.customize({ id: 'proxy-route', banners: [{ id: 'route', chrome: 'bare', component: RouteBadge }] });
  app.slots.navPanel({ id: 'proxies', title: 'Прокси', icon: 'Network', path: 'proxies', component: ProxiesPage });
  app.slots.settingsSection({ id: 'connections', title: 'Прокси и подключения', component: ProxiesPage });
});
