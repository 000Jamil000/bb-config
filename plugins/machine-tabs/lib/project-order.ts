/** Latest visible thread activity determines project order, independently of row sort. */
export function projectsByLatestThread<P extends { id: string }>(
  projects: readonly P[],
  threads: readonly {
    projectId: string;
    updatedAt?: number;
    createdAt?: number;
    isArchived?: boolean;
    isHidden?: boolean;
  }[],
): P[] {
  const latest = new Map<string, number>();
  for (const thread of threads) {
    if (thread.isArchived || thread.isHidden) continue;
    const at = thread.updatedAt ?? thread.createdAt ?? 0;
    latest.set(thread.projectId, Math.max(latest.get(thread.projectId) ?? 0, at));
  }
  // Stable ties preserve BB's project order; projects without threads go last.
  return [...projects].sort((a, b) => {
    const aHasThreads = latest.has(a.id);
    const bHasThreads = latest.has(b.id);
    return Number(bHasThreads) - Number(aHasThreads) ||
      (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0);
  });
}
