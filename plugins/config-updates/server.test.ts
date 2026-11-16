import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { io, type UpdateStatus } from "./server.ts";
import { buildPrompt, newerThan, parseRepository, stableReleases, type LocalStatus } from "./releases.ts";

const SHA = "a".repeat(40);
const release = (tag: string, extra: object = {}) => ({ tag_name: tag, name: `Release ${tag}`, body: `notes ${tag}`, draft: false,
  prerelease: false, html_url: `https://github.com/acme/config/releases/tag/${tag}`, published_at: "2026-11-01T00:00:00Z", ...extra });

function setup(options: { releases?: unknown; installed?: string | null; offline?: boolean; local?: Partial<LocalStatus>; sources?: object[] } = {}) {
  const state = { offline: options.offline ?? false, releases: options.releases ?? [release("v1.0.0"), release("v1.1.0")],
    spawned: [] as Record<string, any>[], archived: false, network: 0 };
  io.root = () => "/srv/config";
  io.origin = async () => "https://github.com/acme/config.git\n";
  io.local = async () => ({ installed: options.installed ? { release: options.installed, commit: SHA } : null, partial: null, run: null, ...options.local });
  io.releases = async () => { state.network += 1; if (state.offline) throw new Error("GitHub недоступен: timeout"); return state.releases; };
  io.commit = async () => SHA;
  const { bb, harness } = createFakePluginHost({ pluginId: "config-updates", sdk: {
    projects: { list: async () => [{ id: "proj", name: "config", kind: "standard", sources: options.sources ?? [
      { type: "local_path", hostId: "host_mac", path: "/work/other/config", isDefault: true },
      { type: "local_path", hostId: "host_server", path: "/srv/config/", isDefault: false }] }] },
    system: { config: async () => ({ primaryHostId: "host_server" }) },
    threads: {
      spawn: async (args: Record<string, any>) => { state.spawned.push(args); return { id: `thr_${state.spawned.length}` }; },
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, archivedAt: state.archived ? 1 : null }),
    },
  } as never });
  const rpc = (method: string) => harness.behavior.callRpc(method, null) as Promise<any>;
  return { bb, harness, state, rpc };
}

test("only published stable vX.Y.Z releases count; malformed answers are errors", () => {
  const tags = stableReleases([release("v1.2.0"), release("v1.10.0"), release("v2.0.0", { draft: true }),
    release("v1.11.0", { prerelease: true }), release("v1.12.0-rc.1"), release("nightly"), release("v1.9.0")]).map((r) => r.tag);
  assert.deepEqual(tags, ["v1.2.0", "v1.9.0", "v1.10.0"]);
  assert.deepEqual(newerThan(stableReleases([release("v1.2.0"), release("v1.10.0")]), "v1.2.0").map((r) => r.tag), ["v1.10.0"]);
  assert.throws(() => stableReleases({ message: "rate limited" }));
  assert.throws(() => stableReleases([{ tag_name: "v1.0.0" }]));
  assert.equal(parseRepository("git@github.com:acme/bb-config.git"), "acme/bb-config");
  assert.equal(parseRepository("https://token@github.com/acme/bb-config"), "acme/bb-config");
  assert.equal(parseRepository("https://example.org/acme/bb-config.git"), null);
});

test("check lists missed releases, pins the target commit and installs nothing", async () => {
  const s = setup({ installed: "v0.9.0" }); await plugin(s.bb);
  const status: UpdateStatus = await s.rpc("check");
  assert.deepEqual(status.pending.map((r) => r.tag), ["v1.0.0", "v1.1.0"]);
  assert.equal(status.commit, SHA); assert.equal(status.error, null); assert.equal(status.repository, "acme/config");
  assert.equal(s.state.spawned.length, 0);
  const upToDate = setup({ installed: "v1.1.0" }); await plugin(upToDate.bb);
  assert.deepEqual((await upToDate.rpc("check")).pending, []);
  await s.harness.lifecycle.dispose(); await upToDate.harness.lifecycle.dispose();
});

