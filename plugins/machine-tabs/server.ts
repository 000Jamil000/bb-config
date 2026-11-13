// bb-plugin-machine-tabs — backend.
//
// Keeps the machine list and the selected machine tab (synced across
// windows), and forwards bb's thread-list preference calls (see rpcContract).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Realtime channel app.tsx listens on after a tab changes. */
export const TABS_CHANGED = "machine-tabs-changed";

const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
});
export type Machine = z.infer<typeof machineSchema>;

const outerSchema = z.enum(["none", "project", "machine", "day"]);

const stateSchema = z.object({
  machines: z.array(machineSchema),
  /** The machine whose tab is active, or null for All. */
  selectedId: z.string().nullable(),
  /** Split the flat list into day sections (Today, Yesterday, …). */
  byDay: z.boolean(),
  /** A grouping this plugin draws above bb's own, for two-level lists. */
  outer: outerSchema,
});
export type TabsState = z.infer<typeof stateSchema>;

const preferenceResultSchema = z.object({ key: z.string(), value: z.unknown() });

export const rpcContract = defineRpcContract({
  // bb's own thread list renders inside this plugin's list (see app.tsx), so
  // its preference calls arrive here; they are forwarded to the thread-list
  // plugin, which stays the single owner of those preferences.
  listPreferences: {
    input: z.null(),
    output: z.object({ preferences: z.record(z.string(), z.unknown()) }),
  },
  setPreference: {
    input: z.object({
      key: z.string(),
      value: z.unknown(),
      origin: z.string().min(1).optional(),
    }),
    output: preferenceResultSchema,
  },
  resetPreference: {
    input: z.object({ key: z.string() }),
    output: preferenceResultSchema,
  },
  tabs_state: { input: z.null(), output: stateSchema },
  tabs_set_view: {
    input: z.object({ byDay: z.boolean(), outer: outerSchema }),
    output: stateSchema,
  },
  tabs_select: {
    input: z.object({ machineId: z.string().min(1).nullable() }),
    output: stateSchema,
  },
});

const SELECTED_KEY = "selected-machine";
const BY_DAY_KEY = "group-by-day";
const OUTER_KEY = "outer-grouping";
const THREAD_LIST_PLUGIN = "thread-list";
/** The channel bb's thread list listens on for preference changes. */
const PREFERENCES_CHANGED = "preferences";

export default async function plugin(bb: BbPluginApi) {
  async function listMachines(): Promise<Machine[]> {
    const hosts = await bb.sdk.hosts.list();
    return hosts
      .filter((host) => host.type === "persistent")
      .filter(
        (host) =>
          host.lifecycle.phase !== "destroyed" &&
          host.lifecycle.phase !== "removing",
      )
      .map((host) => ({
        id: host.id,
        name: host.name,
        online: host.status === "connected",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function state(): Promise<TabsState> {
    const [machines, stored, byDay, storedOuter] = await Promise.all([
      listMachines(),
      bb.storage.kv.get<string | null>(SELECTED_KEY),
      bb.storage.kv.get<boolean>(BY_DAY_KEY),
      bb.storage.kv.get<string>(OUTER_KEY),
    ]);
    const outer = outerSchema.safeParse(storedOuter);
    const selectedId =
      stored && machines.some((m) => m.id === stored) ? stored : null;
    return {
      machines,
      selectedId,
      byDay: byDay === true,
      outer: outer.success ? outer.data : "none",
    };
  }

  async function setView(view: {
    byDay: boolean;
    outer: z.infer<typeof outerSchema>;
  }): Promise<TabsState> {
    await bb.storage.kv.set(BY_DAY_KEY, view.byDay);
    await bb.storage.kv.set(OUTER_KEY, view.outer);
    const next = await state();
    bb.realtime.publish(TABS_CHANGED, next);
    return next;
  }

  async function select(machineId: string | null): Promise<TabsState> {
    const machines = await listMachines();
    if (machineId !== null && !machines.some((m) => m.id === machineId)) {
      throw new Error(`Unknown machine: ${machineId}`);
    }
    await bb.storage.kv.set(SELECTED_KEY, machineId);
    const next = await state();
    bb.realtime.publish(TABS_CHANGED, next);
    return next;
  }

  function forward<T>(method: string, input: unknown, outputSchema: z.ZodType<T>) {
    return bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST_PLUGIN,
      method,
      input: input as never,
      outputSchema,
    });
  }

  bb.rpc.register(rpcContract, {
    async listPreferences() {
      return forward(
        "listPreferences",
        null,
        z.object({ preferences: z.record(z.string(), z.unknown()) }),
      );
    },
    async setPreference(input) {
      const result = await forward("setPreference", input, preferenceResultSchema);
      bb.realtime.publish(PREFERENCES_CHANGED, {
        key: result.key,
        value: result.value,
        origin: input.origin ?? null,
      } as never);
      return result;
    },
    async resetPreference(input) {
      const result = await forward("resetPreference", input, preferenceResultSchema);
      bb.realtime.publish(PREFERENCES_CHANGED, {
        key: result.key,
        value: result.value,
        origin: null,
      } as never);
      return result;
    },
    async tabs_state() {
      return state();
    },
    async tabs_set_view(view) {
      return setView(view);
    },
    async tabs_select({ machineId }) {
      return select(machineId);
    },
  });

  bb.cli.register({
    name: bb.pluginId,
    summary: "Switch the sidebar's machine tab",
    commands: [
      { name: "list", summary: "List machines; * marks the active tab", usage: "list" },
      { name: "select", summary: "Switch the tab", usage: "select <machine-id|all>" },
    ],
    async run(argv) {
      const [command, arg] = argv;
      if (command === "list" || command === undefined) {
        const current = await state();
        const lines = current.machines.map(
          (m) =>
            `${m.id === current.selectedId ? "*" : " "} ${m.id}  ${m.name}${m.online ? "" : " (offline)"}`,
        );
        lines.unshift(`${current.selectedId === null ? "*" : " "} all`);
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
      }
      if (command === "select" && arg !== undefined) {
        const next = await select(arg === "all" ? null : arg);
        const name =
          next.machines.find((m) => m.id === next.selectedId)?.name ?? "All";
        return { exitCode: 0, stdout: `Selected: ${name}\n` };
      }
      return {
        exitCode: 2,
        stderr: `Usage: bb ${bb.pluginId} list | select <machine-id|all>\n`,
      };
    },
  });
}
