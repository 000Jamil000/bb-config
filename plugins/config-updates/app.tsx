import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, UpdateStatus } from "./server";

const REMIND_MS = 24 * 3_600_000;
const SEEN_KEY = "config-updates:toast";

function useUpdates() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<"check" | "start" | null>(null);
  const refresh = useCallback(() => { rpc.call("status").then(setStatus).catch(() => {}); }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("status", refresh);
  const check = useCallback(async () => {
    setBusy("check");
    try { setStatus(await rpc.call("check")); } catch (error) { toast.error(`Проверка не удалась: ${(error as Error).message}`); } finally { setBusy(null); }
  }, [rpc]);
  const start = useCallback(async () => {
    setBusy("start");
    try {
      const started = await rpc.call("start");
      if (started.existing) toast.info(`Обновление до ${started.tag} уже выполняется — открываю его тред.`);
      navigate.toThread(started.threadId);
    } catch (error) {
      toast.error((error as Error).message, { duration: 15_000 });
    } finally { setBusy(null); }
  }, [rpc, navigate]);
  return { status, busy, check, start };
}

let footer: { open(): void } | null = null;

/** Opens the sidebar-footer card for a published release at most once a day per version and browser. */
function Notice() {
  const { status } = useUpdates();
  const tag = status?.pending.at(-1)?.tag;
  useEffect(() => {
    if (!tag) return;
    let seen: { tag?: string; at?: number } = {};
    try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}"); } catch { /* shown again */ }
    if (seen.tag === tag && Date.now() - (seen.at ?? 0) < REMIND_MS) return;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify({ tag, at: Date.now() })); } catch { /* private mode */ }
    footer?.open();
  }, [tag]);
  return null;
}

/** The card above the sidebar footer row, next to bb's own update notices. */
function FooterCard({ dismiss }: { dismiss(): void }) {
  const { status, busy, check, start } = useUpdates();
  const target = status?.pending.at(-1);
  return <div className="space-y-2 rounded-lg border border-border bg-background p-3 text-sm shadow-sm" data-config-updates-card>
    {!status ? <p className="text-muted-foreground">Загрузка…</p> : <>
      {status.error && <p role="alert" className="text-xs text-destructive">Проверка не удалась: {status.error} Это не означает, что обновлений нет.</p>}
      {target ? <>
        <p className="font-semibold">Обновление доработок BB {target.tag}</p>
        {target.title !== target.tag && <p className="text-xs">{target.title}</p>}
        <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs text-muted-foreground">{target.notes || "Описание не заполнено."}</p>
        {status.pending.length > 1 && <p className="text-xs text-muted-foreground">Вместе с пропущенными: {status.pending.length} релизов.</p>}
      </> : <p className="text-muted-foreground">{status.okAt > 0 && !status.error ? "Новых релизов доработок нет." : "Релизы доработок не проверены."}
        {status.installed && ` Установлено: ${status.installed}.`}</p>}
      {status.remaining > 0 && <p className="text-xs text-muted-foreground">Прошлое обновление применено частично, осталось шагов: {status.remaining}.</p>}
      <div className="flex flex-wrap gap-2">
        {target && <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={busy !== null}
          onClick={() => { void start().then(dismiss); }}>{busy === "start" ? "Запускаю…" : status.runOwner ? "Открыть обновление" : "Обновить с ИИ"}</button>}
        <button type="button" className={button} disabled={busy !== null} onClick={() => { void check(); }}>{busy === "check" ? "Проверяю…" : "Проверить"}</button>
        <button type="button" className={button} onClick={dismiss}>Скрыть</button>
      </div>
    </>}
  </div>;
}

const button = "inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50";

function Section() {
  const { status, busy, check, start } = useUpdates();
  if (!status) return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  const target = status.pending.at(-1);
  return <div className="space-y-3 text-sm" data-config-updates>
    <p>Установлено: <b>{status.installed ?? "версия не определена"}</b>
      {status.remaining > 0 && <span className="text-muted-foreground"> · предыдущее обновление применено частично, осталось шагов: {status.remaining}</span>}</p>
    <p className="text-muted-foreground">{status.checkedAt ? `Проверено: ${new Date(status.checkedAt).toLocaleString()}` : "Проверка ещё не выполнялась."}
      {status.repository && ` · ${status.repository}`}</p>
    {status.error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
      Проверка не удалась: {status.error} Это не означает, что обновлений нет.
      {status.okAt > 0 && ` Ниже — данные последней успешной проверки (${new Date(status.okAt).toLocaleString()}).`}</p>}
    {target ? <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="font-semibold">Доступно обновление {target.tag}{target.title !== target.tag && ` — ${target.title}`}</p>
      <p className="text-xs text-muted-foreground">Опубликовано {new Date(target.publishedAt).toLocaleDateString()} · коммит {status.commit?.slice(0, 12)}
        {status.pending.length > 1 && ` · будут применены по порядку: ${status.pending.map((r) => r.tag).join(", ")}`}</p>
      {status.pending.slice().reverse().filter((release) => release.notes || release === target).map((release) => <div key={release.tag}>
        {status.pending.length > 1 && <p className="text-xs font-medium">{release.tag}</p>}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-xs">{release.notes || "Описание не заполнено."}</pre>
        {release.url && <a className="text-xs underline" href={release.url} target="_blank" rel="noreferrer">Релиз на GitHub</a>}
      </div>)}
      <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={busy !== null} onClick={() => { void start(); }}>
        {busy === "start" ? "Запускаю…" : status.runOwner ? "Открыть выполняющееся обновление" : "Обновить с ИИ"}</button>
      <p className="text-xs text-muted-foreground">Кнопка открывает тред агента: он проверит фактическое состояние, применит только нужные шаги закреплённого релиза и сообщит результат. Проверка сама ничего не устанавливает.</p>
    </div> : status.okAt > 0 && !status.error && <p>Новых стабильных релизов нет.</p>}
    <button type="button" className={button} disabled={busy !== null} onClick={() => { void check(); }}>{busy === "check" ? "Проверяю…" : "Проверить сейчас"}</button>
  </div>;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "update-notice", component: Notice });
  footer = app.experimental_sidebarFooter.register({ kind: "disclosure", id: "updates", label: "Обновления доработок BB", icon: "Download", component: FooterCard });
  app.slots.settingsSection({ id: "updates", title: "Обновления доработок", description: "Стабильные релизы репозитория доработок BB", component: Section });
});
