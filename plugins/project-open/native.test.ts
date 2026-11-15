// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { openNativeTerminal, openNativeWorkspace, uniqueButton, waitFor } from './native';

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

it('does not choose between multiple visible native controls', () => {
  document.body.innerHTML = '<button data-panel-new-tab></button><button data-panel-new-tab></button>';
  expect(uniqueButton(document.body, '[data-panel-new-tab]')).toBeNull();
  document.body.firstElementChild!.setAttribute('hidden', '');
  expect(uniqueButton(document.body, '[data-panel-new-tab]')).toBe(document.body.lastElementChild);
});

it('cancels pending UI work when the plugin unmounts', async () => {
  const controller = new AbortController();
  const pending = waitFor(document.body, () => null, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
});

it('uses only the selected pane terminal launcher', async () => {
  document.body.innerHTML = '<section id="other"><button data-panel-new-tab></button></section><section id="selected"><button data-panel-new-tab></button></section>';
  const other = vi.fn(), start = vi.fn();
  document.querySelector('#other button')!.addEventListener('click', other);
  const pane = document.querySelector<HTMLElement>('#selected')!;
  pane.querySelector('button')!.addEventListener('click', () => {
    const button = document.createElement('button');
    button.dataset.panelNewTabItem = ''; button.id = 'file-search-result-start-terminal';
    button.addEventListener('click', start); pane.append(button);
  });
  await openNativeTerminal(pane, new AbortController().signal);
  expect(start).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled();
});

it('selects Finder only in the chooser it just opened', async () => {
  document.body.innerHTML = '<div role="menu"><button>Finder</button></div><main><button aria-label="Choose another app to open workspace"></button></main>';
  const unrelated = vi.fn(), finder = vi.fn();
  document.querySelector('[role=menu] button')!.addEventListener('click', unrelated);
  const main = document.querySelector('main')!;
  main.querySelector('button')!.addEventListener('pointerdown', () => {
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
    const item = document.createElement('button'); item.textContent = 'Finder';
    item.addEventListener('click', finder); menu.append(item); document.body.append(menu);
  });
  await openNativeWorkspace(main, new AbortController().signal);
  expect(finder).toHaveBeenCalledOnce(); expect(unrelated).not.toHaveBeenCalled();
});

it('closes the chooser and reports unsupported remote Finder immediately', async () => {
  document.body.innerHTML = '<main><button aria-label="Choose another app to open workspace"></button></main>';
  document.querySelector('button')!.addEventListener('pointerdown', () => {
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
    menu.textContent = 'VS Code Terminal';
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') menu.remove(); });
    document.body.append(menu);
  });
  await expect(openNativeWorkspace(document.querySelector('main')!, new AbortController().signal)).rejects.toThrow('не предоставляет Finder');
  expect(document.querySelector('[role=menu]')).toBeNull();
});

it('does not time out when the responsive chooser has dialog and menu wrappers', async () => {
  document.body.innerHTML = '<main><button aria-label="Choose another app to open workspace"></button></main>';
  const finder = vi.fn();
  document.querySelector('button')!.addEventListener('pointerdown', () => {
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
    const item = document.createElement('button'); item.textContent = 'Finder';
    item.addEventListener('click', finder); menu.append(item); dialog.append(menu); document.body.append(dialog);
  });
  await openNativeWorkspace(document.querySelector('main')!, new AbortController().signal);
  expect(finder).toHaveBeenCalledOnce();
});

it('recognizes a retained chooser by aria-controls after it is reopened', async () => {
  document.body.innerHTML = '<main><button aria-controls="retained" aria-label="Choose another app to open workspace"></button></main><div role="menu" id="retained" hidden><button>Finder</button></div>';
  const finder = vi.fn();
  document.querySelector('#retained button')!.addEventListener('click', finder);
  document.querySelector('main button')!.addEventListener('pointerdown', () => document.querySelector('#retained')!.removeAttribute('hidden'));
  await openNativeWorkspace(document.querySelector('main')!, new AbortController().signal);
  expect(finder).toHaveBeenCalledOnce();
});
