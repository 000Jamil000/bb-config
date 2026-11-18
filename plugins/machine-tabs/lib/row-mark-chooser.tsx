import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { TOPICS, type RowMarkChoice } from "./thread-topics";

export const ROW_MARK_CSS = `
.machine-tabs-topic-mark { display:inline-flex; width:16px; height:16px; flex-shrink:0; align-items:center; justify-content:center; margin-right:8px; }
.mt-chooser-backdrop { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:16px; background:#0006; }
.mt-chooser { width:min(620px,100%); max-height:100%; overflow:auto; background:var(--background); color:var(--foreground); border:1px solid var(--border); border-radius:12px; padding:20px; box-shadow:0 12px 40px #0004; font-size:13px; }
.mt-chooser h2 { font-size:16px; font-weight:600; margin:0 0 4px; }
.mt-chooser p { margin:0; color:var(--muted-foreground); }
.mt-chooser-options { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; margin:16px 0; }
.mt-chooser-option { display:flex; flex-direction:column; gap:8px; padding:10px; text-align:left; border:1px solid var(--border); border-radius:10px; background:transparent; color:inherit; cursor:pointer; }
.mt-chooser-option:hover { background:var(--muted); }
.mt-chooser-option[aria-checked="true"] { border-color:var(--ring); box-shadow:0 0 0 1px var(--ring); }
.mt-chooser-option:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
.mt-chooser-option svg { width:100%; height:auto; border-radius:6px; border:1px solid var(--border); color:var(--foreground); }
.mt-chooser-option b { font-weight:600; }
.mt-chooser-option span { color:var(--muted-foreground); font-size:12px; line-height:1.4; }
.mt-chooser-actions { display:flex; justify-content:flex-end; gap:8px; }
.mt-chooser-actions button { padding:6px 12px; border-radius:6px; border:1px solid var(--border); background:transparent; color:inherit; cursor:pointer; }
.mt-chooser-actions button.mt-primary { background:var(--foreground); color:var(--background); border-color:var(--foreground); }
`;

/** Five schematic rows: squares with letters, or the topic icons themselves. */
function Preview({ kind }: { kind: RowMarkChoice }) {
  const rows = [0, 1, 2, 3, 4];
  const widths = [118, 92, 134, 80, 106];
  const letters = ["BB", "MO", "BB", "FI", "MO"];
  return (
    <svg viewBox="0 0 220 128" role="img" aria-hidden="true">
      <rect width="220" height="128" fill="currentColor" opacity="0.04" />
      {rows.map((row) => {
        const y = 14 + row * 22;
        const topic = TOPICS[[4, 0, 2, 5, 6][row]!]!;
        return (
          <g key={row}>
            {kind === "project" ? (
              <>
                <rect x="14" y={y - 7} width="14" height="14" rx="3.5" fill="currentColor" opacity="0.2" />
                <text x="21" y={y + 2.5} fontSize="6.5" fontWeight="700" textAnchor="middle" fill="currentColor" opacity="0.75">
                  {letters[row]}
                </text>
              </>
            ) : (
              <g transform={`translate(14 ${y - 7}) scale(0.5833)`} style={{ color: topic.color }}>
                <path d={topic.path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            )}
            <rect x="36" y={y - 2.5} width={widths[row]} height="5" rx="2.5" fill="currentColor" opacity="0.35" />
          </g>
        );
      })}
    </svg>
  );
}

const OPTIONS: { id: RowMarkChoice; title: string; text: string }[] = [
  { id: "project", title: "Значки проектов", text: "Перед названием — логотип или буквы проекта. Так список выглядит сейчас." },
  { id: "topic", title: "Значки тем", text: "Перед названием — значок темы, угаданной по словам в названии: разработка, дизайн, документы и другие." },
];

type ChooserProps = {
  current: RowMarkChoice;
  first: boolean;
  onClose: () => void;
  onChoose: (next: RowMarkChoice) => Promise<void>;
};

/** Over the whole page: the sidebar is too narrow for two previews. */
export function RowMarkChooser(props: ChooserProps) {
  return createPortal(<RowMarkDialog {...props} />, document.body);
}

export function RowMarkDialog({
  current,
  first,
  onClose,
  onChoose,
}: {
  current: RowMarkChoice;
  first: boolean;
  onClose: () => void;
  onChoose: (next: RowMarkChoice) => Promise<void>;
}) {
  const [selected, setSelected] = useState<RowMarkChoice>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const apply = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    apply.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);
  return (
    <div className="mt-chooser-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="mt-chooser" role="dialog" aria-modal="true" aria-labelledby="mt-chooser-title">
        <h2 id="mt-chooser-title">Какие значки показывать в строках тредов?</h2>
        <p>Фильтр по теме работает при любом выборе. Изменить выбор можно в настройках Machine Tabs.</p>
        <div className="mt-chooser-options" role="radiogroup" aria-label="Значки в строках">
          {OPTIONS.map((option) => (
            <button key={option.id} type="button" role="radio" aria-checked={selected === option.id}
              className="mt-chooser-option" onClick={() => setSelected(option.id)}
              onDoubleClick={() => apply.current?.click()}>
              <Preview kind={option.id} />
              <b>{option.title}</b>
              <span>{option.text}</span>
            </button>
          ))}
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <div className="mt-chooser-actions">
          <button type="button" disabled={busy} onClick={onClose}>{first ? "Позже" : "Отмена"}</button>
          <button ref={apply} type="button" className="mt-primary" disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              onChoose(selected).catch(() => { setError("Не удалось сохранить выбор. Повторите."); setBusy(false); });
            }}>
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}
