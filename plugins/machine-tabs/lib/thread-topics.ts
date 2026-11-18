/** Local title-based classification. Unknown topics remain ordinary conversations. */
export const TOPICS = [
  { id: "design", label: "Дизайн", color: "#93704d", path: "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4C21 6.4 17 3 12 3ZM7.5 10h.01M10 6.5h.01M15 7h.01M6.5 14h.01", match: /дизайн|кастомизац|интерфейс|оформлен|design|customiz|\bui\b|\bux\b|sidebar/i },
  { id: "migration", label: "Миграция", color: "#8271a4", path: "M6 3v12a4 4 0 0 0 4 4h8M14 15l4 4-4 4M6 7h8a4 4 0 0 1 4 4v1M3 3h6", match: /миграц|перенос|репозитори|migration|migrate|repository/i },
  { id: "integration", label: "Подключение", color: "#4f8794", path: "m9 15 6-6M8 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 7l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0", match: /подключ|интеграц|dolphin|proxy|прокси|connect|integration|\bapi\b|\bmcp\b/i },
  { id: "search", label: "Поиск чатов", color: "#ad8050", path: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM7 10h6M10 7v6", match: /пропал|пропали|чатов нет|найти.*чат|истори.*чат|missing|lost.*chat/i },
  { id: "code", label: "Разработка", color: "#538575", path: "m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18", match: /(?<![а-яё])код(а|у|е|ом|ы|ов)?(?![а-яё])|(?<![а-яё])баг|ошибк|разработ|рефактор|(?<![а-яё])тест|\bbuild|\bbugs?\b|\bcode\b|refactor|\btest/i },
  { id: "docs", label: "Документы", color: "#637da1", path: "M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 12h8M8 16h6", match: /отч[её]т|документ|план|report|document|planning/i },
  { id: "chat", label: "Обсуждение", color: "#71818d", path: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3V11.5a10 10 0 0 1 20 0ZM7 10h8M7 14h5", match: null },
] as const;
export type Topic = (typeof TOPICS)[number];
export function topicForTitle(title: string): Topic {
  return TOPICS.find(topic => topic.match?.test(title)) ?? TOPICS[TOPICS.length - 1]!;
}
export function matchesFilters(title: string, projectId: string, topicFilter: string, projectFilter: string): boolean {
  return (projectFilter === "all" || projectFilter === projectId) &&
    (topicFilter === "all" || topicForTitle(title).id === topicFilter);
}

/** "7 из 24": how many threads the search and filters left of the tab's total. */
export function shownOfTotal(shown: number, total: number): string {
  return `${shown} из ${total}`;
}

/** Keep the path to a matching child readable without including unrelated siblings. */
export function withAncestors<T extends { id: string; parentThreadId?: string | null }>(threads: readonly T[], matched: ReadonlySet<string>): Set<string> {
  const result = new Set(matched);
  const byId = new Map(threads.map(t => [t.id, t]));
  for (const id of matched) {
    const seen = new Set<string>([id]);
    let parent = byId.get(id)?.parentThreadId;
    while (parent && !seen.has(parent) && byId.has(parent)) {
      seen.add(parent);
      result.add(parent);
      parent = byId.get(parent)?.parentThreadId;
    }
  }
  return result;
}

/** What stands before a thread's title: its project's mark, or its topic's icon. */
export const ROW_MARKS = ["ask", "project", "topic"] as const;
export type RowMark = (typeof ROW_MARKS)[number];
export type RowMarkChoice = Exclude<RowMark, "ask">;
/** An unknown stored value never changes the rows on its own. */
export function rowMarkOf(value: unknown): RowMark {
  return (ROW_MARKS as readonly unknown[]).includes(value) ? (value as RowMark) : "ask";
}