test("a network failure is a failed check that keeps the last known update", async () => {
  const s = setup({ installed: "v1.0.0" }); await plugin(s.bb);
  await s.rpc("check");
  s.state.offline = true;
  const failed: UpdateStatus = await s.rpc("check");
  assert.match(failed.error ?? "", /GitHub недоступен/);
  assert.deepEqual(failed.pending.map((r) => r.tag), ["v1.1.0"]);
  assert.ok(failed.checkedAt >= failed.okAt);
  const cli = await s.harness.behavior.runCli(["status"]);
  assert.equal(cli.exitCode, 1); assert.match(cli.stdout, /ОШИБКА ПРОВЕРКИ/); assert.doesNotMatch(cli.stdout, /релизов нет/);
  await assert.rejects(s.rpc("start"), /не запущено/);
  assert.equal(s.state.spawned.length, 0);
  const never = setup({ offline: true }); await plugin(never.bb);
  assert.doesNotMatch((await never.harness.behavior.runCli(["check"])).stdout, /релизов нет/);
  await s.harness.lifecycle.dispose(); await never.harness.lifecycle.dispose();
});

test("start spawns one agent thread on the server checkout with the pinned release", async () => {
  const s = setup({ installed: "v1.0.0" }); await plugin(s.bb);
  const [a, b] = await Promise.all([s.rpc("start"), s.rpc("start")]);
  assert.equal(s.state.spawned.length, 1); assert.deepEqual(a, b);
  const spawn = s.state.spawned[0]!;
  assert.equal(spawn.projectId, "proj");
  assert.deepEqual(spawn.environment, { type: "host", hostId: "host_server", workspace: { type: "unmanaged", path: "/srv/config" } });
  assert.match(spawn.prompt, new RegExp(`fetch v1\\.1\\.0 --commit ${SHA}`));
  assert.doesNotMatch(spawn.prompt, /origin\/main|git pull/);
  assert.deepEqual(await s.rpc("start"), { threadId: "thr_1", existing: true, tag: "v1.1.0" });
  s.state.archived = true; // the old thread is gone: a new one may start
  assert.equal((await s.rpc("start")).threadId, "thr_2");
  await s.harness.lifecycle.dispose();
});

test("an open run of another thread is joined, and a missing project is explained", async () => {
  const s = setup({ installed: "v1.0.0", local: { run: { release: "v1.1.0", owner: "thr_other", startedAt: "x" } } }); await plugin(s.bb);
  assert.deepEqual(await s.rpc("start"), { threadId: "thr_other", existing: true, tag: "v1.1.0" });
  const none = setup({ installed: "v1.0.0", sources: [] }); await plugin(none.bb);
  await assert.rejects(none.rpc("start"), /как проект BB/);
  const current = setup({ installed: "v1.1.0" }); await plugin(current.bb);
  await assert.rejects(current.rpc("start"), /релизов нет/);
  for (const each of [s, none, current]) await each.harness.lifecycle.dispose();
});

test("the schedule checks, and the prompt carries missed releases and a partial run", async () => {
  const s = setup({ installed: "v1.0.0" }); await plugin(s.bb);
  const before = s.state.network;
  await s.harness.behavior.runSchedule("check-releases");
  assert.equal(s.state.network, before + 1);
  const pending = stableReleases([release("v1.0.0"), release("v1.1.0")]);
  const prompt = buildPrompt({ repository: "acme/config", root: "/srv/config", target: pending[1]!, commit: SHA, pending,
    local: { installed: null, run: null, partial: { release: "v1.1.0", remaining: [{ step: "v1.1.0/x", machine: "host_b" }] } } });
  assert.match(prompt, /v1\.0\.0, v1\.1\.0/); assert.match(prompt, /частичным/); assert.match(prompt, /не определена/);
  assert.match(prompt, /restore\.py/);
  await s.harness.lifecycle.dispose();
});
