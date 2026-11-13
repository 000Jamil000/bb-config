// bb-plugin-machine-tabs — frontend.
//
// A sidebar thread list that is bb's own list plus a row of machine tabs.
// It loads a second instance of the bundled thread-list plugin's bundle with
// one hook wrapped: inside this plugin's list, `experimental_useSidebarThreads`
// returns only the selected machine's threads. Everything else — grouping
// menu, sections, sorting, drag and drop, row menus — is bb's code, unchanged.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentType } from "react";
import {
  definePluginApp,
  experimental_Icon as BbIcon,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract, TabsState } from "./server";
import { cn } from "@/lib/utils";

const TABS_CHANGED = "machine-tabs-changed";
const THREAD_LIST_PLUGIN = "thread-list";

/** The machine whose threads the wrapped list shows; null shows all. */
type Grouping = "none" | "project" | "machine" | "day";
type DayField = "updatedAt" | "createdAt";

/** What one instance of bb's list shows. */
interface ListView {
  /** Only this machine's threads; null shows every machine. */
  machineId: string | null;
  /** Only this project's threads. */
  projectId: string | null;
  /** Only threads of this day bucket (see {@link dayBucket}). */
  day: number | null;
  /** Split the flat list into day sections. */
  byDay: boolean;
  /** The timestamp a thread's day comes from. */
  dayField: DayField;
  /** Only these threads (the search filter, or the Last 5 block); null is no limit. */
  ids: ReadonlySet<string> | null;
  /** Draw the threads as one flat "Last 5" section. */
  recent: boolean;
}

const DEFAULT_VIEW: ListView = {
  machineId: null,
  projectId: null,
  day: null,
  byDay: false,
  dayField: "updatedAt",
  ids: null,
  recent: false,
};

/** A project's two-letter mark, shown before a thread's title. */
interface ProjectBadge {
  letters: string;
  name: string;
  /** Null for threads outside any project: a neutral grey mark. */
  hue: number | null;
}

/** Badges by thread id; null draws none. */
const ProjectBadges = createContext<ReadonlyMap<string, ProjectBadge> | null>(
  null,
);

const MachineFilter = createContext<ListView>(DEFAULT_VIEW);

// ------------------------------------------------- loading bb's own list ---

type ThreadListComponent = ComponentType<PluginThreadListProps>;
type Sdk = ReturnType<typeof useSdk>;
type AnyRecord = Record<string, unknown>;

interface ThreadLike {
  id: string;
  projectId: string;
  parentThreadId?: string | null;
  pinnedAt?: number | null;
  host: { id: string } | null;
  sectionId?: string | null;
  isPinned?: boolean;
  updatedAt?: number;
  createdAt?: number;
}

