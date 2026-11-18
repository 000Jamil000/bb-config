/** Opens BB's own project setup dialog; never submits or clones itself. */
export function mountSetupShortcut(doc: Document, signal: AbortSignal): () => void {
  const buttons = new Map<HTMLElement, HTMLButtonElement>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<MutationObserver>();
  const Observer = doc.defaultView!.MutationObserver;
  let scheduled = false;

  function openNativeSetup(shell: HTMLElement, button: HTMLButtonElement) {
    const trigger = shell.querySelector<HTMLButtonElement>('button[aria-label="Environment"]');
    if (!trigger || trigger.disabled || button.disabled) return;
    const label = trigger.querySelector('[data-promptbox-full-label]')?.textContent ?? trigger.textContent ?? "";
    const machine = label.split(" · ")[0]!.trim();
    if (!machine) return;
    button.disabled = true;
    let completed = false;
    const observer = new Observer(check);
    const finish = () => {
      if (completed) return;
      completed = true;
      observer.disconnect();
      pending.delete(observer);
      clearTimeout(timer);
      timers.delete(timer);
      button.disabled = false;
    };
    const timer = setTimeout(finish, 8000);
    timers.add(timer);
    function check() {
      if (signal.aborted || !shell.isConnected) { finish(); return; }
      const match = Array.from(doc.querySelectorAll<HTMLElement>('[role="option"]')).find(option => {
        const text = option.textContent?.trim();
        return text === `Set up on ${machine}…` || text === `Set up on ${machine}...`;
      });
      if (match && match.getAttribute("aria-disabled") !== "true") { finish(); match.click(); }
    }
    pending.add(observer);
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    check();
  }

  function refresh() {
    scheduled = false;
    if (signal.aborted) return;
    for (const shell of doc.querySelectorAll<HTMLElement>('[data-app-composer]')) {
      const submit = shell.querySelector<HTMLButtonElement>('button[data-promptbox-submit-action]');
      const missing = !!shell.querySelector('[data-new-thread-footer]') && submit?.disabled &&
        submit.getAttribute("aria-label") === "Select an environment.";
      const existing = buttons.get(shell);
      if (!missing || !submit?.parentElement) {
        existing?.remove(); buttons.delete(shell); continue;
      }
      if (existing?.isConnected) continue;
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = "Подключить проект";
      button.title = "Подключить проект к выбранной машине";
      button.setAttribute("aria-label", button.title);
      button.dataset.projectMachineSetup = "";
      button.dataset.bbPluginRoot = "project-machine-setup";
      button.style.cssText = "flex-shrink:0;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;line-height:18px;background:var(--secondary);color:var(--foreground);cursor:pointer;white-space:nowrap";
      button.addEventListener("click", () => openNativeSetup(shell, button), { signal });
      submit.parentElement.insertBefore(button, submit);
      buttons.set(shell, button);
    }
    for (const [shell, button] of buttons) {
      if (!shell.isConnected) { button.remove(); buttons.delete(shell); }
    }
  }

  const observer = new Observer(() => {
    if (!scheduled) { scheduled = true; queueMicrotask(refresh); }
  });
  observer.observe(doc.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["disabled", "aria-label"],
  });
  refresh();
  const dispose = () => {
    observer.disconnect();
    for (const item of pending) item.disconnect();
    for (const timer of timers) clearTimeout(timer);
    for (const button of buttons.values()) button.remove();
    pending.clear(); timers.clear(); buttons.clear();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
