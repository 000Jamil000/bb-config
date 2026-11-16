// bb-plugin-menubar-status — backend only.
//
// Writes a small JSON summary of the agents (who needs you, who is running,
// last reply) to a file on one machine. A menu bar widget there reads the
// file: no network call and no credentials on that machine, so the widget is
// instant and cannot lag.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildFeed, oneLine, sameContent, type Feed, type FeedThread } from "./feed.ts";

const SNIPPETS_KEY = "snippets-v3";
const DEBOUNCE_MS = 1200;
/** Rewrites an unchanged feed this often, so the widget can tell it is alive. */
const HEARTBEAT_MS = 60_000;
const POLL_MS = 20_000;

export default async function menubarStatus(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostId: { type: "string", label: "Machine that shows the menu bar widget (host ID)", default: "" },
    filePath: { type: "string", label: "Absolute path of the status file on that machine", default: "" },
    webUrl: { type: "string", label: "Public BB address for links (optional)", default: "" },
    maxItems: { type: "string", label: "How many agents to list", default: "8" },
  });

  let snippets: Record<string, string> =
    (await bb.storage.kv.get<Record<string, string>>(SNIPPETS_KEY)) ?? {};
  let last: Feed | null = null;
  let lastWriteAt = 0;
  let madeDirFor = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  async function listThreads(args: Record<string, unknown>): Promise<FeedThread[]> {
    const result = (await bb.sdk.threads.list({ archived: false, limit: 200, ...args } as never)) as unknown;
    const rows = Array.isArray(result) ? result : ((result as { threads?: unknown[] }).threads ?? []);
    return rows as FeedThread[];
  }

  async function compute(): Promise<Feed> {
    const { webUrl, maxItems } = await settings.get();
    const [threads, projects, hosts] = await Promise.all([
      listThreads({}),
      bb.sdk.projects.list({ includePersonal: true } as never),
      bb.sdk.hosts.list(),
    ]);
    const machineNames = new Map<string, string>();
    await Promise.all(
      hosts
        .filter((host) => host.type === "persistent")
        .map(async (host) => {
          for (const thread of await listThreads({ hostId: host.id })) {
            machineNames.set(thread.id, host.name);
          }
        }),
    );
    const alive = new Set(threads.map((thread) => thread.id));
    for (const id of Object.keys(snippets)) if (!alive.has(id)) delete snippets[id];
    const build = () =>
      buildFeed({
      threads,
      projectNames: new Map(
        (projects as { id: string; name: string; kind?: string }[]).map((project) => [
          project.id,
          project.kind === "personal" ? "" : project.name,
        ]),
      ),
      machineNames,
      snippets,
      webUrl,
      maxItems: Math.min(20, Math.max(1, Number.parseInt(maxItems, 10) || 8)),
        now: Date.now(),
      });
    // Replies from before this plugin was installed: read them once.
    const missing = build().items.filter(
      (item) => !item.snippet && item.state !== "running" && !(item.id in snippets),
    );
    if (missing.length > 0) {
      await Promise.all(
        missing.map(async (item) => {
          try {
            const { output } = await bb.sdk.threads.output({ threadId: item.id });
            snippets[item.id] = oneLine(output);
          } catch {
            snippets[item.id] = "";
          }
        }),
      );
      void bb.storage.kv.set(SNIPPETS_KEY, snippets);
    }
    return build();
  }

  async function publish(): Promise<void> {
    const { hostId, filePath } = await settings.get();
    if (!hostId || !filePath.startsWith("/")) {
      bb.status.needsConfiguration(
        "Set the machine (host ID) and an absolute status file path in Menubar Status settings.",
      );
      return;
    }
    const feed = await compute();
    if (sameContent(last, feed) && Date.now() - lastWriteAt < HEARTBEAT_MS) return;
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    if (madeDirFor !== `${hostId}:${dir}`) {
      await bb.sdk.files.mkdir({ hostId, path: dir, recursive: true });
      madeDirFor = `${hostId}:${dir}`;
    }
    await bb.sdk.files.write({ hostId, path: filePath, content: `${JSON.stringify(feed)}\n` });
    last = feed;
    lastWriteAt = Date.now();
  }

  function run(): void {
    if (running) {
      again = true;
      return;
    }
    running = publish()
      .catch((error) => {
        // The machine may be asleep or offline: the next event or poll retries.
        bb.log.warn(`status file not written: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          schedule();
        }
      });
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, DEBOUNCE_MS);
  }

  for (const event of [
    "thread.created",
    "thread.active",
    "thread.failed",
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
    "interaction.pending",
    "experimental_thread.read",
  ] as const) {
    bb.events.on(event as never, schedule as never);
  }
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const text = oneLine(lastAssistantText);
    if (text) {
      snippets[thread.id] = text;
      void bb.storage.kv.set(SNIPPETS_KEY, snippets);
    }
    schedule();
  });
  settings.onChange(() => {
    last = null;
    madeDirFor = "";
    schedule();
  });

  // Resolved interactions and renames have no event of their own.
  const poll = setInterval(schedule, POLL_MS);
  bb.onDispose(() => {
    clearInterval(poll);
    if (timer) clearTimeout(timer);
  });

  bb.cli.register({
    name: bb.pluginId,
    summary: "Agent status file for the menu bar widget",
    commands: [
      { name: "show", summary: "Print the current status feed", usage: "show" },
      { name: "sync", summary: "Write the status file now", usage: "sync" },
    ],
    async run(argv) {
      const [command] = argv;
      if (command === "sync") {
        last = null;
        await publish();
        const { hostId, filePath } = await settings.get();
        return { exitCode: 0, stdout: last ? `Written to ${hostId}:${filePath}\n` : "Not configured\n" };
      }
      if (command === "show" || command === undefined) {
        return { exitCode: 0, stdout: `${JSON.stringify(await compute(), null, 2)}\n` };
      }
      return { exitCode: 2, stderr: `Usage: bb ${bb.pluginId} show | sync\n` };
    },
  });

  schedule();
}
