import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { isAbsolute, resolve } from 'node:path';
import { hostContract, rpcContract } from './contract';
export type { rpcContract } from './contract';
export default function plugin(bb: BbPluginApi) {
  // The key keeps its first name: installations with a Mac already have it set.
  const settings = bb.settings.define({ macHostId: { type: 'string', label: 'ID компьютера, на котором открывать файлы (пусто — единственный подключённый Mac, иначе единственный Windows-компьютер)', default: '' } });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.rpc.register(rpcContract, { open: async ({ path, source, action }) => {
    const machines = (await bb.sdk.hosts.list()).filter(h => h.status === 'connected');
    const { macHostId } = await settings.get();
    const candidates = macHostId ? machines.filter(h => h.id === macHostId) : machines;
    const desktops = (await Promise.all(candidates.map(async machine => {
      try { return { machine, platform: (await host.call('info', null, { hostId: machine.id })).platform }; } catch { return null; }
    }))).filter(h => h !== null && ['darwin', 'win32'].includes(h.platform)).map(h => h!);
    const macs = desktops.filter(h => h.platform === 'darwin');
    const target = (macs.length === 1 ? macs[0] : desktops.length === 1 ? desktops[0] : null)?.machine;
    if (!target) throw new Error('Укажите подключённый Mac или Windows-компьютер в настройках плагина.');
    let hostId = source.experimental_hostId;
    let environmentId = source.environmentId;
    if (source.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: source.threadId });
      environmentId ??= thread.environmentId;
    }
    let root: string | null = null;
    if (environmentId) {
      const env = await bb.sdk.environments.get({ environmentId });
      hostId ??= env.hostId; root = env.path;
    }
    if (!hostId) throw new Error('Не удалось определить машину файла.');
    if (source.kind === 'thread-storage') {
      const machine = await bb.sdk.hosts.get({ hostId });
      if (!machine.threadStorageRootPath || !source.threadId) throw new Error('Хранилище треда недоступно.');
      root = resolve(machine.threadStorageRootPath, source.threadId);
    }
    const absolute = isAbsolute(path) ? path : root ? resolve(root, path) : null;
    if (!absolute) throw new Error('Не удалось определить полный путь файла.');
    // Already on the computer that opens it (bb on a single PC): open the file itself.
    if (hostId === target.id && action === 'open') return host.call('launch', { path: absolute }, { hostId });
    const bundle = await host.call('read', { path: absolute }, { hostId });
    return host.call('open', { bundle, action }, { hostId: target.id });
  } });
}
