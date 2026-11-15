// Decorate the host-owned context row without replacing its controls.
type Entry = { anchor: HTMLElement; update: (target: HTMLElement | null) => void };
const entries = new Set<Entry>();
let requestSync: (() => void) | null = null;

export function registerFooterRoute(anchor: HTMLElement, update: Entry['update']) {
  const entry = { anchor, update };
  entries.add(entry);
  requestSync?.();
  return () => { entries.delete(entry); requestSync?.(); };
}

export function installComposerFooter(signal: AbortSignal) {
  const mounted = new Map<Entry, { row: HTMLElement; target: HTMLElement }>();
  let frame = 0;
  let disposed = false;
  function release(entry: Entry) {
    const current = mounted.get(entry);
    if (!current) return;
    current.target.remove();
    current.row.removeAttribute('data-proxy-context-row');
    for (const child of Array.from(current.row.children)) child.removeAttribute('data-proxy-context-part');
    mounted.delete(entry);
    entry.update(null);
  }
  function sync() {
    frame = 0;
    if (disposed) return;
    for (const entry of mounted.keys()) if (!entries.has(entry) || !entry.anchor.isConnected) release(entry);
    for (const entry of entries) {
      const shell = entry.anchor.closest('[data-app-composer]');
      const project = shell?.querySelector<HTMLElement>('[data-promptbox-project-control], [data-option-display][title^="Project:"]');
      let branch = shell?.querySelector<HTMLElement>('[data-promptbox-hide-branch-compact], button[aria-label="Branch"]')
        ?? shell?.querySelector('[data-icon="GitBranch"], [data-icon="GitMerge"]')?.closest<HTMLElement>('button');
      // Environment providers wrap their branch picker in a display:contents plugin root.
      while (branch?.parentElement?.matches('[data-bb-plugin-root][data-bb-plugin].contents')) branch = branch.parentElement;
      const machine = shell?.querySelector<HTMLElement>('button[aria-label="Machine"]');
      const row = project?.parentElement ?? branch?.parentElement ?? machine?.parentElement;
      const plus = row?.querySelector<HTMLElement>('button[aria-label="New thread in this environment"]');
      if (!row || !entry.anchor.isConnected) { release(entry); continue; }
      let current = mounted.get(entry);
      if (current && (current.row !== row || !current.target.isConnected)) { release(entry); current = undefined; }
      if (!current) {
        const target = document.createElement('span');
        target.setAttribute('data-bb-plugin-root', '');
        target.setAttribute('data-bb-plugin', 'proxy-manager');
        target.setAttribute('data-proxy-context-part', 'proxy');
        target.className = 'proxy-footer-mount';
        row.insertBefore(target, plus ?? null);
        current = { row, target };
        mounted.set(entry, current);
        entry.update(target);
      }
      row.setAttribute('data-proxy-context-row', '');
      branch?.setAttribute('data-proxy-context-part', 'branch');
      plus?.setAttribute('data-proxy-context-part', 'plus');
      for (const child of Array.from(row.children)) {
        if (child === branch || child === plus || child === current.target) continue;
        if (child === project) child.setAttribute('data-proxy-context-part', 'project');
        else if (child === machine || child.matches('[data-promptbox-shrinkable-control]') || child.tagName === 'SPAN') child.setAttribute('data-proxy-context-part', 'machine');
      }
    }
  }
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(sync); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  requestSync = schedule;
  schedule();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    if (requestSync === schedule) requestSync = null;
    for (const entry of mounted.keys()) release(entry);
    signal.removeEventListener('abort', dispose);
  };
  signal.addEventListener('abort', dispose, { once: true });
  return dispose;
}
