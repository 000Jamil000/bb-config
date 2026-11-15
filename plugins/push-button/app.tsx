import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { definePluginApp, useComposer, useSdk, experimental_useRpcQuery, experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { contract } from './contract';

export function PushButton() {
  const composer = useComposer();
  const sdk = useSdk();
  const marker = useRef<HTMLSpanElement>(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const scope = composer.scope;
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  const { data: status } = experimental_useRpcQuery({ contract, method: 'status', input: { threadId: threadId ?? '' }, enabled: !!threadId });
  const hasWork = status?.state === 'ready';

  useEffect(() => {
    const shell = marker.current?.closest<HTMLElement>('[data-app-composer]');
    if (!shell || !threadId) return;
    const mobile = window.matchMedia?.('(max-width:640px) and (pointer:coarse)');
    let mount: HTMLElement | null = null;
    let frame = 0;
    const scan = () => {
      frame = 0;
      let branch = shell.querySelector<HTMLElement>('[data-promptbox-hide-branch-compact], button[aria-label="Branch"]')
        ?? shell.querySelector('[data-icon="GitBranch"], [data-icon="GitMerge"]')?.closest<HTMLElement>('button');
      while (branch?.parentElement?.matches('[data-bb-plugin-root][data-bb-plugin].contents')) branch = branch.parentElement;
      if (!branch?.parentElement) { mount?.remove(); mount = null; setTarget(null); return; }
      const changes = shell.querySelector<HTMLElement>('#thread-prompt-banner-git-toggle');
      const anchor = mobile?.matches && changes ? changes : branch;
      const location = anchor === changes ? 'changes' : 'branch';
      if (mount?.isConnected && mount.previousElementSibling === anchor) {
        mount.style.order = location === 'branch' ? getComputedStyle(branch).order : '0';
        return;
      }
      mount?.remove();
      mount = document.createElement('div');
      mount.dataset.pushButtonMount = '';
      mount.dataset.pushButtonLocation = location;
      mount.setAttribute('data-bb-plugin-root', '');
      mount.setAttribute('data-bb-plugin', 'push-button');
      mount.style.display = 'inline-flex';
      mount.style.order = location === 'branch' ? getComputedStyle(branch).order : '0';
      anchor.after(mount);
      setTarget(mount);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(scan); };
    mobile?.addEventListener('change', schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(shell, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-proxy-context-part'] });
    scan();
    return () => { observer.disconnect(); mobile?.removeEventListener('change', schedule); cancelAnimationFrame(frame); mount?.remove(); };
  }, [threadId]);

  return <><style>{`.push-button-machine { display:none; }
@media (max-width:640px) {
[data-push-button-mount] { flex-shrink:0; }
[data-push-thread-button] { justify-content:center; }
}
@media (max-width:640px) and (pointer:coarse) { [data-push-thread-button] { height:44px; } }
@media (max-width:640px) and (pointer:coarse) {
.push-button-machine { display:flex; align-items:center; gap:6px; min-width:0; padding-inline:8px; font-size:12px; line-height:20px; color:var(--muted-foreground); }
}
`}</style><span ref={marker} hidden data-push-button-bridge="" />{status?.hostName ? <div className="push-button-machine" aria-label={`Машина: ${status.hostName}`}><Icon name="Laptop" className="size-3.5" /><span>{status.hostName}</span></div> : null}{target && threadId ? createPortal(
    <button type="button" data-push-thread-button=""
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground enabled:hover:bg-state-hover enabled:hover:text-foreground disabled:opacity-35 disabled:cursor-default"
      title={status?.message ?? 'Проверяю изменения Git…'} aria-label="Отправить пуш в тред"
      disabled={busy || composer.isSubmitting || !hasWork}
      onPointerDown={event => { if (event.button === 0) event.preventDefault(); event.stopPropagation(); }}
      onClick={event => {
        event.preventDefault(); event.stopPropagation();
        if (sending.current || !hasWork) return;
        sending.current = true; setBusy(true);
        void sdk.threads.send({ threadId, mode: 'queue-if-active', input: [{ type: 'text', text: 'пуш', mentions: [] }] })
          .catch(error => toast.error(error instanceof Error ? error.message : String(error)))
          .finally(() => { sending.current = false; setBusy(false); });
      }}><Icon name="ArrowUp" className="size-3.5" /><span className="push-button-label">Пуш</span></button>, target) : null}</>;
}

export default definePluginApp(app => {
  app.composer.customize({ id: 'push-button', scopes: ['thread'], banners: [
    { id: 'push-button-bridge', chrome: 'bare', component: PushButton },
  ] });
});
