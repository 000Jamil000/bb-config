import { expect, it } from 'vitest';
import { finderFolderUrl, folderClientMode } from './folder-target';

it('preserves the exact host and path without including SSH configuration', () => {
  const url = new URL(finderFolderUrl('server-1', '/srv/Проект #1', 'test-1'));
  expect(url.protocol).toBe('bb-project-folder:');
  expect(Object.fromEntries(url.searchParams)).toEqual({host:'server-1', path:'/srv/Проект #1', request:'test-1'});
  expect(url.username).toBe(''); expect(url.password).toBe('');
});
it.each(['relative', '/srv/../secret', '/srv/with\nnewline'])('rejects ambiguous path %s', path => {
  expect(() => finderFolderUrl('server', path, 'test')).toThrow();
});
it.each(['-bad host', 'host/path', ''])('rejects invalid host %s', host => {
  expect(() => finderFolderUrl(host, '/srv/project', 'test')).toThrow();
});

it.each([
  [{ userAgent: 'iPhone OS 18 like Mac OS X', platform: 'iPhone', maxTouchPoints: 5, compactTouch: true }, 'files'],
  [{ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5, compactTouch: false }, 'files'],
  [{ userAgent: 'Android', platform: 'Linux', maxTouchPoints: 1, compactTouch: false }, 'files'],
  [{ userAgent: 'Linux', platform: 'Linux', maxTouchPoints: 1, compactTouch: true }, 'files'],
  [{ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0, compactTouch: false }, 'finder'],
  [{ userAgent: 'Windows NT', platform: 'Win32', maxTouchPoints: 0, compactTouch: false }, 'native'],
] as const)('chooses an opener supported on this client', (client, expected) => {
  expect(folderClientMode(client, true)).toBe(expected);
});
