import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { imageType, MAX_BYTES } from "./policy.ts";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0L20 20"/></svg>';
function setup(options: { offline?: boolean; refreshFails?: boolean } = {}) {
  const files = new Map<string, string>([["/checkout/download.svg", svg]]);
  let writes = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-logo", sdk: {
    projects: { get: async () => ({ id: "p", name: "changan-update", kind: "standard", sources: [
      { type: "local_path", hostId: "remote-host", path: "/checkout", isDefault: true },
    ] }) },
    files: {
      list: async () => { if (options.offline) throw new Error("Host offline"); return { entries: [] }; },
      read: async (args: { hostId?: string; rootPath?: string; path: string }) => {
        assert.equal(args.hostId, "remote-host"); assert.equal(args.rootPath, "/checkout");
        const content = files.get(args.path);
        if (content === undefined) throw new Error("ENOENT");
        return { content, sizeBytes: Buffer.byteLength(content), contentEncoding: "utf8" };
      },
      write: async (args: { hostId?: string; path: string; content: string; expectedSha256?: string | null }) => {
        assert.equal(args.hostId, "remote-host"); assert.equal(args.expectedSha256, null);
        if (files.has(args.path)) throw new Error("File already exists");
        ++writes; files.set(args.path, Buffer.from(args.content, "base64").toString()); return { ok: true };
      },
    },
    threads: { updatePluginMetadata: async () => ({ metadata: { checked: true } }) },
    plugins: { callRpc: async () => { if (options.refreshFails) throw new Error("disabled"); return { icons: {} }; } },
  } as never });
  return { bb, harness, files, writes: () => writes };
}

test("passive SVG accepted; active content, external resources, malformed or oversized input rejected", () => {
  assert.equal(imageType(Buffer.from(svg)), "svg");
  for (const body of [svg.replace("<path", '<script/><path'), svg.replace("<path", '<path onclick="alert(1)"'),
    svg.replace("<path", '<use href="https://example.com/x"/><path'), svg.replace("<path", '<path fill="url(https://example.com/x)"'),
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>', '<html/>', svg.slice(0, -3)]) {
    assert.throws(() => imageType(Buffer.from(body)));
  }
  assert.throws(() => imageType(Buffer.alloc(MAX_BYTES + 1)));
});

test("new standard thread gets both tools and context instructions; checked/personal threads skip", async () => {
  const { bb, harness } = setup(); await plugin(bb);
  const ctx = makePluginAgentConfigurationContext({ project: { kind: "standard", name: "changan-update" } });
  const config = await harness.behavior.resolveAgentConfiguration(ctx);
  assert.match(JSON.stringify(config), /FIRST user message/);
  assert.match(JSON.stringify(config), /project_logo_install/);
  const checked = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { checked: true } }));
  assert.doesNotMatch(JSON.stringify(checked), /project_logo_status/);
  const personal = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ project: { kind: "personal" } }));
  assert.doesNotMatch(JSON.stringify(personal), /project_logo_status/);
  await harness.lifecycle.dispose();
});

test("concurrent installs write once to actual project source host, refresh sidebar, preserve original SVG", async () => {
  const s = setup(); await plugin(s.bb);
  const results = await Promise.all([1,2].map(() => s.harness.behavior.runCli(["install", "p", "download.svg", "project asset"])));
  assert.ok(results.every(r => r.exitCode === 0)); assert.equal(s.writes(), 1);
  assert.equal(s.files.get("/checkout/.bb/icon.svg"), svg);
  assert.equal(s.harness.inspection.sdk.callsTo("plugins.callRpc").length, 1);
  await s.harness.lifecycle.dispose();
});

test("an existing favicon wins and is never overwritten", async () => {
  const s = setup(); s.files.set("/checkout/favicon.svg", svg); await plugin(s.bb);
  const result = await s.harness.behavior.runCli(["install", "p", "download.svg", "project asset"]);
  assert.match(result.stdout ?? "", /existing/); assert.equal(s.writes(), 0);
  await s.harness.lifecycle.dispose();
});

test("offline source and directory escape cannot cause a write", async () => {
  for (const offline of [true, false]) {
    const s = setup({ offline }); await plugin(s.bb);
    const result = await s.harness.behavior.runCli(["install", "p", "../outside.svg", "project asset"]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(s.writes(), 0); await s.harness.lifecycle.dispose();
  }
});

test("saved image survives unavailable Machine Tabs and status marks thread checked", async () => {
  const s = setup({ refreshFails: true }); await plugin(s.bb);
  await s.harness.behavior.callAgentTool("project_logo_status", {}, { threadId: "t", projectId: "p" });
  assert.equal(s.harness.inspection.sdk.callsTo("threads.updatePluginMetadata").length, 1);
  const result = await s.harness.behavior.runCli(["install", "p", "download.svg", "project asset"]);
  assert.match(result.stdout ?? "", /installed/); assert.equal(s.writes(), 1);
  await s.harness.lifecycle.dispose();
});
