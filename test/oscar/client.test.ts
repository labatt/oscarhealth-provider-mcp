import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponseCache } from '../../src/oscar/cache.js';
import { OscarClient, OscarUpstreamError, USER_AGENT } from '../../src/oscar/client.js';

let dir: string;
let cache: ResponseCache;
let client: OscarClient;

function mockFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' }
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscar-'));
  cache = new ResponseCache(join(dir, 'c.db'));
  client = new OscarClient('https://example.test', cache, { minIntervalMs: 0 });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe('OscarClient', () => {
  it('fetches and returns the parsed body with cachedAt null on a miss', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { ok: 1 }));
    const r = await client.get('/x', { a: 1 }, { ttlMs: 60_000 });
    expect(r.body).toEqual({ ok: 1 });
    expect(r.cachedAt).toBeNull();
  });

  it('serves the second identical call from cache without a second fetch', async () => {
    const f = mockFetch(200, { ok: 1 });
    vi.stubGlobal('fetch', f);
    await client.get('/x', { a: 1 }, { ttlMs: 60_000 });
    const second = await client.get('/x', { a: 1 }, { ttlMs: 60_000 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(second.cachedAt).toBeTypeOf('number');
  });

  it('treats different params as different cache keys', async () => {
    const f = mockFetch(200, { ok: 1 });
    vi.stubGlobal('fetch', f);
    await client.get('/x', { a: 1 }, { ttlMs: 60_000 });
    await client.get('/x', { a: 2 }, { ttlMs: 60_000 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache when refresh is set', async () => {
    const f = mockFetch(200, { ok: 1 });
    vi.stubGlobal('fetch', f);
    await client.get('/x', {}, { ttlMs: 60_000 });
    await client.get('/x', {}, { ttlMs: 60_000, refresh: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('never caches when ttlMs is zero', async () => {
    const f = mockFetch(200, { ok: 1 });
    vi.stubGlobal('fetch', f);
    await client.get('/x', {}, { ttlMs: 0 });
    await client.get('/x', {}, { ttlMs: 0 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('omits undefined params from the query string', async () => {
    const f = mockFetch(200, {});
    vi.stubGlobal('fetch', f);
    await client.get('/x', { a: 1, b: undefined }, { ttlMs: 0 });
    expect(String(f.mock.calls[0][0])).toBe('https://example.test/x?a=1');
  });

  it('sends the honest User-Agent', async () => {
    const f = mockFetch(200, {});
    vi.stubGlobal('fetch', f);
    await client.get('/x', {}, { ttlMs: 0 });
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
  });

  it('throws OscarUpstreamError carrying the status on a non-2xx', async () => {
    vi.stubGlobal('fetch', mockFetch(503, { error: 'nope' }));
    await expect(client.get('/x', {}, { ttlMs: 0 })).rejects.toThrow(OscarUpstreamError);
  });

  it('does not cache an error response', async () => {
    const f = mockFetch(500, {});
    vi.stubGlobal('fetch', f);
    await client.get('/x', {}, { ttlMs: 60_000 }).catch(() => {});
    await client.get('/x', {}, { ttlMs: 60_000 }).catch(() => {});
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates identical concurrent requests into one fetch', async () => {
    const f = mockFetch(200, { ok: 1 });
    vi.stubGlobal('fetch', f);
    await Promise.all([
      client.get('/x', {}, { ttlMs: 60_000 }),
      client.get('/x', {}, { ttlMs: 60_000 })
    ]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('does not let a refresh call join an in-flight request', async () => {
    // A refresh caller asking to bypass the cache must not inherit the result
    // of a request that was already in flight before the refresh was asked for.
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      await new Promise(r => setTimeout(r, 20));
      return new Response(JSON.stringify({ n }), { status: 200 });
    }));
    await Promise.all([
      client.get('/x', {}, { ttlMs: 60_000 }),
      client.get('/x', {}, { ttlMs: 60_000, refresh: true })
    ]);
    expect(n).toBe(2);
  });

  it('spaces concurrent requests, not just sequential ones', async () => {
    const throttled = new OscarClient('https://example.test', cache, { minIntervalMs: 60 });
    const at: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      at.push(Date.now());
      return new Response('{}', { status: 200 });
    }));
    // Distinct keys so in-flight de-duplication does not apply: this is purely
    // a question of whether the throttle serialises parallel callers.
    await Promise.all([1, 2, 3, 4].map(i => throttled.get('/x', { p: i }, { ttlMs: 0 })));
    expect(Math.max(...at) - Math.min(...at)).toBeGreaterThanOrEqual(150);
  });

  it('flattens a structured user_message instead of emitting [object Object]', async () => {
    // Oscar returns validation errors keyed by field. Interpolating the object
    // discards the only part that says what was wrong, so the model cannot
    // correct its own call.
    vi.stubGlobal('fetch', mockFetch(400, {
      error: 'VALIDATION_FAILED',
      user_message: { sort: ['Not a valid choice.'] }
    }));
    await expect(client.get('/x', {}, { ttlMs: 0 })).rejects.toThrow(/sort: Not a valid choice/);
    await expect(client.get('/x', {}, { ttlMs: 0 })).rejects.not.toThrow(/\[object Object\]/);
  });

  it('still uses a plain-string user_message when given one', async () => {
    vi.stubGlobal('fetch', mockFetch(400, { user_message: 'Extra fields supplied.' }));
    await expect(client.get('/x', {}, { ttlMs: 0 })).rejects.toThrow(/Extra fields supplied/);
  });

  it('falls back to the error code when there is no user_message', async () => {
    vi.stubGlobal('fetch', mockFetch(500, { error: 'INTERNAL' }));
    await expect(client.get('/x', {}, { ttlMs: 0 })).rejects.toThrow(/INTERNAL/);
  });
});
