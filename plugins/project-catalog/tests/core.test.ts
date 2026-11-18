import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAuto, applyManual, diffManifests, emptyEntry, hydrate, needsDescription, renameCategory, REDESCRIBE_AFTER_MS, search, unlock, verdict, type Scan, type SourceView } from '../core';

const doc = (id: string, name: string, extra: Partial<{ aliases: string[]; category: string; tags: string[]; summary: string; notes: string }> = {}) =>
  ({ id, name, aliases: [], category: '', tags: [], summary: '', notes: '', paths: [], ...extra });

test('a manual edit survives the next automatic description', () => {
  let entry = applyAuto(emptyEntry(), { summary: 'Авто', category: 'Финансы', tags: ['a'] }, 'h1', 1).entry;
  entry = applyManual(entry, { summary: 'Моё описание', notes: 'важное' }, 2);
  assert.deepEqual(entry.locked, ['summary']);
  const result = applyAuto(entry, { summary: 'Новое авто', category: 'Деньги', tags: ['b'] }, 'h2', 3);
  assert.equal(result.entry.summary, 'Моё описание');
  assert.equal(result.entry.notes, 'важное');
  assert.equal(result.entry.category, 'Деньги');
  assert.deepEqual(result.skipped, ['summary']);
  assert.equal(applyAuto(unlock(result.entry, ['summary'], 4), { summary: 'Снова авто' }, 'h2', 5).entry.summary, 'Снова авто');
});

test('saving a field without changing it does not lock it', () => {
  const entry = applyAuto(emptyEntry(), { summary: 'Авто', tags: ['x'] }, null, 1).entry;
  assert.deepEqual(applyManual(entry, { summary: 'Авто', tags: ['x'], notes: 'n' }, 2).locked, []);
});

test('description is requested when missing, or stale after the cool-down only', () => {
  assert.equal(needsDescription(undefined, null, 0), 'missing');
  const entry = applyAuto(emptyEntry(), { summary: 's' }, 'h1', 1000).entry;
  assert.equal(needsDescription(entry, 'h1', 1000 + REDESCRIBE_AFTER_MS * 2), null);
  assert.equal(needsDescription(entry, 'h2', 2000), null);
  assert.equal(needsDescription(entry, 'h2', 1000 + REDESCRIBE_AFTER_MS), 'stale');
  const manual = applyManual(emptyEntry(), { summary: 'сам', category: 'Сам' }, 1);
  assert.equal(needsDescription(manual, 'h', 9e15), null);
});

test('search finds a latin name by its russian pronunciation and by alias, tag, summary', () => {
  const docs = [doc('1', 'Moneybox', { summary: 'копилка целей' }), doc('2', 'marusya', { aliases: ['Маруся'], tags: ['ассистент'] }), doc('3', 'bb-config', { category: 'Инфраструктура' })];
  assert.equal(search(docs, 'манибокс')[0]?.doc.id, '1');
  assert.equal(search(docs, 'маруся')[0]?.doc.id, '2');
  assert.equal(search(docs, 'ассистент')[0]?.doc.id, '2');
  assert.equal(search(docs, 'копилка')[0]?.doc.id, '1');
  assert.equal(search(docs, 'инфраструктура config')[0]?.doc.id, '3');
  assert.equal(search(docs, 'несуществующее').length, 0);
  assert.equal(search(docs, '').length, 3);
});

const git = (over: Partial<NonNullable<Scan['git']>> = {}): Scan => ({ scannedAt: 1, kind: 'git', docHash: null, git: { branch: 'main', head: 'aaa', headTime: 10, dirty: 0, untracked: 0, ahead: 0, behind: 0, hasUpstream: true, remote: 'r', stash: 0, ...over } });
const plain = (digest: string | null, latestMtime = 1): Scan => ({ scannedAt: 1, kind: 'plain', docHash: null, plain: { files: 3, bytes: 9, latestMtime, digest, truncated: false } });
const src = (hostName: string, scan: Scan | null, connected = true): SourceView => ({ id: hostName, hostId: hostName, hostName, path: '/p', connected, scan });

test('a folder without git on one machine is a normal state', () => {
  const result = verdict([src('Tru', plain(null))]);
  assert.equal(result.level, 'ok');
  assert.equal(result.label, 'Без git');
});

test('uncommitted and unpushed work needs attention', () => {
  assert.equal(verdict([src('Mac', git({ dirty: 2, untracked: 1 }))]).level, 'attention');
  assert.equal(verdict([src('Mac', git({ ahead: 3 }))]).level, 'attention');
  assert.equal(verdict([src('Mac', git())]).label, 'В порядке');
});

