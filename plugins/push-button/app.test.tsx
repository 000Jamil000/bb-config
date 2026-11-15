// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  send: vi.fn(),
  status: { state: 'ready', message: 'Есть изменения' } as { state: string; message: string; projectName?: string; hostName?: string },
  composer: { scope: { kind: 'thread', threadId: 'selected-thread' }, text: 'Несохранённый черновик', isSubmitting: false, isSubmittingBlocked: false },
}));
vi.mock('@get-bb/plugin-sdk/app', () => ({
  definePluginApp: () => ({}), useComposer: () => state.composer,
  useSdk: () => ({ threads: { send: state.send } }), experimental_Icon: () => null,
  experimental_useRpcQuery: () => ({ data: state.status }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
import { PushButton } from './app';

let root: Root | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; document.body.innerHTML = ''; vi.clearAllMocks();
  state.composer.text = 'Несохранённый черновик'; state.composer.isSubmittingBlocked = false;
  state.status = { state: 'ready', message: 'Есть изменения' };
  vi.unstubAllGlobals();
});

async function mount(withChanges = false, withBranch = true) {
  document.body.innerHTML = `<div data-app-composer>${withChanges ? '<div><button id="thread-prompt-banner-git-toggle">Changes</button></div>' : ''}${withBranch ? '<div><button aria-label="Branch">main</button></div>' : ''}<div id="root"></div></div>`;
  root = createRoot(document.getElementById('root')!);
  await act(async () => root!.render(<PushButton />));
  return document.querySelector<HTMLButtonElement>('[data-push-thread-button]')!;
}

it('sends exactly one request to its own thread without touching the draft', async () => {
  let resolve!: () => void;
  state.send.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  const button = await mount();
  expect(button.parentElement?.previousElementSibling?.getAttribute('aria-label')).toBe('Branch');
  await act(async () => { button.click(); button.click(); });
  expect(state.send).toHaveBeenCalledExactlyOnceWith({
    threadId: 'selected-thread', mode: 'queue-if-active', input: [{ type: 'text', text: 'пуш', mentions: [] }],
  });
  expect(state.composer.text).toBe('Несохранённый черновик');
  await act(async () => resolve());
});

it('removes its footer mount on unmount', async () => {
  await mount();
  await act(async () => root!.unmount()); root = undefined;
  expect(document.querySelector('[data-push-button-mount]')).toBeNull();
  expect(document.querySelector('button[aria-label="Branch"]')?.textContent).toBe('main');
});

it('can send its standalone command while the ordinary composer draft is empty', async () => {
  state.composer.text = ''; state.composer.isSubmittingBlocked = true;
  expect((await mount()).disabled).toBe(false);
});

it.each(['clean', 'unavailable'])('does not send a request when Git is %s', async stateName => {
  state.status = { state: stateName, message: 'Нечего отправлять' };
  const button = await mount();
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.send).not.toHaveBeenCalled();
});

it.each([true, false])('places the action beside changes and preserves focus (touch=%s)', async touch => {
  vi.stubGlobal('matchMedia', () => ({ matches: touch, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const button = await mount(true);
  expect(button.parentElement?.dataset.pushButtonLocation).toBe('changes');
  expect(button.parentElement?.previousElementSibling?.id).toBe('thread-prompt-banner-git-toggle');
  const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  await act(async () => { button.dispatchEvent(down); });
  expect(down.defaultPrevented).toBe(true);
  expect(state.send).not.toHaveBeenCalled();
});

it('keeps the phone push action beside changes when the collapsed composer has no branch footer', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const button = await mount(true, false);
  expect(button).not.toBeNull();
  expect(button.disabled).toBe(false);
  expect(button.parentElement?.dataset.pushButtonLocation).toBe('changes');
  expect(button.parentElement?.previousElementSibling?.id).toBe('thread-prompt-banner-git-toggle');
});

it('preserves the changes action when the composer removes its branch row', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const button = await mount(true);
  await act(async () => {
    document.querySelector('button[aria-label="Branch"]')!.parentElement!.remove();
    await new Promise(resolve => setTimeout(resolve, 60));
  });
  expect(document.querySelector('[data-push-thread-button]')).toBe(button);
  expect(button.isConnected).toBe(true);
  expect(button.parentElement?.dataset.pushButtonLocation).toBe('changes');
});

it('shows the project in the footer, without adding a banner above changes', async () => {
  state.status = { state: 'ready', message: 'Есть изменения', projectName: 'Example project', hostName: 'Example host' };
  await mount(true);
  const project = document.querySelector('[aria-label="Проект: Example project"]')!;
  const branch = document.querySelector('button[aria-label="Branch"]')!;
  expect(project.parentElement?.parentElement).toBe(branch.parentElement);
  expect(project.parentElement?.dataset.proxyContextPart).toBe('project');
  expect(project.parentElement?.style.order).toBe('-1');
  expect(document.querySelector('.push-button-machine')).toBeNull();
  await act(async () => root!.unmount()); root = undefined;
  expect(document.querySelector('[data-push-project-mount]')).toBeNull();
});
