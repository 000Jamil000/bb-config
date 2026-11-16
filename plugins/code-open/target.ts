/** Where the editor opens. Mirrors KodaForge's own `kind/id` deep-link scopes. */
export type Target = { kind: 'thread' | 'environment' | 'project'; id: string };

export const FORGE_PREFIX = '/plugins/kodaforge/forge';

export function forgePath(target: Target): string {
  return `${FORGE_PREFIX}/${target.kind}/${encodeURIComponent(target.id)}`;
}

/** KodaForge keeps "chat panel open" per workspace under this localStorage key. */
export function chatOpenKey(target: Target): string {
  return `kodaforge:side:${target.kind}:${target.id}:open`;
}

export type ThreadLike = {
  environmentId: string | null;
  updatedAt?: number | null;
  archivedAt?: unknown;
  deletedAt?: unknown;
};

/**
 * A project can live on several machines, and KodaForge's own project scope
 * always opens the default one. Follow the work instead: open the workspace of
 * the project's most recently updated live thread. Without threads, fall back
 * to the project's default checkout.
 */
export function projectTarget(projectId: string, threads: readonly ThreadLike[]): Target {
  const live = threads
    .filter(thread => thread.environmentId && !thread.archivedAt && !thread.deletedAt)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  const environmentId = live[0]?.environmentId;
  return environmentId ? { kind: 'environment', id: environmentId } : { kind: 'project', id: projectId };
}

/** KodaForge keeps editor settings as one JSON object under this localStorage key. */
export const FORGE_SETTINGS_KEY = 'kodaforge:settings';
export const RESTORE_FLAG = 'code-open:kodaforge-settings-restored:v3';
export const OVERRIDDEN_KEYS = ['smoothScrolling', 'minimap', 'stickyScroll'] as const;

/**
 * Versions 0.3.0–0.3.2 overrode three KodaForge editor settings while chasing a
 * scroll stutter that turned out to come from machine-tabs CSS. Hand them back:
 * drop the three keys so KodaForge's own defaults apply again. Other keys stay.
 */
export function withoutOverrides(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rest = { ...(parsed as Record<string, unknown>) };
    for (const key of OVERRIDDEN_KEYS) delete rest[key];
    return Object.keys(rest).length ? JSON.stringify(rest) : null;
  } catch { return null; }
}
