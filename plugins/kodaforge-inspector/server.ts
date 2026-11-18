import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { LAYOUTS, UPSTREAM, layoutOf } from "./inspector";
const report = z.object({
  state: z.enum(["compatible", "incompatible", "waiting"]),
  reason: z.string().max(300),
});
const layout = z.enum(LAYOUTS);
export const rpcContract = defineRpcContract({
  config: { input: z.null(), output: z.object({ layout }) },
  choose: {
    input: z.object({ layout }),
    output: z.object({ layout }),
  },
  report: { input: report, output: z.object({ ok: z.boolean() }) },
});
export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    layout: {
      type: "select",
      label: "Вид редактора диалога в KodaForge",
      description:
        "«Спросить» показывает выбор с примерами при следующем открытии редактора диалога. До выбора действует штатный вид.",
      options: [...LAYOUTS],
      experimental_optionLabels: {
        ask: "Спросить при открытии",
        native: "Штатный: код по центру, чат справа",
        center: "Чат по центру, код по вкладке",
      },
      default: "ask",
    },
  });
  bb.rpc.register(rpcContract, {
    config: async () => ({ layout: layoutOf((await settings.get()).layout) }),
    choose: async (value) => {
      const next = await settings.experimental_set({ layout: value.layout });
      bb.realtime.publish("layout", {});
      return { layout: layoutOf(next.layout) };
    },
    report: async (value) => {
      await bb.storage.kv.set("last-inspection", {
        ...value,
        at: new Date().toISOString(),
      });
      return { ok: true };
    },
  });
  settings.onChange(() => bb.realtime.publish("layout", {}));
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
        layout: layoutOf(config.layout),
        upstreamTracking: tracking,
        source,
        browser: await bb.storage.kv.get("last-inspection"),
        update:
          "BB проверяет обновления; установка — кнопкой Update или bb plugin update kodaforge --yes. Инспектор применяется при загрузке совместимого интерфейса.",
        restore: "bb plugin config kodaforge-inspector set layout native",
      };
      return {
        exitCode: tracking ? 0 : 1,
        stdout: JSON.stringify(result, null, 2),
      };
    },
  });
}
