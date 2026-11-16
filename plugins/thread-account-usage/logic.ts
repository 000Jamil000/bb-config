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

/** Monthly price of a plan in USD — a static table, shown as a hint only. */
export function planPrice(providerId: string, plan: string | null | undefined): string {
  const p = (plan ?? '').toLowerCase();
  if (!p) return '';
  if (/free/.test(p)) return '$0';
  if (providerId === 'claude-code') {
    if (/max/.test(p)) return /20/.test(p) ? '$200' : /5/.test(p) ? '$100' : '';
    if (/pro/.test(p)) return '$20';
  } else if (providerId === 'codex') {
    if (/pro/.test(p)) return '$200';
    if (/plus/.test(p)) return '$20';
  }
  return '';
}

/** "Pro $20", "Plus", or "" when the plan is unknown. */
export function planLabel(providerId: string, plan: string | null | undefined): string {
  if (!plan) return '';
  const price = planPrice(providerId, plan);
  return price ? `${plan} ${price}` : plan;
}
