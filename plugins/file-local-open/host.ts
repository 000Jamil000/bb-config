import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname } from 'node:path';
import { hostContract } from './contract';
import { collectBundle, saveBundle, saveToDownloads } from './files';
export default experimental_defineHostEntry({ contract: hostContract, handlers: {
  info: async () => ({ platform: process.platform }),
  read: ({ path }) => collectBundle(path),
  open: async ({ bundle, action }) => {
    if (process.platform !== 'darwin') throw new Error('Для открытия нужна подключённая машина Mac.');
    if (action === 'save') {
      const saved = await saveToDownloads(bundle);
      await promisify(execFile)('/usr/bin/open', ['-R', saved], { timeout: 15000 }).catch(() => undefined);
      return { path: saved, application: 'Загрузки' };
    }
    const path = await saveBundle(bundle);
    const html = ['.html', '.htm'].includes(extname(path).toLowerCase());
    await promisify(execFile)('/usr/bin/open', html ? ['-a', 'Google Chrome', path] : [path], { timeout: 15000 });
    return { path, application: html ? 'Google Chrome' : 'приложение по умолчанию' };
  },
} });
