import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { parseGitState } from './git-state';

it('tracks dirty files, first publication, ahead commits and pushed branches against a non-origin upstream', async () => {
  const base = await mkdtemp(join(tmpdir(), 'push-button-'));
  const repo = join(base, 'repo');
  const remote = join(base, 'remote.git');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const status = () => parseGitState(git('status', '--porcelain=v2', '--branch', '--ahead-behind'));
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-am', 'test');
  try {
    execFileSync('git', ['init', '--initial-branch=feature', repo], { stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    expect(status().state).toBe('clean');
    await writeFile(join(repo, 'file'), 'one\n');
    expect(status().state).toBe('ready');
    git('add', 'file'); commit();
    expect(status().state).toBe('ready'); // No upstream: first publication.
    git('remote', 'add', 'publish', remote);
    git('push', '-u', 'publish', 'HEAD:published-branch');
    expect(status().state).toBe('clean'); // Published feature branch, not main.
    await writeFile(join(repo, 'file'), 'two\n'); commit();
    expect(status().state).toBe('ready'); // Clean tree, one unpushed commit.
    git('push', 'publish', 'HEAD:published-branch');
    expect(status().state).toBe('clean');
  } finally { await rm(base, { recursive: true, force: true }); }
});

it('does not offer push for a behind-only or detached clean checkout', () => {
  expect(parseGitState('# branch.oid abc\n# branch.head main\n# branch.ab +0 -3\n').state).toBe('clean');
  expect(parseGitState('# branch.oid abc\n# branch.head (detached)\n').state).toBe('clean');
});
