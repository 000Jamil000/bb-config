import { describe, expect, it } from 'vitest';
import { chatOpenKey, forgePath, projectTarget, withoutOverrides } from './target';

describe('forgePath', () => {
  it('builds the KodaForge deep link', () => {
    expect(forgePath({ kind: 'thread', id: 'thr_1' })).toBe('/plugins/kodaforge/forge/thread/thr_1');
    expect(chatOpenKey({ kind: 'environment', id: 'env_1' })).toBe('kodaforge:side:environment:env_1:open');
  });
});

describe('projectTarget', () => {
  it('opens the workspace of the most recently updated live thread', () => {
    expect(projectTarget('proj', [
      { environmentId: 'env_old', updatedAt: 1 },
      { environmentId: 'env_new', updatedAt: 5 },
      { environmentId: 'env_archived', updatedAt: 9, archivedAt: 9 },
      { environmentId: null, updatedAt: 10 },
    ])).toEqual({ kind: 'environment', id: 'env_new' });
  });
  it('falls back to the project checkout without threads', () => {
    expect(projectTarget('proj', [])).toEqual({ kind: 'project', id: 'proj' });
  });
});

describe('withoutOverrides', () => {
  it('drops the three overridden keys and keeps the rest', () => {
    expect(withoutOverrides('{"smoothScrolling":true,"minimap":false,"stickyScroll":false,"fontSize":15}')).toBe('{"fontSize":15}');
  });
  it('removes the entry when nothing else was stored', () => {
    expect(withoutOverrides('{"smoothScrolling":true,"minimap":false,"stickyScroll":false}')).toBeNull();
    expect(withoutOverrides(null)).toBeNull();
    expect(withoutOverrides('{oops')).toBeNull();
  });
});
