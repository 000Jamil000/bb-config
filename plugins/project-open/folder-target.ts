/** Native app link to this client's small Finder handler. No SSH data in URLs. */
export function finderFolderUrl(hostId: string, path: string, request: string = crypto.randomUUID()): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(hostId) || !/^[A-Za-z0-9-]{1,80}$/.test(request)) throw new Error('Некорректный идентификатор папки.');
  if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(segment => segment === '..')) {
    throw new Error('Для Finder требуется абсолютный путь папки.');
  }
  const url = new URL('bb-project-folder://open');
  url.search = new URLSearchParams({ host: hostId, path, request }).toString();
  return url.href;
}
