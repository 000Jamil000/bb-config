import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { definePluginApp, useSdk, useBbNavigate, useSettings, useComposer, experimental_useSidebarThreads,
  experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { openNativeTerminal, openNativeWorkspace, waitFor } from './native';
import { finderFolderUrl } from './folder-target';

type Sdk = ReturnType<typeof useSdk>;
type Source = Awaited<ReturnType<Sdk['projects']['get']>>['sources'][number];
type Anchor = { projectId: string; hostId: string | null; element: HTMLElement };

function useProjectAnchors() {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  useEffect(() => {
    const mounts = new Map<HTMLElement, Anchor>();
    let frame = 0;
    const scan = () => {
      frame = 0;
      const rows = new Set(document.querySelectorAll<HTMLElement>('[data-sidebar-project-id]'));
      for (const [row, anchor] of mounts) {
        if (!rows.has(row) || !anchor.element.isConnected) { anchor.element.remove(); mounts.delete(row); }
      }
      for (const row of rows) {
        const hostId = row.closest<HTMLElement>('[data-machine-tabs-host-id]')?.dataset.machineTabsHostId || null;
        const projectId = row.dataset.sidebarProjectId!;
        const existing = mounts.get(row);
        if (existing) { existing.hostId = hostId; continue; }
        const trailing = row.querySelector<HTMLElement>('[data-sidebar="group-label"] [data-sidebar-trailing-controls]');
        if (!trailing) continue;
        const element = document.createElement('span');
        element.dataset.projectOpenControls = '';
        trailing.prepend(element);
        mounts.set(row, { projectId, hostId, element });
      }
      setAnchors(previous => {
        const next = [...mounts.values()];
        return next.length === previous.length && next.every((a, i) => a === previous[i]) ? previous : next;
      });
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-machine-tabs-host-id', 'data-sidebar-project-id'] });
    scan();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); for (const a of mounts.values()) a.element.remove(); };
  }, []);
  return anchors;
}

export function chooseSource(sources: readonly Source[], hostId: string | null): Source {
  const matching = hostId ? sources.filter(source => source.hostId === hostId) : sources;
  if (matching.length === 1) return matching[0]!;
  const preferred = matching.find(source => source.isDefault);
  if (preferred) return preferred;
  throw new Error(hostId ? 'У проекта нет однозначной папки на этой машине.' : 'Выбери машину проекта в боковой панели.');
}

function ProjectButtons({ anchor }: { anchor: Anchor }) {
  const sdk = useSdk(), navigate = useBbNavigate();
  const { values } = useSettings();
  const { threads } = experimental_useSidebarThreads();
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const run = async (kind: 'folder' | 'terminal') => {
    if (pending.current && !pending.current.signal.aborted) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true);
    try {
      const project = await sdk.projects.get({ projectId: anchor.projectId, signal: controller.signal });
      const source = chooseSource(project.sources, anchor.hostId);
      if (!source.path) throw new Error('У проекта пока нет рабочей папки.');
      if (kind === 'folder') {
        if (!values) throw new Error('Настройки открытия папки ещё загружаются.');
        if (values.finderHelper === true) {
          const url = finderFolderUrl(source.hostId, source.path);
          if (!navigate.openUrl(url)) throw new Error('На этом устройстве недоступен обработчик Finder.');
          return;
        }
        // BB's native workspace opener belongs to a thread. Never pick a worktree
        // in place of the project root, or another machine's checkout.
        const candidates = threads.filter(thread => thread.projectId === project.id &&
          thread.host?.id === source.hostId && thread.environment?.path === source.path && !thread.isArchived);
        const thread = candidates.find(thread => window.location.pathname.endsWith(`/threads/${thread.id}`)) ?? candidates[0];
        if (!thread) throw new Error('Для штатного Open нужен тред в корне проекта на этой машине. Открой такой тред или создай его через New thread.');
        navigate.toThread(thread.id);
        await waitFor(document.body, () => window.location.pathname.includes(`/threads/${thread.id}`) ? true : null, controller.signal);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const root = await waitFor(document.body, () => {
          const panes = [...document.querySelectorAll<HTMLElement>('[data-split-pane-id]')];
          return panes.length === 1 ? panes[0]! : null;
        }, controller.signal);
        await openNativeWorkspace(root, controller.signal);
      } else {
        navigate.toCompose({ projectId: project.id, hostId: source.hostId });
        await waitFor(document.body, () => !window.location.pathname.includes('/threads/') &&
          !document.querySelector('[data-thread-window]') ? true : null, controller.signal);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await openNativeTerminal(document.body, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : String(error));
    } finally { if (!controller.signal.aborted) { setBusy(false); pending.current = null; } }
  };
  return <>{(['folder', 'terminal'] as const).map(kind => <button key={kind} type="button"
    className="project-open-button" disabled={busy || !values}
    aria-label={kind === 'folder' ? 'Открыть папку проекта' : 'Открыть терминал проекта в BB'}
    title={kind === 'folder' ? 'Открыть папку проекта в Finder' : 'Открыть терминал проекта в BB'}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); event.preventDefault(); void run(kind); }}>
    <Icon name={kind === 'folder' ? 'FolderOpen' : 'Terminal'} className="size-4" />
  </button>)}</>;
}

