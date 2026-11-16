import type { Account, QuotaWindow } from './contract.ts';
export function classifyWindow(label: string, kind?: unknown): QuotaWindow['kind'] {
  if (/fable|opus|sonnet|haiku|mythos/i.test(label)) return 'model';
  if (kind === 'five-hour' || /5.?hour|five.?hour|current session/i.test(label)) return 'five-hour';
  if (kind === 'weekly' || /week|7.?day|seven.?day/i.test(label)) return 'weekly';
  return 'other';
}
export function appliesToModel(window: QuotaWindow, model: string | null): boolean {
  if (window.kind !== 'model') return true;
  return model !== null && ['fable', 'opus', 'sonnet', 'haiku', 'mythos'].some(
    family => window.label.toLowerCase().includes(family) && model.toLowerCase().includes(family));
}
export function riskyOverride(names: readonly string[], providerId: string): boolean {
  const risky = providerId === 'codex'
    ? ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'OPENAI_API_BASE']
    : ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
  return names.some(name => risky.includes(name));
}
export function accountExhausted(account: Account): boolean {
  return account.status === 'ok' && account.windows.some(w =>
    (w.kind === 'five-hour' || w.kind === 'weekly') && w.usedPercent >= 100);
}
export function dedupeAccounts(accounts: Account[]): Account[] {
  const result = new Map<string, Account>();
  for (const account of accounts) {
    const key = account.email ? `${account.providerId}:${account.email.toLowerCase()}` : account.key;
    const previous = result.get(key);
    if (!previous) { result.set(key, { ...account, key }); continue; }
    const hosts = [...new Set([...previous.hostIds, ...account.hostIds])];
    const names = [...new Set([...previous.hostNames, ...account.hostNames])];
    const newer = account.status === 'ok' && (previous.status !== 'ok' ||
      Date.parse(account.fetchedAt ?? '') > Date.parse(previous.fetchedAt ?? ''));
    const chosen = newer ? account : previous;
    result.set(key, { ...chosen, key, hostIds: hosts, hostNames: names,
      resetCount: chosen.resetCount ?? (newer ? previous.resetCount : account.resetCount) ?? null });
  }
  return [...result.values()];
}
