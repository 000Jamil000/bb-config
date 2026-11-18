import { useEffect, useMemo, useRef, useState } from "react";
import { UrlLink, useSdk, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

import { matchesFilters } from "./thread-topics";
import { textMatches } from "./text-match";

type SearchThread = { id: string; projectId: string; title: string | null; titleFallback: string | null; environmentHostId: string | null; archivedAt: number | null };
export type SearchOptions = { archive: boolean; messages: boolean };

export function SearchSettings({ options, onChange }: {
  options: SearchOptions; onChange: (options: SearchOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        root.current?.querySelector("button")?.focus();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return <div ref={root} className="absolute right-3 top-1">
    <button type="button" aria-label="Настройки поиска" aria-expanded={open}
      onClick={() => setOpen(!open)}
      className="machine-tabs-search-settings flex size-5 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground focus-visible:outline focus-visible:outline-2"
      data-open={open ? "" : undefined}>
      <Icon name="SlidersHorizontal" className="size-3.5" />
    </button>
    {open ? <div role="group" aria-label="Настройки поиска"
      className="absolute right-0 top-7 z-[110] w-52 rounded-lg border border-border bg-popover p-2 text-xs text-popover-foreground shadow-lg">
      {([['archive', 'Включая архив'], ['messages', 'По тексту сообщений']] as const).map(([key, label]) =>
        <label key={key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-state-hover">
          <input type="checkbox" checked={options[key]}
            onChange={(event) => onChange({ ...options, [key]: event.target.checked })} />{label}
        </label>)}
      <p className="px-2 pt-1 text-[10px] text-muted-foreground">Поиск учитывает выбранную машину, тему и проект.</p>
    </div> : null}
  </div>;
}

/** Titles stay synchronous; archive metadata and indexed message search arrive later.
 * Query changes abort previous work, so stale responses cannot replace results.
 */
export function SearchExtras({ query, needles, options, machineId, topicFilter, projectFilter, localIds }: {
  query: string; needles: readonly string[]; options: SearchOptions;
  topicFilter: string; projectFilter: string; machineId: string | null; localIds: ReadonlySet<string>;
}) {
  const sdk = useSdk();
  const archiveCache = useRef<{ at: number; rows: SearchThread[] } | null>(null);
  const [result, setResult] = useState<{ key: string; rows: SearchThread[]; loading: boolean; error: boolean }>({ key: '', rows: [], loading: false, error: false });
  const [limit, setLimit] = useState(5);
  const [hasMore, setHasMore] = useState(false);
  const key = JSON.stringify([query.trim(), options.archive, options.messages, machineId]);
  useEffect(() => { setLimit(5); }, [key, topicFilter, projectFilter]);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    if (!query.trim() || (!options.archive && !options.messages)) return () => controller.abort();
    setResult({ key, rows: [], loading: true, error: false });
    setHasMore(false);
    const timer = window.setTimeout(async () => {
      const rows = new Map<string, SearchThread>();
      const publish = (loading: boolean, error = false) => {
        if (!signal.aborted) setResult({ key, rows: [...rows.values()], loading, error });
      };
      try {
        if (options.archive) {
          const addTitles = (threads: SearchThread[]) => {
            for (const thread of threads) {
              const title = `${thread.title ?? ''} ${thread.titleFallback ?? ''}`.toLowerCase();
              if (textMatches(title, needles)) rows.set(thread.id, thread);
            }
          };
          if (archiveCache.current && Date.now() - archiveCache.current.at < 60_000) addTitles(archiveCache.current.rows);
          else {
            const archived: SearchThread[] = [];
            for (let offset = 0; !signal.aborted; offset += 100) {
              const batch = await sdk.threads.list({ archived: true, limit: 100, offset, signal });
              archived.push(...batch);
              addTitles(batch);
              publish(true);
              if (batch.length < 100) break;
            }
            if (!signal.aborted) archiveCache.current = { at: Date.now(), rows: archived };
          }
        }
        if (options.messages) {
          const found = await sdk.threads.search({ query: query.trim(), limitPerGroup: "50", signal });
          const groups = options.archive ? [found.active, found.archived] : [found.active];
          for (const group of groups) for (const match of group.results) rows.set(match.thread.id, match.thread);
          if (!signal.aborted) setHasMore(groups.some((group) => group.total > group.results.length));
        }
        publish(false);
      } catch {
        if (!signal.aborted) publish(false, true);
      }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [sdk, key]);
  const rows = useMemo(() => result.key !== key ? [] : result.rows.filter((thread) =>
    (machineId === null || thread.environmentHostId === machineId) &&
    matchesFilters(thread.title ?? thread.titleFallback ?? "", thread.projectId, topicFilter, projectFilter) &&
    !localIds.has(thread.id)), [result, key, machineId, topicFilter, projectFilter, localIds]);
  if (!query.trim() || (!options.archive && !options.messages)) return null;
  const loading = result.key !== key || result.loading;
  return <section data-machine-tabs-page="" className="mx-2 mb-2 rounded-md border border-border/50 px-2 py-1 text-xs">
    <div className="flex items-center gap-2 py-1 text-[10px] text-muted-foreground" role="status">
      {loading ? 'Ищем дальше…' : result.error ? 'Не удалось завершить поиск. Измените запрос для повтора.' : rows.length ? 'Ещё найдено' : 'Других совпадений нет'}
    </div>
    {rows.slice(0, limit).map((thread) => <UrlLink key={thread.id}
      href={`/projects/${thread.projectId}/threads/${thread.id}`}
      className="flex items-center gap-2 rounded px-1 py-1.5 text-sidebar-foreground hover:bg-state-hover">
      <span className="min-w-0 flex-1 truncate">{thread.title ?? thread.titleFallback ?? 'Untitled'}</span>
      {thread.archivedAt !== null ? <span className="text-[9px] text-muted-foreground">Архив</span> : null}
    </UrlLink>)}
    {rows.length > 5 ? <div className="machine-tabs-pager">
      {limit < rows.length ? <button type="button" onClick={() => setLimit(limit + 5)}>↓ Показать ещё</button> : null}
      {limit > 5 ? <button type="button" onClick={() => setLimit(5)}>↑ Свернуть</button> : null}
    </div> : null}
    {hasMore && !loading ? <p className="py-1 text-[10px] text-muted-foreground">В сообщениях найдено больше. Уточните запрос — BB возвращает первые 50 тредов каждой категории.</p> : null}
  </section>;
}