const CSS = `
[data-project-open-controls], [data-project-open-header] { display:inline-flex; flex:0 0 56px; align-items:center; width:56px; overflow:visible; opacity:0; pointer-events:none; transition:opacity 100ms ease; }
[data-sidebar-project-id] [data-sidebar="group-label"]:hover [data-project-open-controls],
[data-sidebar-project-id] [data-sidebar="group-label"]:focus-within [data-project-open-controls],
[data-testid="app-page-header-content-row"]:hover [data-project-open-header],
[data-testid="app-page-header-content-row"]:focus-within [data-project-open-header] { opacity:1; pointer-events:auto; }
.project-open-button { display:inline-flex; flex:0 0 28px; align-items:center; justify-content:center; width:28px; height:28px; border-radius:6px; color:var(--muted-foreground); background:transparent; border:0; cursor:pointer; }
.project-open-button:hover { background:var(--state-hover); color:var(--foreground); }
.project-open-button:focus-visible { outline:2px solid var(--ring); outline-offset:-2px; }
.project-open-button:disabled { opacity:.4; cursor:wait; }
@media (hover:none) { [data-project-open-controls], [data-project-open-header] { flex-basis:64px; width:64px; opacity:1; pointer-events:auto; } .project-open-button { flex-basis:32px; width:32px; height:36px; } }
@media (prefers-reduced-motion:reduce) { [data-project-open-controls], [data-project-open-header] { transition:none; } }
`;

type HeaderAnchor = { element: HTMLElement; root: HTMLElement };
function HeaderBridge() {
  const marker = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<HeaderAnchor | null>(null);
  const scope = useComposer().scope;
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  useEffect(() => {
    if (!threadId) return;
    const root = marker.current?.closest<HTMLElement>('[data-split-pane-id]');
    if (!root) return;
    let element: HTMLElement | null = null;
    let frame = 0;
    const scan = () => {
      frame = 0;
      if (element?.isConnected) return;
      const container = root.querySelector<HTMLElement>('[data-thread-header-pane-actions]');
      if (!container?.parentElement) return;
      element = document.createElement('span'); element.dataset.projectOpenHeader = '';
      element.dataset.projectOpenThreadId = threadId;
      container.parentElement.prepend(element); setAnchor({ element, root });
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan); });
    observer.observe(root, { childList: true, subtree: true }); scan();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); element?.remove(); };
  }, [threadId]);
  return <><span ref={marker} data-project-open-bridge="" hidden />{anchor && threadId ? createPortal(<HeaderButtons root={anchor.root} threadId={threadId} />, anchor.element) : null}</>;
}

function HeaderButtons({ root, threadId }: { root: HTMLElement; threadId: string }) {
  const sdk = useSdk(), navigate = useBbNavigate();
  const { values } = useSettings();
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  return <>{(['folder', 'terminal'] as const).map(kind => <button type="button" key={kind}
    className="project-open-button" disabled={busy || !values}
    aria-label={kind === 'folder' ? 'Открыть папку треда' : 'Открыть терминал треда в BB'}
    title={kind === 'folder' ? 'Открыть папку треда в Finder' : 'Открыть терминал треда в BB'}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => {
      event.stopPropagation(); event.preventDefault();
      if (pending.current) return;
      const controller = new AbortController(); pending.current = controller; setBusy(true);
      void (async () => {
        if (kind === 'terminal') return openNativeTerminal(root, controller.signal);
        const thread = await sdk.threads.get({ threadId, signal: controller.signal });
        if (!thread.environmentId) throw new Error('У треда нет рабочей папки.');
        const environment = await sdk.environments.get({ environmentId: thread.environmentId, signal: controller.signal });
        if (!environment.path) throw new Error('У треда нет рабочей папки.');
        if (!values) throw new Error('Настройки открытия папки ещё загружаются.');
        if (values.finderHelper === true) {
          const url = finderFolderUrl(environment.hostId, environment.path);
          if (!navigate.openUrl(url)) throw new Error('На этом устройстве недоступен обработчик Finder.');
          return;
        }
        return openNativeWorkspace(root, controller.signal);
      })()
        .catch(error => { if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (!controller.signal.aborted) { pending.current = null; setBusy(false); } });
    }}><Icon name={kind === 'folder' ? 'FolderOpen' : 'Terminal'} className="size-4" /></button>)}</>;
}

function ProjectControls() {
  const anchors = useProjectAnchors();
  return <><style>{CSS}</style>{anchors.map(anchor => createPortal(<ProjectButtons anchor={anchor} />, anchor.element))}</>;
}

export default definePluginApp(app => {
  app.slots.experimental_appOverlay({ id: 'project-controls', component: ProjectControls });
  app.composer.customize({ id: 'header-bridge', scopes: ['thread'], banners: [{ id: 'header-bridge', chrome: 'bare', component: HeaderBridge }] });
});
