import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { isAbsolute, resolve } from 'node:path';
import { hostContract, rpcContract } from './contract';
export type { rpcContract } from './contract';
export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({ macHostId: { type: 'string', label: 'ID машины Mac (пусто — единственный подключённый Mac)', default: '' } });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.rpc.register(rpcContract, { open: async ({ path, source, action }) => {
    const machines = (await bb.sdk.hosts.list()).filter(h => h.status === 'connected');
    const { macHostId } = await settings.get();
    const candidates = macHostId ? machines.filter(h => h.id === macHostId) : machines;
    const macs = (await Promise.all(candidates.map(async machine => {
      try { return (await host.call('info', null, { hostId: machine.id })).platform === 'darwin' ? machine : null; } catch { return null; }
    }))).filter(h => h !== null);
    if (macs.length !== 1) throw new Error('Укажите подключённый Mac в настройках Open on Mac.');
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
    const bundle = await host.call('read', { path: absolute }, { hostId });
    return host.call('open', { bundle, action }, { hostId: macs[0]!.id });
  } });
}
