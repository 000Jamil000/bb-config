import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { contract, hostContract } from './contract';

export default function pushButton(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.rpc.register(contract, {
    async status({ threadId }, context) {
      const signal = context.experimental_signal;
      let hostName: string | undefined;
      let projectName: string | undefined;
      try {
        const thread = await bb.sdk.threads.get({ threadId, signal });
        try {
          const project = await bb.sdk.projects.get({ projectId: thread.projectId, signal });
          projectName = project.name;
        } catch { /* Project metadata must not block Git status. */ }
        if (!thread.environmentId) return { state: 'unavailable' as const, message: 'У треда нет рабочей папки', projectName };
        const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal });
        const machine = await bb.sdk.hosts.get({ hostId: environment.hostId, signal });
        hostName = machine.name;
        if (!environment.path || machine.status !== 'connected') return { state: 'unavailable' as const, message: 'Машина или папка недоступна', hostName, projectName };
        return { ...await host.call('status', { path: environment.path }, { hostId: environment.hostId, signal, timeoutMs: 8000 }), hostName, projectName };
      } catch {
        return { state: 'unavailable' as const, message: 'Не удалось проверить Git в папке треда', hostName, projectName };
      }
    },
  });
  bb.rpc.experimental_whileWatched('status', (read, signal) => {
    if (!('input' in read) || !read.input || typeof read.input !== 'object' || Array.isArray(read.input)) return;
    const threadId = read.input.threadId;
    if (typeof threadId !== 'string') return;
    return new Promise<void>(resolve => {
      const timer = setInterval(() => bb.rpc.experimental_invalidate(['push-state:' + threadId]), 5000);
      const stop = () => { clearInterval(timer); resolve(); };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
  });
}
