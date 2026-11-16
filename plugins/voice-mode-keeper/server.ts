import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const State = z.enum(["idle", "checking", "ready", "attention"]);
/** A catalog plugin whose small source fix is kept across updates (patch_keeper.py). */
const Kept = z.object({ plugin: z.string(), name: z.string(), state: State, message: z.string(), version: z.string() });
const Status = z.object({ state: State, message: z.string(), version: z.string(), kept: z.array(Kept).default([]) });
export type KeeperStatus = z.infer<typeof Status>;
export const rpcContract = defineRpcContract({ status: { input: z.null(), output: Status } });
const PREFERENCE_KEYS = ["voice", "connection", "messageText", "prefixMessages", "widgetStyle", "vadThreshold", "silenceDurationMs", "noiseReduction"];
const INITIAL: KeeperStatus = { state: "checking", message: "Проверяю совместимость Voice Mode…", version: "", kept: [] };
const KEPT_PLUGINS = ["inbox", "tokenomics"];
/** Recheck kept fixes this often even without an update (cheap when in place). */
const KEPT_RECHECK_MS = 10 * 60_000;

function workerPath() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const paths = [resolve(directory, "../voice-mode/auto_update.py"), resolve(directory, "../../voice-mode/auto_update.py")];
  const path = paths.find(existsSync);
  if (!path) throw new Error("Исходники сопровождения Voice Mode не найдены в bb-config.");
  return path;
}

/** Runs patch_keeper.py; one JSON status line per kept plugin. */
async function runPatchKeeper(cliPath: string, serverUrl: string, signal: AbortSignal): Promise<z.infer<typeof Kept>[]> {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../patch_keeper.py");
  const path = existsSync(script) ? script : resolve(dirname(fileURLToPath(import.meta.url)), "patch_keeper.py");
  return new Promise((resolveResult, reject) => {
    const child = spawn("python3", [path], {
      detached: true, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, BB_CLI: cliPath, BB_SERVER_URL: serverUrl, PATH: `${dirname(cliPath)}:${process.env.PATH ?? ""}` },
    });
    let output = "";
    const stop = () => { try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ } };
    const timeout = setTimeout(stop, 300_000);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) return reject(new Error("Cancelled"));
      const rows = output.split("\n").filter(Boolean).flatMap((line) => {
        try { return [Kept.parse(JSON.parse(line))]; } catch { return []; }
      });
      resolveResult(rows);
    });
  });
}

async function runWorker(script: string, cliPath: string, serverUrl: string, signal: AbortSignal, snapshot = false): Promise<KeeperStatus> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("python3", [script, ...(snapshot ? ["--snapshot"] : [])], {
      detached: true, stdio: ["ignore", "pipe", "ignore"],
      // The CLI otherwise targets the default port, which on a machine with a
      // second BB (or one on another port) is a different server.
      env: { ...process.env, BB_CLI: cliPath, BB_SERVER_URL: serverUrl, VOICE_KEEPER_NODE: process.execPath,
        PATH: `${dirname(cliPath)}:${process.env.PATH ?? ""}` },
    });
    let output = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      killTimer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ } }, 2000);
    };
    const timeout = setTimeout(terminate, 180_000);
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384); });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", terminate);
      if (signal.aborted) return reject(new Error("Cancelled"));
      try { resolveResult(Status.parse(JSON.parse(output.trim().split("\n").at(-1)!))); }
      catch { reject(new Error("Не удалось проверить обновление Voice Mode.")); }
    });
  });
}

