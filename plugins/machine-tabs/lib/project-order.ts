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

/** Replace saved per-project positions with the dynamic Projects anchor.
 * Keep Pinned/Threads and other section placements exactly where they were.
 * This is a view transform, not a write to the user's stored preferences.
 */
export function automaticProjectSectionOrder(order: readonly string[]): string[] {
  const result: string[] = [];
  let projects = false;
  for (const key of order) {
    if (key === "projects" || key.startsWith("project:")) {
      if (!projects) result.push("projects");
      projects = true;
    } else result.push(key);
  }
  return result;
}
