import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectAliases } from '../lib/project-aliases.ts';
const t = (id, projectId, parentThreadId = null) => ({id, projectId, parentThreadId});
const ids = ts => ts.map(t => t.id);
test('foreign child appears in own project with unchanged identity and descendants', () => {
  const threads = [t('root', 'a'), t('child', 'b', 'root'), t('leaf', 'b', 'child')];
  const before = JSON.stringify(threads);
  const aliases = projectAliases(threads, 'b', []);
  assert.deepEqual(ids(aliases), ['child', 'leaf']);
  assert.equal(aliases[0], threads[1]);
  assert.equal(JSON.stringify(threads), before);
  assert.deepEqual(projectAliases(threads, 'a', threads), []);
});
test('same-project child, existing rows, or absent parent are not duplicated', () => {
  const threads = [t('root', 'a'), t('child', 'a', 'root'), t('orphan', 'b', 'missing')];
  assert.deepEqual(projectAliases(threads, 'a', []), []);
  assert.deepEqual(projectAliases(threads, 'b', []), []);
  const foreign = t('other', 'b', 'root');
  assert.deepEqual(projectAliases([...threads, foreign], 'b', [foreign]), []);
});
test('nested foreign projects retain subtrees without a synthetic ID or parent', () => {
  const threads = [t('root', 'a'), t('b', 'b', 'root'), t('c', 'c', 'b')];
  assert.deepEqual(ids(projectAliases(threads, 'b', [])), ['b', 'c']);
  assert.deepEqual(ids(projectAliases(threads, 'c', [])), ['c']);
});
test('hidden and archived rows do not leak into project aliases', () => {
  const threads = [t('root', 'a'), {...t('hidden', 'b', 'root'), isHidden:true},
    {...t('old', 'b', 'root'), isArchived:true}];
  assert.deepEqual(projectAliases(threads, 'b', []), []);
});
test('pinned threads also appear in their own project, with their subtree', () => {
  const threads = [{...t('pin', 'a'), pinnedAt:1}, t('kid', 'a', 'pin'),
    t('plain', 'a'), {...t('flag', 'b'), isPinned:true}, t('far', 'b', 'pin')];
  assert.deepEqual(ids(projectAliases(threads, 'a', [threads[2]])), ['pin', 'kid', 'far']);
  assert.deepEqual(ids(projectAliases(threads, 'b', [])), ['flag', 'far']);
  assert.deepEqual(projectAliases(threads, 'a', threads), []);
});
test('malformed cycles terminate', () => {
  const threads = [t('a', 'a', 'b'), t('b', 'b', 'a')];
  assert.ok(projectAliases(threads, 'b', []).length <= threads.length);
});
