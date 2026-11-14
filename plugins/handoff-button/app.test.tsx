// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { openOriginalHandoff } from "./open-original";

afterEach(() => { document.body.innerHTML = ""; });

it("opens the original Handoff through native controls in the clicked thread's pane", async () => {
  document.body.innerHTML = '<div data-split-pane-id="other"><button data-panel-new-tab></button></div><div data-split-pane-id="source"><button id="shortcut"></button><button aria-label="Show right panel (⌘J)"></button></div>';
  const root = document.querySelector<HTMLElement>('[data-split-pane-id="source"]')!;
  const actions: string[] = [];
  root.querySelector<HTMLButtonElement>('[aria-label]')!.onclick = () => {
    actions.push("show");
    const newTab = document.createElement("button"); newTab.dataset.panelNewTab = "";
    newTab.onclick = () => {
      actions.push("new-tab");
      queueMicrotask(() => {
        const page = document.createElement("div"); page.dataset.panelNewTabPage = "";
        const original = document.createElement("button"); original.dataset.panelNewTabItem = "";
        original.id = "plugin-action:handoff:handoff";
        original.onclick = () => { actions.push("original-handoff"); };
        page.append(original); root.append(page);
      });
    };
    root.append(newTab);
  };
  await openOriginalHandoff(root.querySelector("#shortcut")!, new AbortController().signal);
  expect(actions).toEqual(["show", "new-tab", "original-handoff"]);
});

it("cancels a pending open without clicking another pane's controls", async () => {
  document.body.innerHTML = '<div data-split-pane-id="source"><button id="shortcut"></button></div>';
  const controller = new AbortController();
  const opened = openOriginalHandoff(document.querySelector("#shortcut")!, controller.signal);
  controller.abort();
  await expect(opened).rejects.toThrow("Opening cancelled");
});
