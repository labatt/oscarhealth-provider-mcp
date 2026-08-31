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
});
