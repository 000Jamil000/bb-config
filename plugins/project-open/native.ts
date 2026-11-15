/** Delegate to real BB controls. No copied terminal, SSH, or external-app logic. */
export function available<T extends HTMLElement>(element: T | null): T | null {
  return element && !element.closest('[hidden], [inert], [aria-hidden="true"]') ? element : null;
}

export function waitFor<T>(root: Node, find: () => T | null, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const value = find();
  if (value) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: T, error?: Error) => {
      if (settled) return;
      settled = true;
      observer.disconnect(); clearTimeout(timer); signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(undefined, new Error('Opening cancelled'));
    const observer = new MutationObserver(() => { const value = find(); if (value) finish(value); });
    const timer = setTimeout(() => finish(undefined, new Error('Штатная кнопка BB недоступна в этом окне.')), 5000);
    observer.observe(root, { childList: true, subtree: true, attributes: true });
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function uniqueButton(root: ParentNode, selector: string): HTMLButtonElement | null {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>(selector)]
    .filter(button => available(button) && !button.disabled);
  return buttons.length === 1 ? buttons[0]! : null;
}

export async function openNativeTerminal(root: HTMLElement, signal: AbortSignal): Promise<void> {
  uniqueButton(root, 'button[aria-label^="Show right panel"]')?.click();
  const launcher = await waitFor(document.body, () =>
    uniqueButton(root, 'button[data-panel-new-tab]') ??
    (document.querySelectorAll('[data-split-pane-id]').length <= 1
      ? uniqueButton(document.body, 'button[data-panel-new-tab]') : null), signal);
  const panel = root.contains(launcher) ? root : launcher.closest<HTMLElement>('aside') ?? document.body;
  launcher.click();
  const action = await waitFor(document.body, () => uniqueButton(panel,
    'button[data-panel-new-tab-item][id="file-search-result-start-terminal"]'), signal);
  action.click();
}

export async function openNativeWorkspace(root: HTMLElement, signal: AbortSignal): Promise<void> {
  const trigger = await waitFor(document.body, () => uniqueButton(root,
    'button[aria-label="Choose another app to open workspace"]'), signal);
  const before = new Set([...document.querySelectorAll<HTMLElement>('[role="menu"], [role="dialog"]')].filter(available));
  // Radix menu buttons open on pointerdown, including in the desktop client.
  trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
  trigger.click();
  const menu = await waitFor(document.body, () => {
    const controls = trigger.getAttribute('aria-controls');
    const controlled = controls ? document.getElementById(controls) : null;
    if (controlled && available(controlled)) return controlled;
    const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"], [role="dialog"]')]
      .filter(menu => available(menu) && (!before.has(menu) || menu.getAttribute('aria-labelledby')?.split(' ').includes(trigger.id)));
    // Responsive BB may have a dialog containing a menu. Count the innermost
    // chooser, not both wrappers, and never mistake the open sidebar for it.
    const leaves = menus.filter(menu => !menus.some(other => other !== menu && menu.contains(other)));
    return leaves.length === 1 ? leaves[0]! : null;
  }, signal);
  // Finder/File Manager is present only when BB supports it in this context.
  // An unsupported remote directory must not be presented as an opened folder.
  const finder = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], button')]
    .find(item => /^(Finder|File Manager|File Explorer|Windows Explorer)$/i.test(item.textContent?.trim() ?? ''));
  if (!finder) {
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    throw new Error('BB не предоставляет Finder для этой удалённой папки. Нужен подключённый диск или настроенный SFTP-клиент.');
  }
  finder.click();
}
