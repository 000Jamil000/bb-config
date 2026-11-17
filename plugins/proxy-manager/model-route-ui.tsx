import { useEffect, useState } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract, ModelRouteState } from './contract';

export function ModelRoutePanel({ machines }: { machines: { id: string; name: string; connected: boolean }[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [routes, setRoutes] = useState<ModelRouteState[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const refresh = async () => {
    try { setRoutes(await rpc.call('model_routes')); }
    catch { setError('Не удалось прочитать маршрут моделей'); }
  };
  useEffect(() => { void refresh(); }, [rpc]);
  useRealtime('changed', refresh);
  async function change(hostId: string, providerId: 'codex' | 'claude-code', mode: 'direct' | 'opencodex') {
    setBusy(`${hostId}:${providerId}`); setError('');
    try { await rpc.call('set_model_route', { hostId, providerId, mode }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить маршрут'); }
    finally { setBusy(''); }
  }
  return <section className="space-y-3 rounded-lg border border-border p-3">
    <div><h2 className="text-sm font-semibold">Маршрут моделей BB</h2>
      <p className="mt-1 text-xs text-muted-foreground">Для всех моделей выбранного агента. Системный VPN и отдельные приложения сохраняют свои настройки.</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {machines.map(machine => <div key={machine.id} className="space-y-2">
      <h3 className="text-xs text-muted-foreground">{machine.name}</h3>
      {(['codex', 'claude-code'] as const).map(providerId => {
        const current = routes.find(r => r.hostId === machine.id && r.providerId === providerId);
        const name = providerId === 'codex' ? 'Codex' : 'Claude Code';
        return <label key={providerId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{name}</span>
          <select aria-label={`Маршрут моделей ${name} · ${machine.name}`} className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={current?.mode ?? ''}
            disabled={!machine.connected || !!busy} onChange={e => void change(machine.id, providerId, e.target.value as 'direct' | 'opencodex')}>
            {!current && <option value="" disabled>Текущие настройки</option>}
            <option value="direct">Напрямую</option><option value="opencodex">Через OpenCodex</option>
          </select>
        </label>;
      })}
    </div>)}
    <p className="text-xs text-muted-foreground">Применяется к следующим запускам; текущие ответы завершаются. Напрямую доступны модели вашего аккаунта. Список моделей обновляется отдельно.</p>
    <p className="text-xs text-muted-foreground">Для прямого Codex создаётся отдельный профиль BB. Некоторым MCP-инструментам может потребоваться повторный вход.</p>
  </section>;
}
