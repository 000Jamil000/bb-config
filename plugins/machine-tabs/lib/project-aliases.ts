export interface LinkedThread {
  id: string;
  projectId: string;
  parentThreadId?: string | null;
  isHidden?: boolean;
  isArchived?: boolean;
  pinnedAt?: number | null;
  isPinned?: boolean;
}

const isPinned = (thread: LinkedThread) =>
  Boolean(thread.isPinned) || thread.pinnedAt != null;

/** Additional native tree input for a project's own threads that bb lists
 * elsewhere: cross-project children (under the parent's project) and pinned
 * threads with their subtree (under Pinned).
 * Preserve objects, IDs and parent links: these are views, never new sessions.
 */
export function projectAliases<T extends LinkedThread>(
  threads: readonly T[], projectId: string, existing: readonly T[],
): T[] {
  const visible = threads.filter(t => !t.isHidden && !t.isArchived);
  const byId = new Map(visible.map(t => [t.id, t]));
  const present = new Set(existing.map(t => t.id));
  const selected = new Set<string>();
  for (const thread of visible) {
    if (thread.projectId !== projectId || present.has(thread.id)) continue;
    let root = thread;
    let pinned = isPinned(thread);
    const seen = new Set([root.id]);
    while (root.parentThreadId && byId.has(root.parentThreadId)) {
      const parent = byId.get(root.parentThreadId)!;
      if (seen.has(parent.id)) break;
      seen.add(parent.id);
      root = parent;
      pinned ||= isPinned(root);
    }
    if (pinned || root.projectId !== projectId) selected.add(thread.id);
  }
  // Include descendants so the alias has the same expandable subtree.
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of visible) {
      if (!selected.has(thread.id) && !present.has(thread.id) &&
          thread.parentThreadId && selected.has(thread.parentThreadId)) {
        selected.add(thread.id);
        changed = true;
      }
    }
  }
  return visible.filter(t => selected.has(t.id));
}
