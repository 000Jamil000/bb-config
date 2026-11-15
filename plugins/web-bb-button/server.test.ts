import assert from "node:assert/strict";
import test from "node:test";
import plugin from "./server.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

// This plugin uses settings and HTTP only; no database or storage is mocked.
function host(webUrl = "", appUrl: string | null = null) {
  const messages: string[] = [];
  const routes: Array<(context: any) => Promise<unknown>> = [];
  let change: ((next: { webUrl: string }) => void) | undefined;
  const bb = {
    settings: { define: () => ({ get: async () => ({ webUrl }),
      onChange: (handler: typeof change) => { change = handler; } }) },
    server: { experimental_appUrl: appUrl },
    status: { needsConfiguration: (message: string) => messages.push(message) },
    http: { route: (_method: string, _path: string, handler: typeof routes[number]) => routes.push(handler) },
  } as unknown as BbPluginApi;
  return { bb, messages, routes, update: (value: string) => { webUrl = value; change?.({ webUrl }); } };
}

test("new install requests configuration and does not register the open route", async () => {
  const h = host();
  await plugin(h.bb);
  assert.equal(h.messages.length, 1);
  assert.equal(h.routes.length, 0);
});

test("saved address enables opening; clearing it requests configuration again", async () => {
  const h = host("https://example.org/");
  await plugin(h.bb);
  assert.equal(h.messages.length, 0);
  const result = await h.routes[0]({ redirect: (url: string, status: number) => ({ url, status }) });
  assert.deepEqual(result, { url: "https://example.org/", status: 302 });
  h.update("");
  assert.equal(h.messages.length, 1);
});

test("invalid address requests setup; server configured address is accepted", async () => {
  const invalid = host("javascript:alert(1)");
  await plugin(invalid.bb);
  assert.equal(invalid.messages.length, 1);
  assert.equal(invalid.routes.length, 0);
  const configured = host("", "https://example.net/");
  await plugin(configured.bb);
  assert.equal(configured.messages.length, 0);
  assert.equal(configured.routes.length, 1);
});
