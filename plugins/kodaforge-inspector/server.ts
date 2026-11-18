import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { inspectorSettings, UPSTREAM } from "./inspector";
const report = z.object({
  state: z.enum(["compatible", "incompatible", "waiting"]),
  reason: z.string().max(300),
});
export const rpcContract = defineRpcContract({
  config: { input: z.null(), output: z.object({ enabled: z.boolean() }) },
  report: { input: report, output: z.object({ ok: z.boolean() }) },
});
export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(inspectorSettings);
  bb.rpc.register(rpcContract, {
    config: async () => settings.get(),
    report: async (value) => {
      await bb.storage.kv.set("last-inspection", {
        ...value,
        at: new Date().toISOString(),
      });
      return { ok: true };
    },
  });
  bb.cli.register({
    name: "kodaforge-inspector",
    summary: "Проверка источника обновлений и независимого слоя интерфейса",
    commands: [
      {
        name: "status",
        summary: "Источник KodaForge и последняя проверка браузера",
        usage: "bb kodaforge-inspector status",
      },
    ],
    async run(argv) {
      if (argv.length && argv[0] !== "status")
        return {
          exitCode: 1,
          stderr: "Команда: bb kodaforge-inspector status",
        };
      let source: unknown;
      let tracking = false;
      try {
        const result = await promisify(execFile)(
          process.env.BB_CLI || "bb",
          ["plugin", "source", "kodaforge", "--json"],
          { timeout: 15000, maxBuffer: 64000 },
        );
        source = JSON.parse(result.stdout);
        tracking = (source as { requested?: string }).requested === UPSTREAM;
      } catch (e) {
        source = { error: e instanceof Error ? e.message : String(e) };
      }
      const config = await settings.get();
      const result = {
        enabled: config.enabled,
        autoOpen: config.autoOpen,
        autoOpenThread: config.autoOpenThread,
        upstreamTracking: tracking,
        source,
        browser: await bb.storage.kv.get("last-inspection"),
        update:
          "BB проверяет обновления; установка — кнопкой Update или bb plugin update kodaforge --yes. Инспектор применяется при загрузке совместимого интерфейса.",
        restore: "bb plugin disable kodaforge-inspector",
      };
      return {
        exitCode: tracking ? 0 : 1,
        stdout: JSON.stringify(result, null, 2),
      };
    },
  });
}
