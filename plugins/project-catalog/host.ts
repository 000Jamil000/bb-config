// Runs on each enrolled machine: reads the state of project folders there.
// Read-only: never fetches, never writes into a project.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract } from './contract';
import type { GitState, Manifest, PlainState, Scan } from './core';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'dist', 'build', '.next', '.nuxt', '.cache', '.turbo', 'target', '.gradle', '.idea', '.vscode', '.playwright-cli', '.playwright-mcp', 'Pods', 'DerivedData', '.DS_Store', '.Trash', 'tmp', 'logs']);
const MAX_FILES = 4000;
const MAX_DEPTH = 10;
const MAX_HASH_BYTES = 2 * 1024 * 1024;
const DOCS = ['README.md', 'README', 'readme.md', 'Readme.md', 'AGENTS.md', 'CLAUDE.md'];

function git(cwd: string, args: string[], signal: AbortSignal) {
  return new Promise<string | null>(resolve => {
    execFile('git', ['-C', cwd, ...args], { timeout: 8000, maxBuffer: 8 * 1024 * 1024, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? null : stdout));
  });
}

async function gitState(path: string, signal: AbortSignal): Promise<GitState | null> {
  if ((await git(path, ['rev-parse', '--is-inside-work-tree'], signal))?.trim() !== 'true') return null;
  const status = await git(path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], signal);
  if (status === null) return null;
  const state: GitState = { branch: null, head: null, headTime: null, dirty: 0, untracked: 0, ahead: 0, behind: 0, hasUpstream: false, remote: null, stash: 0 };
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.oid ')) state.head = line.slice(13) === '(initial)' ? null : line.slice(13);
    else if (line.startsWith('# branch.head ')) state.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) state.hasUpstream = true;
    else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) { state.ahead = Number(match[1]); state.behind = Number(match[2]); }
    } else if (line.startsWith('? ')) state.untracked++;
    else if (/^[12u] /.test(line)) state.dirty++;
  }
  if (state.head) {
    const time = Number((await git(path, ['log', '-1', '--format=%ct'], signal))?.trim());
    state.headTime = Number.isFinite(time) && time > 0 ? time * 1000 : null;
  }
  const remote = (await git(path, ['config', '--get', 'remote.origin.url'], signal))?.trim();
  // Never keep credentials embedded in a remote URL.
  state.remote = remote ? remote.replace(/^(https?:\/\/)[^/@]+@/i, '$1') : null;
  const stash = await git(path, ['stash', 'list'], signal);
  state.stash = stash ? stash.split('\n').filter(Boolean).length : 0;
  return state;
}

type HashCache = Record<string, [size: number, mtime: number, hash: string]>;

async function plainState(root: string, withManifest: boolean, cache: HashCache, signal: AbortSignal): Promise<{ state: PlainState; manifest: Manifest | null; nested: string[] }> {
  // Sub-folders that are git repositories of their own are reported by git state, not by file hashes.
  const nested: string[] = [];
  const state: PlainState = { files: 0, bytes: 0, latestMtime: null, digest: null, truncated: false };
  const manifest: Manifest = {};
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (signal.aborted || state.truncated) return;
    let names: import('node:fs').Dirent[];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const item of names) {
      if (SKIP.has(item.name) || item.name.startsWith('._') || item.isSymbolicLink()) continue;
      const full = join(dir, item.name);
      const path = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (depth < 3 && nested.length < 20) { try { await stat(join(full, '.git')); nested.push(path); continue; } catch { /* not a repository */ } }
        if (depth < MAX_DEPTH) await walk(full, path, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      if (state.files >= MAX_FILES) { state.truncated = true; return; }
      let info: import('node:fs').Stats;
      try { info = await stat(full); } catch { continue; }
      state.files++;
      state.bytes += info.size;
      const mtime = Math.floor(info.mtimeMs);
      if (state.latestMtime === null || mtime > state.latestMtime) state.latestMtime = mtime;
      if (!withManifest) continue;
      const cached = cache[full];
      let hash: string;
      if (cached && cached[0] === info.size && cached[1] === mtime) hash = cached[2];
      else if (info.size > MAX_HASH_BYTES) hash = `size:${info.size}`;
      else {
        try { hash = createHash('sha1').update(await readFile(full)).digest('hex'); } catch { hash = 'unreadable'; }
      }
      cache[full] = [info.size, mtime, hash];
      manifest[path] = [hash, mtime];
    }
  };
  await walk(root, '', 0);
  if (withManifest) {
    const digest = createHash('sha256');
    for (const path of Object.keys(manifest).sort()) digest.update(`${path}\0${manifest[path]![0]}\n`);
    state.digest = digest.digest('hex');
  }
  return { state, manifest: withManifest ? manifest : null, nested };
}

async function docHash(root: string) {
  const hash = createHash('sha1');
  let found = false;
  for (const name of DOCS) {
    try {
      const text = await readFile(join(root, name));
      hash.update(name).update(text.subarray(0, 200_000));
      found = true;
    } catch { /* absent */ }
  }
  return found ? hash.digest('hex') : null;
}

async function scanOne(path: string, withManifest: boolean, cache: HashCache, signal: AbortSignal): Promise<{ scan: Scan; manifest: Manifest | null }> {
  const scannedAt = Date.now();
  try {
    try { if (!(await stat(path)).isDirectory()) return { scan: { scannedAt, kind: 'missing', docHash: null }, manifest: null }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scan: { scannedAt, kind: 'missing', docHash: null }, manifest: null };
      throw error;
    }
    const doc = await docHash(path);
    const state = await gitState(path, signal);
    if (state) return { scan: { scannedAt, kind: 'git', git: state, docHash: doc }, manifest: null };
    const plain = await plainState(path, withManifest, cache, signal);
    const parts: { path: string; git: GitState }[] = [];
    for (const rel of plain.nested) { const part = await gitState(join(path, rel), signal); if (part) parts.push({ path: rel, git: part }); }
    return { scan: { scannedAt, kind: 'plain', plain: plain.state, docHash: doc, ...(parts.length ? { parts } : {}) }, manifest: plain.manifest };
  } catch (error) {
    return { scan: { scannedAt, kind: 'error', error: String((error as Error).message).slice(0, 200), docHash: null }, manifest: null };
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    scan: async ({ targets }, ctx) => {
      const cacheFile = join(ctx.experimental_paths.dataDir, 'hashes.json');
      let cache: HashCache = {};
      const wantsHashes = targets.some(target => target.manifest);
      if (wantsHashes) { try { cache = JSON.parse(await readFile(cacheFile, 'utf8')) as HashCache; } catch { cache = {}; } }
      const results: { id: string; scan: Scan; manifest: Manifest | null }[] = [];
      let next = 0;
      const worker = async () => {
        while (next < targets.length && !ctx.signal.aborted) {
          const target = targets[next++]!;
          const local: HashCache = target.manifest ? cache : {};
          const result = await scanOne(target.path, target.manifest, local, ctx.signal);
          results.push({ id: target.id, ...result });
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      if (wantsHashes) {
        try { await mkdir(ctx.experimental_paths.dataDir, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cache)); } catch { /* cache is optional */ }
      }
      return { results };
    },
  },
});
