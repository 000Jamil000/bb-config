import { createHash } from 'node:crypto';
import { open, realpath, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
export const MAX_BYTES = 20 * 1024 * 1024;
const allowed = new Set('pdf html htm md txt csv json png jpg jpeg gif webp svg doc docx xls xlsx ppt pptx odt ods odp rtf mp3 mp4 wav m4a mov zip'.split(' '));
const assetTypes = new Set('css js mjs png jpg jpeg gif webp svg ico woff woff2 ttf otf mp3 mp4 wav m4a json'.split(' '));
export type Bundle = { main: string; entries: { path: string; content: string; sha256: string }[] };
export const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export function safeRelative(path: string) {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.split('/').some(p => p === '..' || p === '.' || p === '') && !path.includes('\0');
}
export function dependencies(text: string): string[] {
  return [...text.matchAll(/(?:src|href|poster)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^\s)'";]+)|@import\s+["']([^"']+)["']/gi)]
    .map(m => m[1] ?? m[2] ?? m[3]!).filter(v => !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(v))
    .map(v => decodeURIComponent(v.split(/[?#]/, 1)[0]!)).filter(Boolean);
}
export async function collectBundle(path: string): Promise<Bundle> {
  if (!isAbsolute(path) || !allowed.has(extname(path).slice(1).toLowerCase())) throw new Error('Этот тип файла пока не поддерживается.');
  path = await realpath(path);
  const root = dirname(path), entries: Bundle['entries'] = [], seen = new Set<string>();
  let total = 0;
  const visit = async (candidate: string) => {
    const actual = await realpath(candidate), rel = relative(root, actual);
    if (!safeRelative(rel)) throw new Error('Ресурс HTML находится за пределами папки презентации.');
    if (seen.has(actual)) return;
    seen.add(actual);
    if (seen.size > 100) throw new Error('Слишком много ресурсов: максимум 100 файлов.');
    const handle = await open(actual, 'r');
    let data: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || total + stat.size > MAX_BYTES) throw new Error('Размер файла или презентации превышает 20 МБ.');
      const buffer = Buffer.alloc(Math.min(MAX_BYTES - total + 1, stat.size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw new Error('Файл изменился во время копирования. Повторите открытие.');
      data = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    total += data.length;
    entries.push({ path: rel, content: data.toString('base64'), sha256: sha(data) });
    if (['.html', '.htm', '.css'].includes(extname(actual).toLowerCase())) {
      for (const ref of dependencies(data.toString('utf8'))) {
        const dep = resolve(dirname(actual), ref);
        if (assetTypes.has(extname(dep).slice(1).toLowerCase())) await visit(dep);
      }
    }
  };
  await visit(path);
  return { main: basename(path), entries };
}
export async function saveBundle(bundle: Bundle, downloadRoot = join(homedir(), 'Downloads', 'BB Files')) {
  if (!safeRelative(bundle.main) || !allowed.has(extname(bundle.main).slice(1).toLowerCase())) throw new Error('Недопустимое имя файла.');
  let total = 0;
  const paths = new Set<string>();
  const decoded = bundle.entries.map(entry => {
    if (!safeRelative(entry.path) || paths.has(entry.path)) throw new Error('Недопустимый путь ресурса.');
    paths.add(entry.path);
    const data = Buffer.from(entry.content, 'base64'); total += data.length;
    if (total > MAX_BYTES || sha(data) !== entry.sha256) throw new Error('Ошибка проверки файла.');
    return { path: entry.path, data };
  });
  if (!paths.has(bundle.main)) throw new Error('Главный файл отсутствует.');
  await mkdir(downloadRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(downloadRoot, 'open-'));
  for (const entry of decoded) {
    const dest = join(directory, entry.path);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, entry.data, { flag: 'wx', mode: 0o600 });
  }
  return join(directory, bundle.main);
}