export default async function keeper(bb: BbPluginApi) {
  const settings = bb.settings.define({
    cliPath: { type: "string", label: "BB CLI executable", default: process.env.BB_CLI ?? "",
      description: "Absolute path to the official bb CLI on this server; set during installation." },
  });
  let status = (await bb.storage.kv.get<KeeperStatus>("status")) ?? INITIAL;
  let observed = "";
  let preferences = (await bb.storage.kv.get<Record<string, string | number | boolean>>("preferences")) ?? {};
  let preferenceInstall = (await bb.storage.kv.get<string>("preference-install")) ?? "";
  const script = workerPath();
  const policy = createHash("sha256").update(readFileSync(resolve(dirname(script), "changes.json"))).digest("hex");
  let kept: z.infer<typeof Kept>[] = status.kept ?? [];
  let keptObserved = "";
  let keptCheckedAt = 0;
  const publish = async (incoming: KeeperStatus) => {
    const next = { ...incoming, kept };
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    await bb.storage.kv.set("status", status);
    bb.realtime.publish("status", {});
  };
  bb.rpc.register(rpcContract, { status: () => status });
  bb.background.service("preserve-voice-mode", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const { plugins } = await bb.sdk.plugins.list();
          const plugin = plugins.find((p) => p.id === "voice-mode");
          if (!plugin || !plugin.enabled) {
            observed = "";
            await publish({ state: "idle", message: "Voice Mode выключен или не установлен.", version: "", kept: [] });
          } else {
            const jobs = await bb.sdk.plugins.experimental_updateJobs.list();
            const busy = jobs.some((job) => job.pluginId === "voice-mode" && (job.state === "queued" || job.state === "running"));
            if (!busy) {
              const { cliPath } = await settings.get();
              if (!cliPath || !existsSync(cliPath)) throw new Error("BB CLI executable unavailable");
              const signature = `${plugin.rootDir}|${plugin.version}|${plugin.app?.bundle?.hash ?? ""}|${policy}|${cliPath}`;
              if (signature !== observed) {
                await publish(INITIAL);
                let result = await runWorker(script, cliPath, bb.server.loopbackBaseUrl, signal);
                if (result.state === "ready" && preferenceInstall && preferenceInstall !== plugin.rootDir && Object.keys(preferences).length) {
                  const settings = await bb.sdk.plugins.getSettings({ pluginId: "voice-mode" });
                  const supported = Object.fromEntries(Object.entries(preferences).filter(([key]) => key in settings.schema));
                  if (Object.keys(supported).length) await bb.sdk.plugins.updateSettings({ pluginId: "voice-mode", values: supported });
                }
                if (result.state === "ready") {
                  const snapshot = await runWorker(script, cliPath, bb.server.loopbackBaseUrl, signal, true);
                  if (snapshot.state === "attention") result = snapshot;
                }
                await publish(result);
                observed = signature;
              }
              if (status.state === "ready") {
                const settings = await bb.sdk.plugins.getSettings({ pluginId: "voice-mode" });
                const selected: typeof preferences = {};
                for (const key of PREFERENCE_KEYS) {
                  const value = settings.values[key];
                  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") selected[key] = value;
                }
                if (JSON.stringify(selected) !== JSON.stringify(preferences)) {
                  preferences = selected;
                  await bb.storage.kv.set("preferences", preferences);
                }
                if (preferenceInstall !== plugin.rootDir) {
                  preferenceInstall = plugin.rootDir;
                  await bb.storage.kv.set("preference-install", preferenceInstall);
                }
              }
            }
          }
        } catch {
          if (!signal.aborted) await publish({ state: "attention", message: "Не удалось проверить обновление Voice Mode. Исходный плагин продолжает работать.", version: "", kept: [] });
        }
        // Needs You and Tokenomics: re-apply their small fixes after updates.
        try {
          const { plugins } = await bb.sdk.plugins.list();
          const jobs = await bb.sdk.plugins.experimental_updateJobs.list();
          const busy = jobs.some((job) => KEPT_PLUGINS.includes(job.pluginId) && (job.state === "queued" || job.state === "running"));
          const signature = plugins.filter((p) => KEPT_PLUGINS.includes(p.id))
            .map((p) => `${p.id}|${p.enabled}|${p.rootDir}|${p.version}|${p.app?.bundle?.hash ?? ""}`).join(";");
          const { cliPath } = await settings.get();
          if (!busy && cliPath && existsSync(cliPath)
            && (signature !== keptObserved || Date.now() - keptCheckedAt > KEPT_RECHECK_MS)) {
            const rows = await runPatchKeeper(cliPath, bb.server.loopbackBaseUrl, signal);
            keptCheckedAt = Date.now();
            if (rows.length) {
              kept = rows;
              // Reapplying rebuilds and reloads: take the new bundle hash next time.
              const { plugins: after } = await bb.sdk.plugins.list();
              keptObserved = after.filter((p) => KEPT_PLUGINS.includes(p.id))
                .map((p) => `${p.id}|${p.enabled}|${p.rootDir}|${p.version}|${p.app?.bundle?.hash ?? ""}`).join(";");
              await publish(status);
            }
          }
        } catch {
          // Next iteration retries.
        }
        try { await delay(30_000, undefined, { signal }); } catch { break; }
      }
    },
  });
}
