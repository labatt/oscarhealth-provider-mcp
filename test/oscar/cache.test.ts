import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponseCache } from '../../src/oscar/cache.js';

let dir: string;
let cache: ResponseCache;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oscar-')); cache = new ResponseCache(join(dir, 'c.db')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ResponseCache', () => {
  it('returns undefined for a key never written', () => {
    expect(cache.get('k', 1000)).toBeUndefined();
  });

  it('round-trips a stored body', () => {
    cache.set('k', { hello: 'world' });
    expect(cache.get('k', 60_000)?.body).toEqual({ hello: 'world' });
  });

  it('treats an entry older than the TTL as a miss', () => {
    cache.set('k', { a: 1 });
    expect(cache.get('k', 0)).toBeUndefined();
  });

  it('reports when the entry was cached', () => {
    const before = Date.now();
    cache.set('k', { a: 1 });
    const hit = cache.get('k', 60_000);
    expect(hit!.cachedAt).toBeGreaterThanOrEqual(before);
  });

  it('overwrites an existing key rather than erroring', () => {
    cache.set('k', { v: 1 });
    cache.set('k', { v: 2 });
    expect(cache.get('k', 60_000)?.body).toEqual({ v: 2 });
  });

  it('survives reopening the same file', () => {
    cache.set('k', { v: 42 });
    const reopened = new ResponseCache(join(dir, 'c.db'));
    expect(reopened.get('k', 60_000)?.body).toEqual({ v: 42 });
  });

  it('evicts the oldest entries once the row cap is exceeded', () => {
    // Age-based expiry alone does not bound this table: the cache key embeds
    // caller-chosen arguments, so a client can mint unlimited distinct keys,
    // each holding a full upstream response for the full TTL. data/ also holds
    // the OAuth database, so unbounded growth would take auth down with it.
    const bounded = new ResponseCache(join(dir, 'bounded.db'), { maxRows: 5 });
    for (let i = 0; i < 20; i++) bounded.set(`k${i}`, { i });

    const kept = [];
    for (let i = 0; i < 20; i++) if (bounded.get(`k${i}`, 60_000)) kept.push(i);
    expect(kept).toHaveLength(5);
    // The survivors are the most recently written, not an arbitrary five.
    expect(kept).toEqual([15, 16, 17, 18, 19]);
  });

  it('keeps a re-written key alive rather than evicting it as old', () => {
    const bounded = new ResponseCache(join(dir, 'refresh.db'), { maxRows: 3 });
    bounded.set('keep', { v: 1 });
    for (let i = 0; i < 2; i++) bounded.set(`other${i}`, { i });
    bounded.set('keep', { v: 2 });          // refreshes cached_at
    bounded.set('pushes-one-out', { x: 1 });
    expect(bounded.get('keep', 60_000)?.body).toEqual({ v: 2 });
  });
});
