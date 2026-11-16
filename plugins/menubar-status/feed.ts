// The status feed: pure functions, so the ordering rules are testable.

export type AgentState = "needs" | "running" | "error" | "unread" | "idle";

export interface FeedThread {
  id: string;
  projectId: string;
  providerId?: string;
  title: string | null;
  status: string;
  parentThreadId?: string | null;
  hasPendingInteraction?: boolean;
  lastReadAt?: number | null;
  latestAttentionAt?: number;
  updatedAt: number;
}

export interface FeedItem {
  id: string;
  title: string;
  project: string;
  machine: string;
  /** Agent provider id, e.g. "claude-code" or "codex". */
  provider: string;
  state: AgentState;
  /** Last assistant reply, one line; empty when none is known. */
  snippet: string;
  updatedAt: number;
  url: string;
}

export interface Feed {
  generatedAt: number;
  counts: { needs: number; running: number; unread: number; error: number };
  items: FeedItem[];
}

const RANK: Record<AgentState, number> = {
  needs: 0,
  running: 1,
  error: 2,
  unread: 3,
  idle: 4,
};

export function stateOf(thread: FeedThread): AgentState {
  if (thread.hasPendingInteraction) return "needs";
  if (thread.status === "active") return "running";
  if (thread.status === "error" || thread.status === "failed") return "error";
  const attention = thread.latestAttentionAt ?? 0;
  if (attention > 0 && (thread.lastReadAt == null || attention > thread.lastReadAt)) {
    return "unread";
  }
  return "idle";
}

/** One line, at most `max` characters, cut at a word where possible. */
export function oneLine(text: string | null | undefined, max = 280): string {
  const flat = (text ?? "").replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

export function buildFeed(input: {
  threads: readonly FeedThread[];
  projectNames: ReadonlyMap<string, string>;
  machineNames: ReadonlyMap<string, string>;
  snippets: Readonly<Record<string, string>>;
  webUrl: string;
  maxItems: number;
  now: number;
}): Feed {
  const counts = { needs: 0, running: 0, unread: 0, error: 0 };
  const rows = input.threads.map((thread) => ({ thread, state: stateOf(thread) }));
  for (const { state } of rows) if (state !== "idle") counts[state] += 1;
  const base = input.webUrl.replace(/\/+$/, "");
  const items = rows
    // What needs a look comes first, then the most recent; subagents only
    // when they themselves need something.
    .filter(({ thread, state }) => thread.parentThreadId == null || state === "needs")
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.thread.updatedAt - a.thread.updatedAt)
    .slice(0, input.maxItems)
    .map(({ thread, state }) => ({
      id: thread.id,
      title: oneLine(thread.title, 60) || "Untitled",
      project: input.projectNames.get(thread.projectId) ?? "",
      machine: input.machineNames.get(thread.id) ?? "",
      provider: thread.providerId ?? "",
      state,
      snippet: input.snippets[thread.id] ?? "",
      updatedAt: thread.updatedAt,
      url: base ? `${base}/projects/${thread.projectId}/threads/${thread.id}` : "",
    }));
  return { generatedAt: input.now, counts, items };
}

/** Whether two feeds differ in anything but their timestamp. */
export function sameContent(a: Feed | null, b: Feed): boolean {
  if (a === null) return false;
  return JSON.stringify({ ...a, generatedAt: 0 }) === JSON.stringify({ ...b, generatedAt: 0 });
}