test('diverged copies are a risk only when work could be lost', () => {
  assert.equal(verdict([src('Mac', git({ head: 'aaa' })), src('Tru', git({ head: 'bbb', headTime: 20 }))]).level, 'attention');
  const lost = verdict([src('Mac', git({ head: 'aaa', dirty: 1 })), src('Tru', git({ head: 'bbb', headTime: 20 }))]);
  assert.equal(lost.level, 'risk');
  assert.match(lost.details.join(' '), /новее на Tru/);
  assert.equal(verdict([src('Mac', git()), src('Tru', git())]).label, 'Синхронизировано');
});

test('copies without git are compared by content', () => {
  assert.equal(verdict([src('Mac', plain('x')), src('Tru', plain('x'))]).label, 'Синхронизировано');
  const apart = verdict([src('Mac', plain('x', 50)), src('Tru', plain('y', 10))], { changed: 2, onlyA: 1, onlyB: 0, sample: [] });
  assert.equal(apart.level, 'risk');
  assert.match(apart.details.join(' '), /3 файла.*последние правки на Mac/);
  assert.equal(verdict([src('Mac', plain(null)), src('Tru', plain('y'))]).level, 'unknown');
  assert.equal(verdict([src('Mac', null, false), src('Tru', plain('y'))]).level, 'unknown');
});

test('manifest diff reports which side is newer', () => {
  const diff = diffManifests({ a: ['1', 5], b: ['2', 5], c: ['3', 1] }, { a: ['1', 9], b: ['9', 7], d: ['4', 1] });
  assert.deepEqual([diff.changed, diff.onlyA, diff.onlyB], [1, 1, 1]);
  assert.deepEqual(diff.sample.find(item => item.path === 'b'), { path: 'b', kind: 'changed', newer: 'b' });
});

test('independent copies are not compared', () => {
  const result = verdict([src('Tru', plain('x')), src('UA', plain('y'))], null, { independent: true });
  assert.equal(result.level, 'ok');
  assert.match(result.details.join(' '), /независимы/);
});

test('folders marked as local are left out of the comparison', () => {
  const a = { 'os/a.md': ['1', 1], 'mine/x.md': ['2', 1] } as const;
  const b = { 'os/a.md': ['1', 1], 'mine/y.md': ['3', 1] } as const;
  const full = diffManifests({ ...a } as never, { ...b } as never);
  assert.equal(full.onlyA + full.onlyB, 2);
  const diff = diffManifests({ ...a } as never, { ...b } as never, 40, ['mine']);
  assert.equal(diff.changed + diff.onlyA + diff.onlyB, 0);
  const result = verdict([src('Mac', plain('x')), src('Tru', plain('y'))], diff, { localPaths: ['mine'] });
  assert.equal(result.level, 'ok');
  assert.equal(result.label, 'Синхронизировано');
});

test('a repository nested in a folder without git is judged by its git state', () => {
  const part = (over = {}) => ({ path: 'os', git: { ...git().git!, ...over } });
  const withParts = (digest: string, parts: ReturnType<typeof part>[]): Scan => ({ ...plain(digest), parts });
  const none = { changed: 0, onlyA: 0, onlyB: 0, sample: [] };
  assert.equal(verdict([src('Mac', withParts('x', [part()])), src('Tru', withParts('x', [part()]))], none).level, 'ok');
  const dirty = verdict([src('Mac', withParts('x', [part({ dirty: 2 })])), src('Tru', withParts('x', [part()]))], none);
  assert.equal(dirty.level, 'attention');
  assert.match(dirty.details.join(' '), /Mac: os — 2 незакоммиченных файла/);
  const apart = verdict([src('Mac', withParts('x', [part({ head: 'bbb', headTime: 99 })])), src('Tru', withParts('x', [part()]))], none);
  assert.equal(apart.level, 'attention');
  assert.match(apart.details.join(' '), /os: разные коммиты.*новее на Mac/);
});

test('a project can sit in several categories; the first is primary', () => {
  const auto = applyAuto(emptyEntry(), { category: 'Продукты, Реклама и AdTech, продукты' }, null, 1).entry;
  assert.deepEqual(auto.categories, ['Продукты', 'Реклама и AdTech']);
  assert.equal(auto.category, 'Продукты');
  assert.deepEqual(applyManual(auto, { category: 'Продукты, Реклама и AdTech' }, 2).locked, []);
  const manual = applyManual(auto, { category: 'Личное' }, 3);
  assert.deepEqual([manual.categories, manual.locked], [['Личное'], ['category']]);
  assert.deepEqual(hydrate({ category: 'Старое' }).categories, ['Старое']);
});

test('renaming a category keeps its position and merges duplicates', () => {
  const entry = applyAuto(emptyEntry(), { category: 'Личное, Ислам' }, null, 1).entry;
  assert.deepEqual(renameCategory(entry, 'Ислам', 'Вера', 2)?.categories, ['Личное', 'Вера']);
  assert.deepEqual(renameCategory(entry, 'Ислам', 'Личное', 2)?.categories, ['Личное']);
  assert.equal(renameCategory(entry, 'Нет такой', 'X', 2), null);
});