interface SidebarData {
  threads: readonly ThreadLike[];
  projects?: readonly { id: string }[];
  sections?: readonly unknown[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_SECTION_PREFIX = "machine-tabs-day-";
/** Buckets 0–6 are single days back from today; 7 is everything earlier. */
const EARLIER = 7;

function startOfToday(): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.getTime();
}

function dayBucket(thread: ThreadLike, field: DayField, todayStart: number) {
  const at = thread[field] ?? thread.updatedAt ?? 0;
  return Math.min(Math.max(0, Math.ceil((todayStart - at) / DAY_MS)), EARLIER);
}

function dayLabel(bucket: number, todayStart: number): string {
  if (bucket === 0) return "Today";
  if (bucket === 1) return "Yesterday";
  if (bucket === EARLIER) return "Earlier";
  return new Date(todayStart - bucket * DAY_MS).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** The threads a view shows, and only the projects that have some of them. */
function applyFilters<T extends SidebarData>(data: T, view: ListView): T {
  if (
    view.machineId === null &&
    view.projectId === null &&
    view.day === null &&
    view.ids === null
  ) {
    return data;
  }
  const todayStart = startOfToday();
  const threads = data.threads.filter(
    (thread) =>
      (view.ids === null || view.ids.has(thread.id)) &&
      (view.machineId === null || thread.host?.id === view.machineId) &&
      (view.projectId === null || thread.projectId === view.projectId) &&
      (view.day === null ||
        dayBucket(thread, view.dayField, todayStart) === view.day),
  );
  const projectIds = new Set(threads.map((thread) => thread.projectId));
  return {
    ...data,
    threads,
    ...(data.projects
      ? { projects: data.projects.filter((p) => projectIds.has(p.id)) }
      : {}),
  };
}

/**
 * Files every unpinned thread under a section for its day. bb's flat
 * ("Custom") organization draws them as its own sections.
 */
function groupByDay<T extends SidebarData>(data: T, field: DayField): T {
  const todayStart = startOfToday();
  const used = new Set<number>();
  const threads = data.threads.map((thread) => {
    if (thread.isPinned) return thread;
    const bucket = dayBucket(thread, field, todayStart);
    used.add(bucket);
    return { ...thread, sectionId: `${DAY_SECTION_PREFIX}${bucket}` };
  });
  const sections = [...used]
    .sort((a, b) => a - b)
    .map((bucket) => ({
      id: `${DAY_SECTION_PREFIX}${bucket}`,
      name: dayLabel(bucket, todayStart),
      createdAt: todayStart - bucket * DAY_MS,
      updatedAt: todayStart - bucket * DAY_MS,
    }));
  return { ...data, threads, sections };
}

function ProjectBadgeMark({ badge }: { badge: ProjectBadge }) {
  return (
    <span
      title={badge.name}
      aria-label={badge.hue === null ? badge.name : `Project ${badge.name}`}
      className="mr-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] px-[3px] align-[-2px] text-[9px] font-semibold leading-none tracking-tight"
      style={
        badge.hue === null
          ? {
              backgroundColor: "oklch(0.6 0 0 / 0.16)",
              color: "oklch(0.55 0 0)",
            }
          : {
              backgroundColor: `oklch(0.62 0.13 ${badge.hue} / 0.22)`,
              color: `oklch(0.5 0.14 ${badge.hue})`,
            }
      }
    >
      {badge.letters}
    </span>
  );
}

/** "example-project" → "MO", "ShotMark" → "SM", "root" → "RO". */
function projectLetters(name: string): string {
  const words = name
    .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => /\p{L}/u.test(word));
  const letters =
    words.length >= 2
      ? words[0]![0]! + words[1]![0]!
      : (words[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
}

function projectHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

const RECENT_SECTION_ID = "machine-tabs-recent";

/** The view's threads as one flat section, whatever they are pinned or nested under. */
function asRecentSection<T extends SidebarData>(data: T, view: ListView): T {
  const threads = data.threads
    .filter((thread) => view.ids?.has(thread.id))
    .map((thread) => ({
      ...thread,
      isPinned: false,
      pinnedAt: null,
      parentThreadId: null,
      sectionId: RECENT_SECTION_ID,
    }));
  return {
    ...data,
    threads,
    sections: [
      { id: RECENT_SECTION_ID, name: "Last 5", createdAt: 0, updatedAt: 0 },
    ],
  };
}

/**
 * Two instances of bb's list: "main" follows the user's preferences; "recent"
 * is pinned to the flat organization, so the Last 5 block looks the same
 * whatever grouping the main list uses.
 */
type ListKind = "main" | "recent";

const RECENT_PREFERENCES: AnyRecord = {
  organizationMode: "chronological",
  chronologicalSort: "updated",
  sortDirection: "default",
  groupByReadStatus: false,
  hiddenGroups: [],
  collapsedThreadSections: [],
  manualSectionOrder: ["pinned", "sections", "threads"],
};

const nativeListPromises = new Map<ListKind, Promise<ThreadListComponent>>();
/** Loads run one at a time: each swaps the shared SDK while its bundle evaluates. */
let loadQueue: Promise<unknown> = Promise.resolve();

/** Accepts any registration call and ignores it. */
function swallow(): unknown {
  const fn = () => undefined;
  return new Proxy(fn, { get: () => swallow(), apply: () => undefined });
}

async function loadNativeList(
  sdk: Sdk,
  kind: ListKind,
): Promise<ThreadListComponent> {
  const { plugins } = await sdk.plugins.list();
  const bundle =
    plugins.find((plugin) => plugin.id === THREAD_LIST_PLUGIN)?.app.bundle ??
    null;
  if (bundle === null) {
    throw new Error("bb's Thread list plugin is disabled; enable it first.");
  }

  const runtime = (globalThis as AnyRecord).__bbPluginRuntime as
    | AnyRecord
    | undefined;
  const real = runtime?.pluginSdkApp as AnyRecord | undefined;
  if (!runtime || !real) throw new Error("bb's plugin runtime is missing.");
  const base = ("default" in real ? real.default : real) as AnyRecord;

  const setups = new Map<unknown, (app: unknown) => void>();
  const useThreads = base.experimental_useSidebarThreads as (
    options?: unknown,
  ) => SidebarData;
  const define = base.definePluginApp as (
    setup: (app: unknown) => void,
  ) => unknown;

  // Identical to the real SDK outside <MachineFilter.Provider>, so a bundle
  // that happens to load while it is installed behaves as usual.
  const wrapped: AnyRecord = {
    ...base,
    definePluginApp(setup: (app: unknown) => void) {
      const definition = define(setup);
      setups.set(definition, setup);
      return definition;
    },
    experimental_useSidebarThreads(options?: unknown) {
      const result = useThreads(options);
      const view = useContext(MachineFilter);
      return useMemo(() => {
        if (view.recent) return asRecentSection(result, view);
        const filtered = applyFilters(result, view);
        return view.byDay ? groupByDay(filtered, view.dayField) : filtered;
      }, [result, view]);
    },
  };

  const separator = bundle.jsUrl.includes("?") ? "&" : "?";
  // A fresh URL every time: after a hot reload of this plugin the browser
  // would otherwise return the instance bound to the previous load.
  const RealTitle = base.ThreadTitle as ComponentType<{ threadId: string }>;
  wrapped.ThreadTitle = function TitleWithProjectBadge(props: {
    threadId: string;
  }) {
    const badge = useContext(ProjectBadges)?.get(props.threadId);
    return (
      <>
        {badge ? <ProjectBadgeMark badge={badge} /> : null}
        <RealTitle {...props} />
      </>
    );
  };

  if (kind === "recent") {
    // Its own preferences: read bb's, force the flat layout, save nothing.
    const useRealRpc = base.useRpc as () => {
      call(method: string, input: unknown): Promise<AnyRecord>;
    };
    wrapped.useRpc = function useRecentRpc() {
      const rpc = useRealRpc();
      return useMemo(
        () => ({
          ...rpc,
          async call(method: string, input: unknown) {
            if (method === "listPreferences") {
              const result = await rpc.call(method, input);
              return {
                ...result,
                preferences: {
                  ...(result.preferences as AnyRecord),
                  ...RECENT_PREFERENCES,
                },
              };
            }
            const { key, value } = (input ?? {}) as AnyRecord;
            return { key, value: value ?? RECENT_PREFERENCES[String(key)] };
          },
        }),
        [rpc],
      );
    };
    wrapped.useRealtime = () => undefined;
  }

  const url = `${bundle.jsUrl}${separator}machine_tabs=${kind}-${Date.now().toString(36)}`;
  let module: { default?: unknown };
  // The bundle reads the SDK from the shared runtime once, while it
  // evaluates. Swap the SDK in for that moment; if the runtime object is
  // read-only, swap the whole runtime for a copy that inherits from it.
  const globals = globalThis as AnyRecord;
  let restore: () => void;
  try {
    runtime.pluginSdkApp = wrapped;
  } catch {
    // Frozen runtime: handled below.
  }
  if (runtime.pluginSdkApp === wrapped) {
    restore = () => {
      runtime.pluginSdkApp = real;
    };
  } else {
    const copy = Object.create(runtime) as AnyRecord;
    Object.defineProperty(copy, "pluginSdkApp", { value: wrapped });
    globals.__bbPluginRuntime = copy;
    restore = () => {
      globals.__bbPluginRuntime = runtime;
    };
  }
  try {
    module = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  } finally {
    restore();
  }

  const setup = setups.get(module.default);
  if (!setup) throw new Error("Could not read bb's thread list bundle.");

  let component: ThreadListComponent | null = null;
  setup(
    new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "slots"
            ? new Proxy(
                {},
                {
                  get: (_slots, slot) =>
                    slot === "experimental_threadList"
                      ? (registration: { component: ThreadListComponent }) => {
                          component = registration.component;
                        }
                      : swallow(),
                },
              )
            : swallow(),
      },
    ),
  );
  if (component === null) {
    throw new Error("bb's thread list did not register a list.");
  }
  return component;
}

function useNativeList(kind: ListKind) {
  const sdk = useSdk();
  const [component, setComponent] = useState<ThreadListComponent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let promise = nativeListPromises.get(kind);
    if (!promise) {
      promise = loadQueue.then(() => loadNativeList(sdk, kind));
      loadQueue = promise.catch(() => undefined);
      nativeListPromises.set(kind, promise);
    }
    promise.then(
      (loaded) => {
        if (!cancelled) setComponent(() => loaded);
      },
      (cause: unknown) => {
        nativeListPromises.delete(kind);
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, kind]);
  return { component, error };
}

// ------------------------------------------------------------------ tabs ---

/** Survives remounts of the list, so the filter applies from the first paint. */
let lastTabsState: TabsState | null = null;

function useTabs() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setStateRaw] = useState<TabsState | null>(lastTabsState);
  const setState = useCallback((next: TabsState) => {
    lastTabsState = next;
    setStateRaw(next);
  }, []);

  const refetch = useCallback(() => {
    rpc.call("tabs_state", null).then(setState, () => undefined);
  }, [rpc, setState]);

  useEffect(() => {
    refetch();
    window.addEventListener("focus", refetch);
    return () => window.removeEventListener("focus", refetch);
  }, [refetch]);
  useRealtime(TABS_CHANGED, refetch);

  const select = useCallback(
    (machineId: string | null) => {
      // The list filters on the client, so switch at once.
      if (lastTabsState) setState({ ...lastTabsState, selectedId: machineId });
      rpc.call("tabs_select", { machineId }).then(setState, refetch);
    },
    [rpc, refetch, setState],
  );

  const setView = useCallback(
    (view: { byDay: boolean; outer: Grouping }) => {
      if (lastTabsState) setState({ ...lastTabsState, ...view });
      rpc.call("tabs_set_view", view).then(setState, refetch);
    },
    [rpc, refetch, setState],
  );

  return { state, select, setView };
}

