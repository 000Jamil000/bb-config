import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectBundle, saveBundle, sha, MAX_BYTES } from './files.ts';
async function fixture(run) { const root = await mkdtemp(join(tmpdir(), 'bb-open-test-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('HTML and nested CSS assets survive a server-to-Mac copy with Unicode paths', () => fixture(async root => {
  const src = join(root, 'source'); await mkdir(join(src, 'assets'), { recursive: true });
  await writeFile(join(src, 'слайды.html'), '<link href="assets/style.css"><img src="assets/картинка.png"><script src="https://example.invalid/remote.js"></script>');
  await writeFile(join(src, 'assets/style.css'), 'body{background:url("картинка.png")}');
  const image = Buffer.from([0, 255, 17, 180]); await writeFile(join(src, 'assets/картинка.png'), image);
  const bundle = await collectBundle(join(src, 'слайды.html')); assert.equal(bundle.entries.length, 3);
  const path = await saveBundle(bundle, join(root, 'downloads'));
  assert.deepEqual(await readFile(join(dirname(path), 'assets/картинка.png')), image);
  assert.match(await readFile(path, 'utf8'), /assets\/style.css/);
  assert.notEqual(path, await saveBundle(bundle, join(root, 'downloads')));
}));
test('rejects symlink resources escaping the presentation directory', () => fixture(async root => {
  const src = join(root, 'source'); await mkdir(src);
  await writeFile(join(root, 'outside.png'), 'private'); await symlink(join(root, 'outside.png'), join(src, 'image.png'));
  await writeFile(join(src, 'slides.html'), '<img src="image.png">');
  await assert.rejects(collectBundle(join(src, 'slides.html')), /пределами/);
}));
test('rejects altered bytes and traversal before writing', () => fixture(async root => {
  const entry = { path: 'file.pdf', content: Buffer.from('pdf').toString('base64'), sha256: sha(Buffer.from('different')) };
  await assert.rejects(saveBundle({ main: 'file.pdf', entries: [entry] }, root), /проверки/);
  await assert.rejects(saveBundle({ main: '../file.pdf', entries: [] }, root), /имя/);
  await assert.rejects(saveBundle({ main: 'file.pdf', entries: [{ ...entry, path: '../file.pdf' }] }, root), /путь/);
}));
test('rejects oversized files without reading full contents', () => fixture(async root => {
  const file = join(root, 'large.pdf'); await writeFile(file, Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(collectBundle(file), /20 МБ/);
}));
