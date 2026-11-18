import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

export type FilterOption = {
  value: string;
  label: string;
  /** Threads this choice would leave in the list. */
  count: number;
  mark?: ReactNode;
};

export const FILTER_PICKER_CSS = `
.mt-pick { position: static; min-width: 0; flex: 0 1 auto; }
.mt-pick-chip {
  display: flex; align-items: center; gap: 4px; max-width: 100%; height: 24px; padding: 0 6px 0 8px;
  font-size: 12px; color: var(--muted-foreground); background: transparent;
  border: 1px solid var(--border); border-radius: 6px; cursor: pointer; outline: none;
}
.mt-pick-chip:hover, .mt-pick-chip[aria-expanded="true"] { color: var(--sidebar-foreground); background: var(--state-hover); }
.mt-pick-chip[data-active] { color: var(--sidebar-foreground); background: var(--state-active); border-color: transparent; font-weight: 500; }
.mt-pick-chip:focus-visible { outline: 2px solid var(--sidebar-ring); outline-offset: 1px; }
.mt-pick-chip > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-pick-chip > svg { flex-shrink: 0; opacity: .7; }
.mt-pick-panel {
  position: absolute; left: 8px; right: 8px; top: 100%; z-index: 130; margin-top: -2px;
  display: flex; flex-direction: column; max-height: min(60vh, 26rem); overflow: hidden;
  color: var(--popover-foreground); background: var(--popover);
  border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px #0003;
}
.mt-pick-find { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--muted-foreground); }
.mt-pick-find input { min-width: 0; flex: 1; font-size: 12px; color: var(--popover-foreground); background: transparent; border: 0; outline: none; }
.mt-pick-list { overflow-y: auto; padding: 4px; overscroll-behavior: contain; }
.mt-pick-item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 28px; padding: 3px 8px;
  font-size: 13px; text-align: left; color: inherit; background: transparent; border: 0; border-radius: 5px; cursor: pointer; outline: none;
}
.mt-pick-item[data-current] { background: var(--state-hover); }
.mt-pick-item[data-empty] { color: var(--muted-foreground); }
.mt-pick-item > .mt-pick-mark { display: inline-flex; width: 16px; flex-shrink: 0; align-items: center; justify-content: center; }
.mt-pick-item > .mt-pick-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-pick-item > .mt-pick-count { flex-shrink: 0; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--muted-foreground); }
.mt-pick-none { padding: 10px 8px; font-size: 12px; color: var(--muted-foreground); }
`;

/**
 * A filter as a chip with its own list instead of the system select: the list
 * is searched by typing, shows how many threads each choice leaves, and scrolls
 * inside the sidebar however many projects there are.
 */
export function FilterPicker({
  label,
  allLabel,
  value,
  options,
  total,
  onChange,
  matches,
}: {
  /** Names the filter for assistive tech and the search field. */
  label: string;
  allLabel: string;
  value: string;
  options: readonly FilterOption[];
  /** Threads with no choice made, shown beside the "all" row. */
  total: number;
  onChange: (value: string) => void;
  /** Whether a label answers what was typed (the caller knows about keyboard layouts). */
  matches: (label: string, typed: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value);
  const rows = useMemo(() => {
    const query = typed.trim();
    const all: FilterOption = { value: "all", label: allLabel, count: total };
    // Choices that leave something come first, the busiest on top; empty ones stay reachable below.
    const sorted = [...options].sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || b.count - a.count);
    return query === "" ? [all, ...sorted] : sorted.filter((option) => matches(option.label, query));
  }, [options, typed, allLabel, total, matches]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside, true);
    return () => document.removeEventListener("mousedown", outside, true);
  }, [open]);
  useEffect(() => { setCursor(0); }, [typed]);
  useEffect(() => {
    list.current?.querySelector("[data-current]")?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const show = () => {
    setTyped("");
    setCursor(Math.max(0, value === "all" ? 0 : rows.findIndex((row) => row.value === value)));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) chip.current?.focus();
  };
  const choose = (next: string) => {
    onChange(next);
    close(true);
  };
  const searchable = options.length > 7;
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setCursor((at) => Math.min(rows.length - 1, at + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((at) => Math.max(0, at - 1)); }
    else if (event.key === "Home") { event.preventDefault(); setCursor(0); }
    else if (event.key === "End") { event.preventDefault(); setCursor(rows.length - 1); }
    else if (event.key === "Enter") { event.preventDefault(); const row = rows[cursor]; if (row) choose(row.value); }
    else if (event.key === "Tab") close(false);
  };

  return (
    <div ref={root} className="mt-pick">
      <button ref={chip} type="button" className="mt-pick-chip" aria-haspopup="listbox" aria-expanded={open}
        aria-label={`${label}: ${selected?.label ?? allLabel}`} title={selected?.label ?? allLabel}
        data-active={selected ? "" : undefined} onClick={() => (open ? close(false) : show())}>
        {selected?.mark}
        <span>{selected?.label ?? allLabel}</span>
        <Icon name="ChevronDown" className="size-3" />
      </button>
      {open ? (
        <div className="mt-pick-panel" onKeyDown={onKeyDown}>
          {searchable ? (
            <div className="mt-pick-find">
              <Icon name="Search" className="size-3.5" />
              <input autoFocus type="text" value={typed} placeholder={label} aria-label={label}
                role="combobox" aria-expanded="true" aria-controls="mt-pick-list" aria-autocomplete="list"
                onChange={(event) => setTyped(event.target.value)} />
            </div>
          ) : null}
          <div id="mt-pick-list" role="listbox" aria-label={label} className="mt-pick-list" tabIndex={-1}
            // Without a search field the list itself takes the keyboard.
            ref={(node) => { list.current = node; if (node && !searchable && document.activeElement !== node) node.focus(); }}>
            {rows.length === 0 ? <div className="mt-pick-none">Ничего не найдено</div> : rows.map((row, index) => (
              <button key={row.value} type="button" role="option" tabIndex={-1} className="mt-pick-item"
                aria-selected={row.value === value}
                data-current={index === cursor ? "" : undefined}
                data-empty={row.count === 0 ? "" : undefined}
                onMouseEnter={() => setCursor(index)} onClick={() => choose(row.value)}>
                <span className="mt-pick-mark">{row.mark}</span>
                <span className="mt-pick-label">{row.label}</span>
                {row.value === value ? <Icon name="Check" className="size-3.5" /> : null}
                <span className="mt-pick-count">{row.count}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
