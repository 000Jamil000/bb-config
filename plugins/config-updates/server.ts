import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildPrompt, compareTags, newerThan, parseRepository, stableReleases, type LocalStatus, type Release } from "./releases.ts";

const run = promisify(execFile);
const ReleaseSchema = z.object({ tag: z.string(), title: z.string(), notes: z.string(), url: z.string(), publishedAt: z.string() });
const StatusSchema = z.object({
  /** Last attempt, successful or not (ms). 0 = never checked. */
  checkedAt: z.number(),
  /** Last attempt that reached GitHub and read the journal (ms). */
  okAt: z.number(),
  /** Why the last attempt failed. A failed check says nothing about updates. */
  error: z.string().nullable(),
  repository: z.string(),
  installed: z.string().nullable(),
  /** When the installed version was recorded in the journal (ISO), if known. */
  installedAt: z.string().nullable().default(null),
  /** Unfinished steps of a previous run; the update stays available. */
  remaining: z.number(),
  /** Thread owning an open update run, if any. */
  runOwner: z.string().nullable(),
  /** Release the open run is applying. */
  runRelease: z.string().nullable().default(null),
  /** Releases newer than the installed one, oldest first; the last is the target. */
  pending: z.array(ReleaseSchema),
  /** Commit the target tag pointed at when checked. */
  commit: z.string().nullable(),
  threadId: z.string().nullable(),
  /** Release the update thread was started for. */
  threadTag: z.string().nullable().default(null),
});
export type UpdateStatus = z.infer<typeof StatusSchema>;
const StartSchema = z.object({ threadId: z.string(), existing: z.boolean(), tag: z.string() });
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: StatusSchema },
  check: { input: z.null(), output: StatusSchema },
  start: { input: z.null(), output: StartSchema },
});

const EMPTY: UpdateStatus = { checkedAt: 0, okAt: 0, error: null, repository: "", installed: null, installedAt: null, remaining: 0,
  runOwner: null, runRelease: null, pending: [], commit: null, threadId: null, threadTag: null };
const STALE_MS = 6 * 3_600_000;
const SHA = /^[0-9a-f]{40}$/;
const NOTES_FOR = 5;

/** Checkout root: the plugin runs from <checkout>/plugins/config-updates (or its dist/). */
function findRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1, directory = dirname(directory)) {
    if (existsSync(resolve(directory, "scripts/updates.py")) && existsSync(resolve(directory, ".git"))) return realpathSync(directory);
  }
  throw new Error("Плагин должен быть установлен из checkout репозитория доработок (path:…/plugins/config-updates): рядом нет scripts/updates.py.");
}

