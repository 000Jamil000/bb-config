import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { definePluginApp, useSdk, useBbNavigate, useSettings, useComposer,
  experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { openNativeTerminal, openNativeWorkspace, waitFor } from './native';
import { finderFolderUrl } from './folder-target';

type Anchor = { threadId: string; element: HTMLElement };
function useThreadAnchors() {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  useEffect(() => {
    const mounts = new Map<HTMLElement, Anchor>();
    let frame = 0;
    const scan = () => {
      frame = 0;
      const rows = new Set(document.querySelectorAll<HTMLElement>('a[data-sidebar-thread-id]'));
      for (const [row, anchor] of mounts) {
        if (!rows.has(row) || !anchor.element.isConnected || row.dataset.sidebarThreadId !== anchor.threadId) {
          anchor.element.remove(); mounts.delete(row);
        }
      }
      for (const row of rows) {
        if (mounts.has(row)) continue;
        const trailing = row.closest('[data-sidebar-rename-row]')?.querySelector<HTMLElement>('[data-sidebar-thread-trailing]');
        if (!trailing) continue;
        const element = document.createElement('span');
        element.dataset.projectOpenControls = '';
        trailing.prepend(element);
        mounts.set(row, { threadId: row.dataset.sidebarThreadId!, element });
      }
      setAnchors(previous => {
        const next = [...mounts.values()];
        return next.length === previous.length && next.every((a, i) => a === previous[i]) ? previous : next;
      });
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-sidebar-thread-id'] });
    scan();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); for (const a of mounts.values()) a.element.remove(); };
  }, []);
  return anchors;
}
const CSS = `
[data-project-open-controls], [data-project-open-header] { position:relative; z-index:31; display:inline-flex; flex:0 0 56px; align-items:center; width:56px; overflow:visible; opacity:0; pointer-events:none; transition:opacity 100ms ease; }
[data-sidebar-thread-trailing]:has(> [data-project-open-controls]) { position:relative; }
[data-project-open-controls] { position:absolute; right:calc(100% + 30px); top:50%; transform:translateY(-50%); background:var(--sidebar-accent); box-shadow:-6px 0 6px var(--sidebar-accent); }
[data-sidebar-rename-row]:hover > [data-sidebar-thread-trailing] > [data-project-open-controls],
[data-sidebar-rename-row]:focus-within > [data-sidebar-thread-trailing] > [data-project-open-controls],
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
  return <><span ref={marker} data-project-open-bridge="" hidden />{anchor && threadId ? createPortal(<ThreadButtons root={anchor.root} threadId={threadId} />, anchor.element) : null}</>;
}

function ThreadButtons({ root, threadId }: { root?: HTMLElement; threadId: string }) {
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
        const getRoot = async () => {
          if (root) return root;
          navigate.toThread(threadId);
          return waitFor(document.body, () => {
            const marker = [...document.querySelectorAll<HTMLElement>('[data-project-open-thread-id]')]
              .find(element => element.dataset.projectOpenThreadId === threadId);
            return marker?.closest<HTMLElement>('[data-split-pane-id]') ?? null;
          }, controller.signal);
        };
        if (kind === 'terminal') return openNativeTerminal(await getRoot(), controller.signal);
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
        return openNativeWorkspace(await getRoot(), controller.signal);
      })()
        .catch(error => { if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (!controller.signal.aborted) { pending.current = null; setBusy(false); } });
    }}><Icon name={kind === 'folder' ? 'FolderOpen' : 'Terminal'} className="size-4" /></button>)}</>;
}

function ProjectControls() {
  const anchors = useThreadAnchors();
  return <><style>{CSS}</style>{anchors.map(anchor => createPortal(<ThreadButtons threadId={anchor.threadId} />, anchor.element))}</>;
}

export default definePluginApp(app => {
  app.slots.experimental_appOverlay({ id: 'project-controls', component: ProjectControls });
  app.composer.customize({ id: 'header-bridge', scopes: ['thread'], banners: [{ id: 'header-bridge', chrome: 'bare', component: HeaderBridge }] });
});
