import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { experimental_defineHostEntry, experimental_runVcsProcess } from '@get-bb/plugin-sdk/host';
import { hostContract } from './contract';
import { parseGitState } from './git-state';

const exec = promisify(execFile);
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async status({ path }, { signal }) {
      if (!isAbsolute(path)) throw new Error('Expected an absolute workspace path');
      const args = ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--ahead-behind', '--untracked-files=normal'];
      const { stdout } = await experimental_runVcsProcess('git', args, () => exec('git', args, {
        cwd: path, signal, timeout: 5000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }), { signal });
      return parseGitState(stdout);
    },
  },
});