async function github(path: string, accept: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: { Accept: accept, "User-Agent": "bb-config-updates", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`GitHub недоступен: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const limited = response.status === 403 || response.status === 429;
    throw new Error(limited ? "GitHub временно ограничил запросы; повторите позже." : `GitHub ответил ${response.status} на ${path}`);
  }
  return response;
}

/** Everything that touches the outside world; tests replace these. */
export const io = {
  root: findRoot,
  async origin(root: string): Promise<string> {
    return (await run("git", ["-C", root, "remote", "get-url", "origin"])).stdout;
  },
  async local(root: string): Promise<LocalStatus> {
    const { stdout } = await run("python3", [resolve(root, "scripts/updates.py"), "status"], { timeout: 30_000 });
    return JSON.parse(stdout) as LocalStatus;
  },
  async releases(repository: string): Promise<unknown> {
    return (await github(`/repos/${repository}/releases?per_page=100`, "application/vnd.github+json")).json();
  },
  async commit(repository: string, tag: string): Promise<string> {
    return (await (await github(`/repos/${repository}/commits/${encodeURIComponent(tag)}`, "application/vnd.github.sha")).text()).trim();
  },
};

export default async function configUpdates(bb: BbPluginApi) {
  const settings = bb.settings.define({
    repository: { type: "string", label: "Репозиторий GitHub (owner/repo)", default: "",
      description: "Откуда брать стабильные релизы. Пусто — remote origin этого checkout." },
    archiveWhenDone: { type: "boolean", label: "Архивировать тред после успешного обновления", default: true,
      description: "Тред обновления уходит в архив, когда релиз применён полностью и агент закончил ответ. При остатке или ошибке тред остаётся." },
  });
  let status: UpdateStatus = { ...EMPTY, ...((await bb.storage.kv.get<UpdateStatus>("status")) ?? {}) };
  let local: LocalStatus = { installed: null, partial: null, run: null };
  let root = "";
  let checking: Promise<UpdateStatus> | null = null;
  let starting: Promise<z.infer<typeof StartSchema>> | null = null;

  const publish = async (next: UpdateStatus) => {
    status = next;
    await bb.storage.kv.set("status", status);
    bb.realtime.publish("status", {});
    return status;
  };

  async function checkOnce(): Promise<UpdateStatus> {
    const checkedAt = Date.now();
    try {
      root = io.root();
      const configured = (await settings.get()).repository.trim();
      const repository = configured || parseRepository(await io.origin(root));
      if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        throw new Error("Не удалось определить репозиторий GitHub: укажите owner/repo в настройках плагина.");
      }
      local = await io.local(root);
      const installed = local.installed?.release ?? null;
      // Stored status must stay small: full notes only for the newest releases.
      const pending = newerThan(stableReleases(await io.releases(repository)), installed)
        .map((release, index, all) => (index < all.length - NOTES_FOR ? { ...release, notes: "" } : release));
      const target = pending.at(-1);
      const commit = target ? await io.commit(repository, target.tag) : null;
      if (commit !== null && !SHA.test(commit)) throw new Error(`GitHub не вернул коммит релиза ${target!.tag}.`);
      return await publish({ checkedAt, okAt: checkedAt, error: null, repository, installed, pending, commit,
        installedAt: local.installed?.at ?? null,
        remaining: local.partial?.remaining.length ?? 0, runOwner: local.run?.owner ?? null, runRelease: local.run?.release ?? null,
        threadId: status.threadId, threadTag: status.threadTag });
    } catch (error) {
      // Keep the last known answer; never turn a failed check into "up to date".
      return await publish({ ...status, checkedAt, error: (error as Error).message.slice(0, 300) });
    }
  }
  const check = () => (checking ??= checkOnce().finally(() => { checking = null; }));

  /** The update thread started earlier, while it still exists and is not archived. */
  async function liveThread(threadId: string | null): Promise<string | null> {
    if (!threadId) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.archivedAt ? null : thread.id;
    } catch {
      return null;
    }
  }

  async function startOnce(): Promise<z.infer<typeof StartSchema>> {
    const fresh = await check();
    if (fresh.error) throw new Error(`Проверка не удалась, обновление не запущено: ${fresh.error}`);
    const target = fresh.pending.at(-1);
    if (!target || !fresh.commit) throw new Error("Новых опубликованных релизов нет.");
    // One update at a time: reuse the thread that already works on it.
    const existing = await liveThread(fresh.runOwner?.startsWith("thr_") ? fresh.runOwner : null) ?? await liveThread(fresh.threadId);
    if (existing) return { threadId: existing, existing: true, tag: target.tag };
    const projects = await bb.sdk.projects.list();
    const { primaryHostId } = await bb.sdk.system.config();
    const sources = projects.flatMap((project) => project.sources.map((source) => ({ project, source })))
      .filter(({ source }) => source.path.replace(/\/+$/, "") === root)
      .sort((a, b) => Number(b.source.hostId === primaryHostId) - Number(a.source.hostId === primaryHostId));
    const match = sources[0];
    if (!match) throw new Error(`Добавьте каталог ${root} на машине сервера BB как проект BB, затем повторите.`);
    const thread = await bb.sdk.threads.spawn({
      projectId: match.project.id,
      environment: { type: "host", hostId: match.source.hostId, workspace: { type: "unmanaged", path: root } },
      title: `Обновление доработок BB до ${target.tag}`,
      prompt: buildPrompt({ repository: fresh.repository, root, target, commit: fresh.commit, pending: fresh.pending, local }),
    });
    await publish({ ...status, threadId: thread.id, threadTag: target.tag });
    return { threadId: thread.id, existing: false, tag: target.tag };
  }
  const start = () => (starting ??= startOnce().finally(() => { starting = null; }));

  /**
   * The update thread finished a turn. Archive it only when the journal says the
   * release it was started for is fully installed; a partial or failed update
   * keeps its thread so the user sees what is left.
   */
  bb.events.on("thread.idle", async ({ thread }) => {
    if (!status.threadId || thread.id !== status.threadId || !status.threadTag) return;
    try {
      const journal = await io.local(root || io.root());
      const installed = journal.installed?.release;
      if (journal.run || journal.partial || !installed || compareTags(installed, status.threadTag) < 0) return;
      const archive = (await settings.get()).archiveWhenDone;
      const { threadId } = status;
      await publish({ ...status, threadId: null, threadTag: null });
      if (archive) await bb.sdk.threads.archive({ threadId });
      await check();
    } catch (error) {
      bb.log.warn(`Update thread was not archived: ${String(error)}`);
    }
  });

  bb.rpc.register(rpcContract, { status: () => status, check, start });
  bb.background.schedule("check-releases", "17 */6 * * *", async () => { await check(); });
  bb.background.service("initial-check", {
    async start(signal) {
      if (Date.now() - status.checkedAt > STALE_MS) await check();
      await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
    },
  });
  bb.cli.register({
    name: "config-updates", summary: "Проверка релизов доработок BB и запуск обновления агентом",
    commands: [
      { name: "status", summary: "Последний результат проверки, без обращения к сети", usage: "status [--json]" },
      { name: "check", summary: "Проверить опубликованные стабильные релизы сейчас", usage: "check [--json]" },
      { name: "start", summary: "Запустить тред агента, применяющий обновление", usage: "start" },
    ],
    async run(argv) {
      const [command, flag] = argv;
      if (command === "start") {
        const started = await start();
        return { exitCode: 0, stdout: `${started.existing ? "Обновление уже выполняется" : "Запущено обновление"} до ${started.tag}: ${started.threadId}\n` };
      }
      if (command !== "status" && command !== "check") {
        return { exitCode: 2, stderr: "Usage: bb config-updates status|check [--json] | start\n" };
      }
      const result = command === "check" ? await check() : status;
      if (flag === "--json") return { exitCode: result.error ? 1 : 0, stdout: JSON.stringify(result, null, 2) + "\n" };
      const target = result.pending.at(-1);
      const lines = [
        `Установлено: ${result.installed ? `${result.installed}${result.installedAt ? ` (с ${result.installedAt.slice(0, 10)})` : ""}` : "не определено"}${result.remaining ? ` (не завершено шагов: ${result.remaining})` : ""}`,
        result.checkedAt ? `Проверено: ${new Date(result.checkedAt).toISOString()}` : "Проверка ещё не выполнялась.",
        ...(result.error ? [`ОШИБКА ПРОВЕРКИ: ${result.error}`, "Это не означает отсутствие обновлений."] : []),
        ...(result.runRelease ? [`Сейчас идёт обновление до ${result.runRelease} (тред ${result.runOwner}).`] : []),
        target ? `Доступно: ${target.tag}${target.title === target.tag ? "" : ` — ${target.title}`}, опубликован ${target.publishedAt.slice(0, 10)} (${result.commit?.slice(0, 12)}); к применению: ${result.pending.map((r) => r.tag).join(", ")}`
          : result.okAt ? "Новых стабильных релизов нет." : "",
      ].filter(Boolean);
      return { exitCode: result.error ? 1 : 0, stdout: lines.join("\n") + "\n" };
    },
  });
}
