import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountSetupShortcut } from "./shortcut.ts";

function fixture(reason = "Select an environment.", footer = true) {
  const dom = new JSDOM(`<div data-app-composer><div><button data-promptbox-submit-action disabled aria-label="${reason}"></button></div>${footer ? '<div data-new-thread-footer><button aria-label="Environment"><span data-promptbox-full-label>Target · Project checkout</span></button></div>' : ""}</div>`);
  const doc = dom.window.document;
  const controller = new dom.window.AbortController();
  const dispose = mountSetupShortcut(doc, controller.signal);
  return { dom, doc, controller, dispose };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("shortcut opens setup for the selected machine without submitting the draft", async () => {
  const { dom, doc, controller } = fixture();
  const actions: string[] = [];
  doc.querySelector('[data-promptbox-submit-action]')!.addEventListener("click", () => actions.push("submit"));
  doc.querySelector('[aria-label="Environment"]')!.addEventListener("click", () => {
    actions.push("environment");
    const unrelated = doc.createElement("div");
    unrelated.setAttribute("role", "option"); unrelated.textContent = "Set up on Other…";
    unrelated.addEventListener("click", () => actions.push("wrong-machine"));
    const option = doc.createElement("div");
    option.setAttribute("role", "option"); option.textContent = "Set up on Target…";
    option.addEventListener("click", () => actions.push("setup"));
    doc.body.append(unrelated, option);
  });
  const shortcut = doc.querySelector<HTMLButtonElement>('[data-project-machine-setup]')!;
  assert.equal(shortcut.nextElementSibling, doc.querySelector('[data-promptbox-submit-action]'));
  shortcut.click(); await tick();
  assert.deepEqual(actions, ["environment", "setup"]);
  controller.abort();
  assert.equal(doc.querySelector('[data-project-machine-setup]'), null);
  dom.window.close();
});

test("does not offer project setup for an empty prompt or a thread composer", () => {
  for (const [reason, footer] of [["Enter a prompt or attach a file.", true], ["Select an environment.", false]] as const) {
    const { dom, doc, dispose } = fixture(reason, footer);
    assert.equal(doc.querySelector('[data-project-machine-setup]'), null);
    dispose(); dom.window.close();
  }
});

test("removes shortcut when the environment becomes ready and cancels pending observers", async () => {
  const { dom, doc, controller } = fixture();
  doc.querySelector<HTMLButtonElement>('[data-project-machine-setup]')!.click();
  const submit = doc.querySelector('[data-promptbox-submit-action]')!;
  submit.setAttribute("aria-label", "Enter a prompt or attach a file.");
  await tick();
  assert.equal(doc.querySelector('[data-project-machine-setup]'), null);
  controller.abort();
  let clicked = false;
  const late = doc.createElement("div"); late.setAttribute("role", "option"); late.textContent = "Set up on Target…";
  late.addEventListener("click", () => { clicked = true; }); doc.body.append(late);
  await tick(); assert.equal(clicked, false);
  dom.window.close();
});
