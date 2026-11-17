import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { extname, isAbsolute } from 'node:path';
import { hostContract } from './contract';
import { collectBundle, saveBundle, supported } from './files';
const run = promisify(execFile);
/** Opens the file in an application on this computer and names that application. */
async function launch(path: string): Promise<string> {
  const html = ['.html', '.htm'].includes(extname(path).toLowerCase());
  if (process.platform === 'darwin') {
    await run('/usr/bin/open', html ? ['-a', 'Google Chrome', path] : [path], { timeout: 15000 });
    return html ? 'Google Chrome' : 'приложение по умолчанию';
  }
  if (process.platform === 'win32') {
    // The shell's "open" action for the file type, with no command line for cmd.exe to interpret.
    await run('rundll32.exe', ['url.dll,FileProtocolHandler', path], { timeout: 15000, windowsHide: true });
    return html ? 'браузер по умолчанию' : 'приложение по умолчанию';
  }
  throw new Error('Для открытия нужна подключённая машина с macOS или Windows.');
}
export default experimental_defineHostEntry({ contract: hostContract, handlers: {
  info: async () => ({ platform: process.platform }),
  read: ({ path }) => collectBundle(path),
  open: async ({ bundle, action }) => {
    if (action === 'open' && !['darwin', 'win32'].includes(process.platform)) throw new Error('Для открытия нужна подключённая машина с macOS или Windows.');
    const path = await saveBundle(bundle);
    if (action === 'save') return { path, application: 'Загрузки' };
    return { path, application: await launch(path) };
  },
  // The file already is on the computer that opens it: no copy is made.
  launch: async ({ path }) => {
    if (!isAbsolute(path) || !supported(path)) throw new Error('Этот тип файла пока не поддерживается.');
    path = await realpath(path);
    return { path, application: await launch(path) };
  },
} });