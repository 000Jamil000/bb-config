import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automaticProjectSectionOrder, projectsByLatestThread } from '../lib/project-order.ts';
const projects = [{ id: 'a' }, { id: 'b' }, { id: 'empty' }];
const ids = result => result.map(project => project.id);

test('a new message moves its project first without mutating the source order', () => {
  const threads = [{ projectId: 'a', updatedAt: 10 }, { projectId: 'b', updatedAt: 20 }];
  assert.deepEqual(ids(projectsByLatestThread(projects, threads)), ['b', 'a', 'empty']);
  assert.deepEqual(ids(projectsByLatestThread(projects, [threads[1], { ...threads[0], updatedAt: 30 }])), ['a', 'b', 'empty']);
  assert.deepEqual(ids(projects), ['a', 'b', 'empty']);
});

test('nested machine/day groups rank only their own visible threads', () => {
  const threads = [
    { projectId: 'a', updatedAt: 100, machine: 'one', day: 1 },
    { projectId: 'a', updatedAt: 10, machine: 'two', day: 2 },
    { projectId: 'b', updatedAt: 20, machine: 'two', day: 2 },
  ];
  assert.deepEqual(ids(projectsByLatestThread(projects, threads)), ['a', 'b', 'empty']);
  assert.deepEqual(ids(projectsByLatestThread(projects, threads.filter(t => t.machine === 'two'))), ['b', 'a', 'empty']);
  assert.deepEqual(ids(projectsByLatestThread(projects, threads.filter(t => t.day === 2))), ['b', 'a', 'empty']);
});

test('archived and hidden activity does not raise a project; stable ties and creation fallback', () => {
  const threads = [{ projectId: 'a', createdAt: 5 }, { projectId: 'b', updatedAt: 5 },
    { projectId: 'b', updatedAt: 100, isArchived: true },
    { projectId: 'empty', updatedAt: 200, isHidden: true }];
  assert.deepEqual(ids(projectsByLatestThread(projects, threads)), ['a', 'b', 'empty']);
});

test('manual project slots cannot override freshness; other group slots stay put', () => {
  const stored = ['pinned', 'project:b', 'project:a', 'threads'];
  assert.deepEqual(automaticProjectSectionOrder(stored), ['pinned', 'projects', 'threads']);
  assert.deepEqual(stored, ['pinned', 'project:b', 'project:a', 'threads']);
  assert.deepEqual(automaticProjectSectionOrder(['threads', 'projects', 'project:a', 'pinned']), ['threads', 'projects', 'pinned']);
  assert.deepEqual(automaticProjectSectionOrder(['pinned', 'machines', 'threads']), ['pinned', 'machines', 'threads']);
});
