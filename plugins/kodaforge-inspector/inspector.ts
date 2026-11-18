/** The workspace route names the thread displayed by this editor. */
export function threadInWorkspace(pathname: string): string | null {
  return (
    /^\/plugins\/kodaforge\/forge\/thread\/(thr_[A-Za-z0-9_-]+)\/?$/.exec(
      pathname,
    )?.[1] ?? null
  );
}
export const UPSTREAM =
  "git:https://github.com/Kodaks94/bb-plugin-kodaforge.git@semver:>=0.7.0 <1.0.0";
export type Inspection = {
  state: "waiting" | "compatible" | "incompatible";
  reason: string;
  root?: HTMLElement;
  editors?: HTMLElement;
  original?: HTMLElement;
};
export function inspect(
  doc: Document,
  visible: (element: HTMLElement) => boolean,
): Inspection {
  const roots = [...doc.querySelectorAll<HTMLElement>(".kf-root")].filter(
    visible,
  );
  if (!roots.length)
    return { state: "waiting", reason: "Ожидаю загрузку KodaForge" };
  if (roots.length !== 1)
    return {
      state: "incompatible",
      reason: "Не удалось однозначно определить рабочую область",
    };
  const root = roots[0]!;
  const editors = root.querySelector<HTMLElement>('[data-panel][id="editors"]');
  const main = root.querySelector('[data-panel][id="main"]');
  const nativeChildren = editors?.querySelectorAll<HTMLElement>(
    ":scope > :not([data-kfi-owned])",
  );
  const original = nativeChildren?.length === 1 ? nativeChildren[0] : undefined;
  if (
    !editors ||
    !main?.contains(editors) ||
    !original ||
    !root.querySelector('nav[aria-label="Views"]') ||
    !root.querySelector('footer button[title="Switch branch"]') ||
    !root.querySelector('footer button[title="Toggle Terminal (⌃`)"]')
  ) {
    return {
      state: "incompatible",
      reason: "Структура KodaForge изменилась. Оставлен штатный интерфейс.",
    };
  }
  return {
    state: "compatible",
    reason: "Чат по центру; штатные файлы, Git и терминал",
    root,
    editors,
    original,
  };
}
export function attachLayout(editors: HTMLElement, original: HTMLElement) {
  const doc = editors.ownerDocument;
  const toolbar = doc.createElement("div");
  toolbar.setAttribute("data-kfi-owned", "toolbar");
  const chat = doc.createElement("div");
  chat.setAttribute("data-kfi-owned", "chat");
  const wasInert = original.inert;
  editors.setAttribute("data-kfi-layout", "chat");
  editors.prepend(toolbar);
  editors.append(chat);
  function mode(value: "chat" | "code") {
    editors.setAttribute("data-kfi-layout", value);
    original.inert = value === "chat" || wasInert;
  }
  mode("chat");
  return {
    original,
    toolbar,
    chat,
    mode,
    dispose() {
      toolbar.remove();
      chat.remove();
      editors.removeAttribute("data-kfi-layout");
      original.inert = wasInert;
    },
  };
}
export const CSS = `
[data-panel][id="main"]:has([data-kfi-layout="chat"]) ~ [data-panel][id="side"],
[data-panel][id="main"]:has([data-kfi-layout="chat"]) + [role="separator"]:has(+ [data-panel][id="side"]) { display:none !important; }
[data-kfi-layout] { position:relative !important; flex-direction:column !important; min-height:0; }
[data-kfi-layout] > :not([data-kfi-owned]) { flex:1; min-height:0; width:100%; }
[data-kfi-layout="chat"] > :not([data-kfi-owned]) { visibility:hidden; pointer-events:none; }
[data-kfi-owned="toolbar"] { flex:0 0 36px; height:36px; z-index:8; background:var(--background); border-bottom:1px solid var(--border); }
[data-kfi-owned="chat"] { position:absolute; inset:36px 0 0; z-index:7; background:var(--background); display:flex; min-height:0; }
[data-kfi-layout="code"] > [data-kfi-owned="chat"] { display:none; }
.kfi-toolbar { display:flex; align-items:center; height:36px; gap:6px; padding:0 10px; font-size:12px; color:var(--foreground); }
.kfi-toolbar button { padding:4px 9px; border-radius:4px; cursor:pointer; }
.kfi-toolbar button[aria-pressed="true"] { background:var(--muted); font-weight:600; }
.kfi-toolbar small { margin-left:auto; color:var(--muted-foreground); white-space:nowrap; }
.kfi-warning { position:fixed; bottom:40px; right:20px; max-width:420px; z-index:999; background:var(--background); color:var(--foreground); border:1px solid var(--border); border-radius:8px; padding:12px; box-shadow:0 4px 20px #0002; font-size:13px; }
`;
