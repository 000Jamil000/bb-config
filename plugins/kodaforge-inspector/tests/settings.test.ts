import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act } from "@testing-library/react";
import { inspectorSettings, autoOpenWorkspace } from "../inspector";

const id = "thr_" + "example";
const dialog = "/projects/example/threads/" + id;
const editor = "/plugins/kodaforge/forge/thread/" + id;
const dom = new JSDOM("", { url: "https://example.test", pretendToBeVisual: true });
const { window } = dom;
after(() => window.close());
for (const name of ["window", "document", "location", "Element", "HTMLElement", "MutationObserver", "PopStateEvent"] as const)
  Object.defineProperty(globalThis, name, { configurable: true, value: window[name] });
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const { appOverlays } = await loadPluginApp(() => import("../app"));
const overlay = appOverlays[0]!;

function open(path: string) {
  window.history.replaceState(null, "", path);
  window.document.body.innerHTML = `<div class="kf-root"><nav aria-label="Views"></nav>
    <div data-panel id="main"><div data-panel id="editors"><div><input value="draft"></div></div></div>
    <footer><button title="Switch branch"></button><button title="Toggle Terminal (⌃&#96;)"></button></footer></div>`;
  const root = document.querySelector(".kf-root")!;
  Object.defineProperty(root, "getClientRects", { value: () => [{}] });
}
const report = () => ({ ok: true });
const sdk = { plugins: { list: async () => ({
  plugins: [{ id: "kodaforge", enabled: true, app: { bundle: { compatible: true } } }],
}) } };

test("fresh install preserves normal chat, editor and compatibility inspection", () => {
  assert.equal(inspectorSettings.enabled.default, false);
  assert.equal(inspectorSettings.autoOpen.default, false);
  assert.equal(inspectorSettings.autoOpenThread.default, "");
  open(editor);
  const view = renderSlot(overlay, {}, { rpc: { report } });
  try {
    assert.equal(document.querySelector("[data-kfi-owned]"), null);
    assert.ok(view.rpcCalls.some(call => call.method === "report"));
  } finally { view.unmount(); }
});

for (const centered of [false, true]) {
  for (const autoOpen of [false, true]) {
    test(`centered=${centered}, autoOpen=${autoOpen}: select dialog and open editor`, async () => {
      open(dialog);
      const options = { settings: { enabled: centered, autoOpen, autoOpenThread: id }, rpc: { report }, sdk };
      const view = renderSlot(overlay, {}, options);
      try {
        await act(async () => {});
        assert.equal(location.pathname, autoOpen ? editor : dialog);
        if (!autoOpen) {
          await act(async () => {
            window.history.pushState(null, "", editor);
            window.dispatchEvent(new window.PopStateEvent("popstate"));
          });
        }
        assert.equal(Boolean(document.querySelector("[data-kfi-layout]")), centered);
        assert.equal(document.querySelector("input")?.value, "draft");
      } finally { view.unmount(); }
      assert.equal(document.querySelector("[data-kfi-layout]"), null);
    });
  }
}

test("only the selected plain conversation opens automatically", () => {
  for (const route of [dialog + "2", dialog + "/file", dialog + "#message", dialog + "?split=1", editor, "/settings"])
    assert.equal(autoOpenWorkspace(route, true, id), null);
  for (const selected of ["", null, "*", "../" + id])
    assert.equal(autoOpenWorkspace(dialog, true, selected), null);
  assert.equal(autoOpenWorkspace(dialog, false, id), null);
  assert.equal(autoOpenWorkspace(dialog + "/", true, id), editor);
});

test("an unavailable editor leaves the selected conversation open", async () => {
  open(dialog);
  const view = renderSlot(overlay, {}, {
    settings: { autoOpen: true, autoOpenThread: id },
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
  });
  try {
    await act(async () => {});
    assert.equal(location.pathname, dialog);
  } finally { view.unmount(); }
});
