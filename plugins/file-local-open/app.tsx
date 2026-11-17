import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useComposer, useRpc, experimental_Icon as Icon, type PluginFileOpenerProps } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import type { rpcContract } from './contract';

const bridges = new Map<string, (path: string, action: 'open' | 'save') => Promise<void>>();
function ThreadBridge() {
  const scope = useComposer().scope;
  const rpc = useRpc<typeof rpcContract>();
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  useEffect(() => {
    if (!threadId) return;
    const open = async (path: string, action: 'open' | 'save') => {
      const result = await rpc.call('open', { path, action, source: { kind: 'host', threadId, environmentId: null, projectId: null } });
      toast.success(action === 'save' ? 'Сохранено в Загрузки' : `Открыто: ${result.application}`, { description: result.path });
    };
    bridges.set(threadId, open);
    return () => { if (bridges.get(threadId) === open) bridges.delete(threadId); };
  }, [rpc, threadId]);
  return <span hidden data-file-local-thread={threadId ?? undefined} />;
}
export function localPath(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'file:' || url.hostname) return null;
    // file:///C:/dir/file is the Windows path C:/dir/file, not /C:/dir/file.
    const path = decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:\/)/i, '');
    return /\.(pdf|html?|md|txt|csv|json|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|odt|ods|odp|rtf|mp3|mp4|wav|m4a|mov|zip)$/i.test(path) ? path : null;
  } catch { return null; }
}
function fileUrl(path: string, source: PluginFileOpenerProps['source']) {
  const encoded = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  if (source.kind === 'workspace') {
    if (source.environmentId) return `/api/v1/environments/${encodeURIComponent(source.environmentId)}/files/${encoded}`;
    if (source.projectId) return `/api/v1/projects/${encodeURIComponent(source.projectId)}${source.experimental_hostId ? `/hosts/${encodeURIComponent(source.experimental_hostId)}` : ''}/files/${encoded}`;
  }
  if (source.threadId) return `/api/v1/threads/${encodeURIComponent(source.threadId)}/${source.kind === 'thread-storage' ? 'thread-storage/files' : 'host-files'}/${encoded}`;
  return null;
}
function PdfPreview({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState('page-width');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const url = fileUrl(path, source);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController(); let objectUrl: string | null = null;
    setBlobUrl(null); setError('');
    void fetch(url, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Не удалось загрузить PDF (${response.status}).`);
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/pdf') throw new Error('Сервер вернул файл другого типа.');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setBlobUrl(objectUrl);
    }).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, attempt]);
  if (!url) return <Original />;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b p-2 text-sm">
      <button className="inline-flex items-center gap-1 rounded border px-3 py-1 hover:bg-state-hover disabled:opacity-50" disabled={busy} onClick={() => {
        setBusy(true);
        void rpc.call('open', { path, source, action: 'open' }).then(result => { if (active.current) toast.success(`Открыто: ${result.application}`, { description: result.path }); })
          .catch(e => { if (active.current) toast.error(String(e.message ?? e)); }).finally(() => { if (active.current) setBusy(false); });
      }}><Icon name="ExternalLink" className="size-4" />{busy ? 'Открываю…' : 'Открыть на компьютере'}</button>
      <button className="rounded border px-3 py-1 hover:bg-state-hover disabled:opacity-50" disabled={busy} onClick={() => {
        setBusy(true);
        void rpc.call('open', { path, source, action: 'save' }).then(result => { if (active.current) toast.success('Сохранено в Загрузки', { description: result.path }); })
          .catch(e => { if (active.current) toast.error(String(e.message ?? e)); }).finally(() => { if (active.current) setBusy(false); });
      }}>↓ В Загрузки</button>
      <select aria-label="Масштаб PDF" className="rounded border bg-background px-2 py-1" value={zoom} onChange={event => setZoom(event.target.value)}>
        <option value="page-width">По ширине</option><option value="100">100%</option><option value="150">150%</option><option value="200">200%</option>
      </select>
    </div>
    {error ? <div role="alert" className="p-4">{error}<button className="ml-2 underline" onClick={() => setAttempt(n => n + 1)}>Повторить</button></div>
      : blobUrl ? <iframe title={path} className="min-h-0 w-full flex-1 border-0" src={`${blobUrl}#pagemode=none&navpanes=0&zoom=${zoom}`} /> : <p className="p-4">Загружаю PDF…</p>}
  </div>;
}
export default definePluginApp(app => {
  app.composer.customize({ id: 'local-open-bridge', scopes: ['thread'], banners: [{ id: 'bridge', chrome: 'bare', component: ThreadBridge }] });
  app.slots.fileOpener({ id: 'pdf', title: 'PDF — по ширине / на компьютере', extensions: ['pdf'], component: PdfPreview });
  app.contentScripts.register({ id: 'file-buttons', mount({ signal }) {
    const nodes = new Map<HTMLAnchorElement, { button: HTMLSpanElement; href: string }>();
    let frame = 0;
    const scan = () => {
      frame = 0;
      for (const [anchor, entry] of nodes) if (!anchor.isConnected || anchor.href !== entry.href || !entry.button.isConnected) { entry.button.remove(); nodes.delete(anchor); }
      for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href^="file:"]')) {
        if (nodes.has(anchor)) continue;
        const path = localPath(anchor.href); if (!path) continue;
        const pane = anchor.closest('[data-split-pane-id]');
        if (!pane?.querySelector('[data-file-local-thread]')) continue;
        const group = document.createElement('span');
        group.dataset.fileLocalOpen = '';
        group.className = 'ml-0.5 inline-flex items-center gap-0.5 whitespace-nowrap align-middle';
        for (const action of ['open', 'save'] as const) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = action === 'save' ? '↓' : '↗';
        button.className = 'inline-flex size-5 items-center justify-center rounded text-subtle-foreground opacity-60 hover:bg-state-hover hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ width: '13', height: '13', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
        const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        glyph.setAttribute('d', action === 'save' ? 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4' : 'M4 3h16v13H4zM2 20h20');
        svg.append(glyph); button.replaceChildren(svg);
        button.dataset.fileLocalOpen = '';
        button.title = `${action === 'save' ? 'Сохранить в Загрузки на компьютере' : 'Открыть на компьютере'}: ${path.split('/').pop()}`;
        button.setAttribute('aria-label', button.title);
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          const threadId = anchor.closest('[data-split-pane-id]')?.querySelector<HTMLElement>('[data-file-local-thread]')?.dataset.fileLocalThread;
          const open = threadId ? bridges.get(threadId) : null;
          if (!open) { toast.error('Тред ещё загружается. Повторите открытие.'); return; }
          button.disabled = true; button.setAttribute('aria-busy', 'true');
          void open(path, action).catch(error => { if (!signal.aborted) toast.error(String(error.message ?? error)); })
            .finally(() => { if (!signal.aborted) { button.disabled = false; button.removeAttribute('aria-busy'); } });
        }, { signal });
        group.append(button);
        }
        anchor.after(group); nodes.set(anchor, { button: group, href: anchor.href });
      }
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data-file-local-thread'] }); scan();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); for (const { button } of nodes.values()) button.remove(); nodes.clear(); };
  } });
});
