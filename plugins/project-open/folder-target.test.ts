import { expect, it } from 'vitest';
import { finderFolderUrl } from './folder-target';

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