const GROUPINGS: readonly { value: Grouping; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "machine", label: "Machine" },
  // Not a bb mode: this plugin splits bb's flat list into day sections.
  { value: "day", label: "Day" },
  { value: "none", label: "None" },
];

const SORT_OPTIONS = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Created" },
  { value: "alpha", label: "Name" },
] as const;

/** bb's organization mode that draws a grouping. Day and None use its flat list. */
function nativeMode(grouping: Grouping): string {
  return grouping === "project" || grouping === "machine"
    ? grouping
    : "chronological";
}

function MenuSection({
  title,
  options,
  current,
  onChoose,
}: {
  title: string;
  options: readonly { value: string; label: string }[];
  current: string | null;
  onChoose: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={title}>
      <div className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
        {title}
      </div>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={current === option.value}
          onClick={() => onChoose(option.value)}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm outline-none hover:bg-state-hover focus-visible:bg-state-hover"
        >
          <span className="flex-1">{option.label}</span>
          {current === option.value ? (
            <BbIcon name="Check" className="size-3.5" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Grouping and sorting of the list. One level is bb's own grouping; with a
 * second level the first is drawn by this plugin and bb's list, grouped by
 * the second, repeats inside each group.
 */
function OrganizeMenu({
  outer,
  byDay,
  onView,
  onSort,
  onMode,
  onChanged,
}: {
  outer: Grouping;
  byDay: boolean;
  onView: (view: { byDay: boolean; outer: Grouping }) => void;
  onSort: (sort: string | null) => void;
  onMode: (mode: string | null) => void;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [prefs, setPrefs] = useState<{
    mode: string | null;
    sort: string | null;
  }>({ mode: null, sort: null });
  const [open, setOpen] = useState(false);
  const onSortRef = useRef(onSort);
  onSortRef.current = onSort;
  const onModeRef = useRef(onMode);
  onModeRef.current = onMode;

  const refetch = useCallback(() => {
    rpc.call("listPreferences", null).then(
      ({ preferences }) => {
        const mode = preferences.organizationMode;
        const sort = preferences.chronologicalSort;
        setPrefs({
          mode: typeof mode === "string" ? mode : null,
          sort: typeof sort === "string" ? sort : null,
        });
        onSortRef.current(typeof sort === "string" ? sort : null);
        onModeRef.current(typeof mode === "string" ? mode : null);
      },
      () => undefined,
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("preferences", refetch);

  useEffect(() => {
    if (!open) return;
    refetch();
    const close = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, refetch]);

  const save = (changes: Record<string, string>) => {
    Promise.all(
      Object.entries(changes).map(([key, value]) =>
        rpc.call("setPreference", { key, value }),
      ),
    )
      // bb's list reads its preferences when it mounts, so remount it.
      .then(onChanged, () => undefined)
      .then(refetch);
  };

  // The grouping bb's list draws, and the two levels the menu shows.
  const inner: Grouping =
    prefs.mode === "project" || prefs.mode === "machine"
      ? prefs.mode
      : byDay
        ? "day"
        : "none";
  const first = outer === "none" ? inner : outer;
  const second = outer === "none" ? "none" : inner;

  const apply = (nextFirst: Grouping, nextSecond: Grouping) => {
    const twoLevels =
      nextFirst !== "none" && nextSecond !== "none" && nextFirst !== nextSecond;
    const nextOuter = twoLevels ? nextFirst : "none";
    const nextInner = twoLevels ? nextSecond : nextFirst;
    setPrefs((prev) => ({ ...prev, mode: nativeMode(nextInner) }));
    onModeRef.current(nativeMode(nextInner));
    onView({ outer: nextOuter, byDay: nextInner === "day" });
    save({ organizationMode: nativeMode(nextInner) });
  };

  return (
    <div
      className="relative shrink-0"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Group and sort threads"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Group and sort threads"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-state-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          open && "bg-state-active text-sidebar-foreground",
        )}
      >
        <BbIcon name="Layers" className="size-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 z-[200] min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <MenuSection
            title="Group by"
            options={GROUPINGS}
            current={first}
            onChoose={(value) => apply(value as Grouping, second)}
          />
          <div className="my-1 border-t" />
          <MenuSection
            title="Then by"
            options={GROUPINGS.filter(
              (option) => option.value === "none" || option.value !== first,
            )}
            current={second}
            onChoose={(value) => apply(first, value as Grouping)}
          />
          <div className="my-1 border-t" />
          <MenuSection
            title="Sort"
            options={SORT_OPTIONS}
            current={prefs.sort}
            onChoose={(value) => {
              setPrefs((prev) => ({ ...prev, sort: value }));
              save({ chronologicalSort: value, sortDirection: "default" });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function Tab({
  label,
  count,
  online = true,
  active,
  onClick,
}: {
  label: string;
  count: number;
  online?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  // Long names give way first; every tab keeps room for about six letters.
  const minWidth = `${Math.min(label.length, 6) * 0.45 + (count > 0 ? 2.1 : 1.2)}rem`;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={online ? label : `${label} (offline)`}
      onClick={onClick}
      style={{ flex: `0 ${Math.max(label.length, 1)} auto`, minWidth }}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        active
          ? "bg-state-active font-medium text-sidebar-foreground"
          : "text-muted-foreground hover:bg-state-hover hover:text-sidebar-foreground",
        !online && "opacity-60",
      )}
    >
      <span className="truncate">{label}</span>
      {count === 0 ? null : (
        <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </button>
  );
}

/** bb's list for one first-level group. The view is memoized: bb's list
 * recomputes everything when it changes. */
function FilteredList({
  List,
  base,
  group,
  listProps,
}: {
  List: ThreadListComponent;
  base: ListView;
  group: OuterGroup;
  listProps: PluginThreadListProps;
}) {
  const { machineId, projectId, day } = group.filter;
  const view = useMemo<ListView>(
    () => ({ ...base, machineId, projectId, day }),
    [base, machineId, projectId, day],
  );
  return (
    <MachineFilter.Provider value={view}>
      <List {...listProps} />
    </MachineFilter.Provider>
  );
}

// The same physical keys in the US and Russian layouts, so a query typed in
// the wrong layout ("ghbdtn" for "привет") still matches.
const EN_KEYS = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const RU_KEYS = "ёйцукенгшщзхъфывапролджэячсмитьбю";
const EN_TO_RU = new Map([...EN_KEYS].map((key, i) => [key, RU_KEYS[i]!]));
const RU_TO_EN = new Map([...RU_KEYS].map((key, i) => [key, EN_KEYS[i]!]));

function swapLayout(text: string, keys: ReadonlyMap<string, string>): string {
  return [...text].map((char) => keys.get(char) ?? char).join("");
}

const RECENT_COUNT = 5;
const COLLAPSED_KEY = "bb-machine-tabs:collapsed-groups";

/** Collapsed first-level groups, kept per browser. */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(
        window.localStorage.getItem(COLLAPSED_KEY) ?? "[]",
      );
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((v): v is string => typeof v === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Storage blocked: keep the in-memory state.
      }
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

interface OuterGroup {
  id: string;
  label: string;
  count: number;
  filter: Pick<ListView, "machineId" | "projectId" | "day">;
}

// Groups of bb's list that hold no thread: empty projects, machines and the
// loose "Threads" bucket. Hidden whenever the list is filtered, where they
// only say "No threads". A collapsed group has no rows either, but its
// header carries the expand button, so it stays.
const HIDE_EMPTY_GROUPS = `
[data-machine-tabs-hide-empty] [data-sidebar-visibility-group]:not(:has([data-sidebar-thread-id])):not(:has(button[aria-expanded="false"]:not([aria-haspopup]))) {
  display: none;
}
/* This plugin's sections (days, Last 5) are not bb sections: no New thread
   in section, no rename or delete menu. */
[data-sidebar-visibility-group^="section:machine-tabs-"] [data-sidebar-trailing-controls] {
  display: none;
}
/* The Last 5 block is a whole bb list: drop the space it leaves below itself. */
[data-machine-tabs-recent] [data-sidebar="group"] {
  padding-bottom: 0;
}
[data-machine-tabs-recent] [data-sidebar-visibility-group] {
  margin-bottom: 0;
}`;

function MachineThreadList(props: PluginThreadListProps) {
  const { state, select, setView } = useTabs();
  const { component: NativeList, error } = useNativeList("main");
  const { component: RecentList } = useNativeList("recent");
  const [query, setQuery] = useState("");
  const { threads, projects } = experimental_useSidebarThreads();
  const { collapsed, toggle } = useCollapsedGroups();
  const [sort, setSort] = useState<string | null>(null);
  const [innerMode, setInnerMode] = useState<string | null>(null);
  const [listKey, setListKey] = useState(0);

  const machines = state?.machines ?? [];
  const selectedId = state?.selectedId ?? null;
  const byDay = state?.byDay ?? false;
  const outer: Grouping = state?.outer ?? "none";
  const dayField: DayField = sort === "created" ? "createdAt" : "updatedAt";

  const live = useMemo(
    () => threads.filter((thread) => !thread.isArchived && !thread.isHidden),
    [threads],
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const thread of live) {
      if (thread.host) {
        map.set(thread.host.id, (map.get(thread.host.id) ?? 0) + 1);
      }
    }
    return map;
  }, [live]);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  // The search filter: thread ids whose title matches, or whose group header
  // would: project, machine, or day ("today", "yesterday", "12 nov").
  const matchIds = useMemo(() => {
    const typed = query.trim().toLowerCase();
    if (typed === "") return null;
    // Also what the same keys spell in the other keyboard layout.
    const needles = [...new Set([typed, swapLayout(typed, EN_TO_RU), swapLayout(typed, RU_TO_EN)])];
    const todayStart = startOfToday();
    return new Set(
      threads
        .filter((thread) =>
          [
            thread.displayTitle,
            projectNames.get(thread.projectId)?.name ?? "",
            thread.host?.name ?? "",
            dayLabel(dayBucket(thread, dayField, todayStart), todayStart),
          ].some((text) => {
            const haystack = text.toLowerCase();
            return needles.some((needle) => haystack.includes(needle));
          }),
        )
        .map((thread) => thread.id),
    );
  }, [threads, projectNames, query, dayField]);

  /** Live threads of the selected tab that pass the search filter. */
  const shown = useMemo(
    () =>
      live.filter(
        (thread) =>
          (selectedId === null || thread.host?.id === selectedId) &&
          (matchIds === null || matchIds.has(thread.id)),
      ),
    [live, selectedId, matchIds],
  );

  const baseView = useMemo<ListView>(
    () => ({
      ...DEFAULT_VIEW,
      machineId: selectedId,
      byDay,
      dayField,
      ids: matchIds,
    }),
    [selectedId, byDay, dayField, matchIds],
  );

  // Last 5: the most recently active threads, also listed in their own groups.
  const recentView = useMemo<ListView | null>(() => {
    if (shown.length === 0) return null;
    const ids = [...shown]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_COUNT)
      .map((thread) => thread.id);
    return { ...DEFAULT_VIEW, recent: true, ids: new Set(ids) };
  }, [shown]);

  const groupsByProject = outer === "project" || (outer === "none" && innerMode === "project");
  const badges = useMemo(() => {
    const map = new Map<string, ProjectBadge>();
    for (const thread of threads) {
      const project = projectNames.get(thread.projectId);
      if (!project) continue;
      map.set(
        thread.id,
        project.isPersonal
          ? { letters: "–", name: "No project", hue: null }
          : {
              letters: projectLetters(project.name),
              name: project.name,
              hue: projectHue(project.id),
            },
      );
    }
    return map;
  }, [threads, projectNames]);

  // First-level groups, each a filter for one instance of bb's list.
  const groups = useMemo<OuterGroup[]>(() => {
    if (outer === "none") return [];
    const count = new Map<string, number>();
    const bump = (key: string) => count.set(key, (count.get(key) ?? 0) + 1);
    const none = { machineId: selectedId, projectId: null, day: null };
    if (outer === "project") {
      for (const thread of shown) bump(thread.projectId);
      return projects
        .filter((project) => count.has(project.id))
        .map((project) => ({
          id: `project:${project.id}`,
          label: project.isPersonal ? "No project" : project.name,
          count: count.get(project.id) ?? 0,
          filter: { ...none, projectId: project.id },
        }));
    }
    if (outer === "machine") {
      for (const thread of shown) if (thread.host) bump(thread.host.id);
      return machines
        .filter((machine) => count.has(machine.id))
        .map((machine) => ({
          id: `machine:${machine.id}`,
          label: machine.name,
          count: count.get(machine.id) ?? 0,
          filter: { ...none, machineId: machine.id },
        }));
    }
    const todayStart = startOfToday();
    for (const thread of shown) {
      bump(String(dayBucket(thread, dayField, todayStart)));
    }
    return [...count.keys()]
      .map(Number)
      .sort((a, b) => a - b)
      .map((bucket) => ({
        id: `day:${bucket}`,
        label: dayLabel(bucket, todayStart),
        count: count.get(String(bucket)) ?? 0,
        filter: { ...none, day: bucket },
      }));
  }, [outer, shown, selectedId, projects, machines, dayField]);

  const hideEmpty =
    selectedId !== null || byDay || outer !== "none" || matchIds !== null;

  return (
    <>
      {machines.length < 2 ? null : (
        <div className="relative z-[100] flex items-center gap-1 px-2 pb-1.5 pt-0.5">
          <div
            role="tablist"
            aria-label="Machines"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
          >
            <Tab
              label="All"
              count={live.length}
              active={selectedId === null}
              onClick={() => select(null)}
            />
            {machines.map((machine) => (
              <Tab
                key={machine.id}
                label={machine.name}
                count={counts.get(machine.id) ?? 0}
                online={machine.online}
                active={selectedId === machine.id}
                onClick={() => select(machine.id)}
              />
            ))}
          </div>
          <OrganizeMenu
            outer={outer}
            byDay={byDay}
            onView={setView}
            onSort={setSort}
            onMode={setInnerMode}
            onChanged={() => setListKey((key) => key + 1)}
          />
        </div>
      )}
      <div className="relative z-[90] px-2 pb-1.5">
        <BbIcon
          name="Search"
          className="pointer-events-none absolute left-4 top-1.5 size-3.5 text-muted-foreground"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
          placeholder="Filter threads"
          aria-label="Filter threads"
          className="h-7 w-full rounded-md border border-transparent bg-state-hover pl-7 pr-7 text-xs text-sidebar-foreground outline-none placeholder:text-muted-foreground focus:border-sidebar-ring [&::-webkit-search-cancel-button]:hidden"
        />
        {query === "" ? null : (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground"
          >
            <BbIcon name="X" className="size-3.5" />
          </button>
        )}
      </div>
      <style>{HIDE_EMPTY_GROUPS}</style>
      <ProjectBadges.Provider value={badges}>
        {RecentList && recentView && state !== null ? (
          <>
            <div data-machine-tabs-hide-empty="" data-machine-tabs-recent="">
              <MachineFilter.Provider value={recentView}>
                <RecentList {...props} />
              </MachineFilter.Provider>
            </div>
            <div className="mx-3 mb-1.5 mt-1 border-b border-border" />
          </>
        ) : null}
      </ProjectBadges.Provider>
      {matchIds !== null && shown.length === 0 ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          No threads match “{query.trim()}”.
        </p>
      ) : null}
      {NativeList && state !== null ? (
        <ProjectBadges.Provider value={groupsByProject ? null : badges}>
        <div data-machine-tabs-hide-empty={hideEmpty ? "" : undefined}>
          {outer === "none" ? (
            <MachineFilter.Provider value={baseView}>
              <NativeList key={listKey} {...props} />
            </MachineFilter.Provider>
          ) : groups.length === 0 ? (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              No threads
            </p>
          ) : (
            groups.map((group) => {
              const isCollapsed = collapsed.has(group.id);
              return (
                <section key={group.id} className="pb-1">
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(group.id)}
                    className="group/outer mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-1.5 rounded-md px-2 text-left text-xs font-semibold text-sidebar-foreground outline-none hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    <BbIcon
                      name={isCollapsed ? "ChevronRight" : "ChevronDown"}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 truncate">{group.label}</span>
                    <span className="shrink-0 font-normal tabular-nums text-muted-foreground">
                      {group.count}
                    </span>
                  </button>
                  {isCollapsed ? null : (
                    <div className="ml-3 border-l border-border-hairline">
                      <FilteredList
                        key={listKey}
                        List={NativeList}
                        base={baseView}
                        group={group}
                        listProps={props}
                      />
                    </div>
                  )}
                </section>
              );
            })
          )}
        </div>
        </ProjectBadges.Provider>
      ) : error ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Machine tabs could not load bb's thread list: {error} Switch back
          under Settings → Appearance → Sidebar.
        </p>
      ) : null}
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "machine-tabs",
    title: "Thread list + machine tabs",
    description:
      "bb's thread list with a row of machine tabs that filter it by machine.",
    component: MachineThreadList,
  });
});
