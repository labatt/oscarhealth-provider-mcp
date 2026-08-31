import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, AuditLog, withAudit, rateLimit } from '../src/audit.js';

describe('redact', () => {
  it('masks a confirmToken', () => {
    expect(redact({ id: 1, confirmToken: 'abc.def' })).toEqual({ id: 1, confirmToken: '[redacted]' });
  });

  it('masks anything that looks like an api key or password', () => {
    expect(redact({ apiKey: 'k_x', password: 'p', authorization: 'Bearer y' }))
      .toEqual({ apiKey: '[redacted]', password: '[redacted]', authorization: '[redacted]' });
  });

  it('recurses into nested objects and arrays', () => {
    expect(redact({ lines: [{ password: 'p', amount: 5 }] }))
      .toEqual({ lines: [{ password: '[redacted]', amount: 5 }] });
  });

  it('leaves ordinary values alone', () => {
    expect(redact({ customer: 'Acme', amount: 100 })).toEqual({ customer: 'Acme', amount: 100 });
  });

  // Coverage for the wider secret vocabulary named in the task brief: tokens,
  // codes, verifiers, passwords, hashes and API keys — not just confirmToken.
  it('masks a password hash field', () => {
    expect(redact({ loginPasswordHash: '$argon2id$...' })).toEqual({ loginPasswordHash: '[redacted]' });
  });

  // Isolates the "hash" alternative specifically: loginPasswordHash above
  // also matches on "password" alone, so that test alone would not catch a
  // regression that dropped "hash" from the pattern.
  it('masks a field that is a hash but names neither password, token nor secret', () => {
    expect(redact({ fileHash: 'deadbeef' })).toEqual({ fileHash: '[redacted]' });
  });

  it('masks a PKCE code verifier and code challenge', () => {
    expect(redact({ codeVerifier: 'v', codeChallenge: 'c' })).toEqual({ codeVerifier: '[redacted]', codeChallenge: '[redacted]' });
  });

  it('masks the bare OAuth "code" field exactly, case-insensitively', () => {
    expect(redact({ code: 'abc123' })).toEqual({ code: '[redacted]' });
    expect(redact({ Code: 'abc123' })).toEqual({ Code: '[redacted]' });
  });

  it('does not redact an ordinary field that merely ends in "Code" — currencyCode is not a secret', () => {
    expect(redact({ currencyCode: 'USD', discountType: 'percentage' }))
      .toEqual({ currencyCode: 'USD', discountType: 'percentage' });
  });

  it('masks an api key spelled with an underscore, e.g. SOME_API_KEY-style field names', () => {
    expect(redact({ api_key: 'k_x', apiKey: 'k_y' })).toEqual({ api_key: '[redacted]', apiKey: '[redacted]' });
  });

  it('masks a client secret and a session secret regardless of prefix', () => {
    expect(redact({ clientSecret: 'x', sessionSecret: 'y', MCP_SESSION_SECRET: 'z' }))
      .toEqual({ clientSecret: '[redacted]', sessionSecret: '[redacted]', MCP_SESSION_SECRET: '[redacted]' });
  });

  it('recurses through multiple levels of nested arrays and objects', () => {
    const input = { a: [{ b: [{ c: { password: 'deep' }, ok: 1 }] }] };
    expect(redact(input)).toEqual({ a: [{ b: [{ c: { password: '[redacted]' }, ok: 1 }] }] });
  });

  it('does not mutate the input object', () => {
    const input = { password: 'p', nested: { apiKey: 'k' } };
    const clone = JSON.parse(JSON.stringify(input));
    redact(input);
    expect(input).toEqual(clone);
  });

  it('passes primitives and null straight through unchanged', () => {
    expect(redact('a string')).toBe('a string');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
});

describe('withAudit', () => {
  it('records a successful call', async () => {
    const log = { record: vi.fn() } as unknown as AuditLog;
    const wrapped = withAudit(log, 'create_invoice', async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    await wrapped({ customer: 'Acme' });
    expect((log.record as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ tool: 'create_invoice', status: 'ok' });
  });

  it('records an error result without swallowing it', async () => {
    const log = { record: vi.fn() } as unknown as AuditLog;
    const wrapped = withAudit(log, 'delete_invoice', async () => ({ content: [{ type: 'text' as const, text: 'nope' }], isError: true }));
    const r = await wrapped({ id: 1 });
    expect(r.isError).toBe(true);
    expect((log.record as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ tool: 'delete_invoice', status: 'error' });
  });

  it('redacts arguments before recording', async () => {
    const log = { record: vi.fn() } as unknown as AuditLog;
    const wrapped = withAudit(log, 'delete_invoice', async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    await wrapped({ id: 1, confirmToken: 'secret' });
    expect((log.record as ReturnType<typeof vi.fn>).mock.calls[0][0].args).toEqual({ id: 1, confirmToken: '[redacted]' });
  });

  it('records a non-negative duration in milliseconds', async () => {
    const log = { record: vi.fn() } as unknown as AuditLog;
    const wrapped = withAudit(log, 'ping', async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    await wrapped({});
    const call = (log.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof call.durationMs).toBe('number');
  });

  it('truncates a long error message to 300 characters rather than writing it unbounded', async () => {
    const log = { record: vi.fn() } as unknown as AuditLog;
    const long = 'x'.repeat(5000);
    const wrapped = withAudit(log, 'delete_invoice', async () => ({ content: [{ type: 'text' as const, text: long }], isError: true }));
    await wrapped({ id: 1 });
    const call = (log.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.message).toHaveLength(300);
  });

  it('omits message on a successful call', async () => {
    const log = { record: vi.fn() } as unknown as AuditLog;
    const wrapped = withAudit(log, 'ping', async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    await wrapped({});
    const call = (log.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.message).toBeUndefined();
  });

  it('returns the handler result unchanged to the caller', async () => {
    const log = { record: vi.fn() } as unknown as AuditLog;
    const payload = { content: [{ type: 'text' as const, text: 'exact payload' }] };
    const wrapped = withAudit(log, 'ping', async () => payload);
    expect(await wrapped({})).toBe(payload);
  });
});

describe('AuditLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscar-mcp-audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the log directory if it does not exist', () => {
    const path = join(dir, 'nested', 'deeper', 'audit.jsonl');
    expect(() => new AuditLog(path)).not.toThrow();
  });

  it('appends one JSON line per record, each carrying an ISO timestamp', () => {
    const path = join(dir, 'audit.jsonl');
    const log = new AuditLog(path);
    log.record({ tool: 'ping', args: { a: 1 }, status: 'ok', durationMs: 5 });
    log.record({ tool: 'list_invoices', args: {}, status: 'ok', durationMs: 3 });

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({ tool: 'ping', status: 'ok', durationMs: 5 });
    expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('never throws when the underlying write fails — logging must not break a tool call', () => {
    // Point the "file" at a path that is actually a directory: appendFileSync
    // throws EISDIR, exercising the real failure path rather than a mock.
    const asDir = join(dir, 'i-am-a-directory');
    mkdirSync(asDir);
    const log = new AuditLog(asDir);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => log.record({ tool: 'ping', args: {}, status: 'ok', durationMs: 0 })).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('rateLimit', () => {
  // `auth` is settable specifically so tests can prove it is IGNORED by
  // default: this endpoint's whole threat model is a pre-auth caller who
  // controls every header, Authorization included.
  function mockReqRes(ip = '10.0.0.1', auth?: string) {
    const req = { headers: auth ? { authorization: auth } : {}, ip } as any;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { status } as any;
    const next = vi.fn();
    return { req, res, next, status, json };
  }

  it('allows requests up to the limit', () => {
    const mw = rateLimit(3, 60_000);
    for (let i = 0; i < 3; i++) {
      const { req, res, next } = mockReqRes('10.0.0.1');
      mw(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('blocks the (limit+1)th request from the same source within the window', () => {
    const mw = rateLimit(2, 60_000);
    const first = mockReqRes('10.0.0.3');
    mw(first.req, first.res, first.next);
    const second = mockReqRes('10.0.0.3');
    mw(second.req, second.res, second.next);
    const third = mockReqRes('10.0.0.3');
    mw(third.req, third.res, third.next);

    expect(third.next).not.toHaveBeenCalled();
    expect(third.status).toHaveBeenCalledWith(429);
  });

  it('keeps a separate budget per source address — one client cannot exhaust another\'s', () => {
    const mw = rateLimit(1, 60_000);
    const a = mockReqRes('10.0.0.10');
    mw(a.req, a.res, a.next);
    const aAgain = mockReqRes('10.0.0.10');
    mw(aAgain.req, aAgain.res, aAgain.next);
    expect(aAgain.next).not.toHaveBeenCalled();

    const b = mockReqRes('10.0.0.11');
    mw(b.req, b.res, b.next);
    expect(b.next).toHaveBeenCalledOnce();
  });

  // The core of the HIGH-severity finding: this endpoint runs pre-auth (on
  // /login) or ahead of token verification (on /mcp), so Authorization is
  // fully attacker-chosen there. Keying on it — even opportunistically, even
  // only "when present" — makes the limiter bypassable by sending a fresh
  // value per request, AND grows `hits` without bound on an attacker-chosen
  // string. This is the exact scenario a security review flagged live.
  it('does NOT key on the Authorization header — varying it across requests must not create new buckets or reset the count', () => {
    const mw = rateLimit(1, 60_000);
    const first = mockReqRes('10.0.0.20', 'Bearer attacker-value-1');
    mw(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledOnce();

    // Same source IP, a brand new Authorization value each time — if the key
    // included the header, each of these would land in its own fresh bucket
    // and none of them would ever be blocked.
    for (let i = 0; i < 5; i++) {
      const attempt = mockReqRes('10.0.0.20', `Bearer attacker-value-${i + 2}`);
      mw(attempt.req, attempt.res, attempt.next);
      expect(attempt.next).not.toHaveBeenCalled();
      expect(attempt.status).toHaveBeenCalledWith(429);
    }
  });

  it('limits requests that carry no Authorization header at all', () => {
    const mw = rateLimit(1, 60_000);
    const first = mockReqRes('10.0.0.21');
    mw(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledOnce();

    const second = mockReqRes('10.0.0.21');
    mw(second.req, second.res, second.next);
    expect(second.next).not.toHaveBeenCalled();
    expect(second.status).toHaveBeenCalledWith(429);
  });

  it('keys by the request IP', () => {
    const mw = rateLimit(1, 60_000);
    const a = mockReqRes('10.0.0.5');
    mw(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalledOnce();

    const aAgain = mockReqRes('10.0.0.5');
    mw(aAgain.req, aAgain.res, aAgain.next);
    expect(aAgain.next).not.toHaveBeenCalled();

    const other = mockReqRes('10.0.0.6');
    mw(other.req, other.res, other.next);
    expect(other.next).toHaveBeenCalledOnce();
  });

  it('resets the count once the window has elapsed', () => {
    vi.useFakeTimers();
    try {
      const mw = rateLimit(1, 1_000);
      const first = mockReqRes('10.0.0.30');
      mw(first.req, first.res, first.next);
      expect(first.next).toHaveBeenCalledOnce();

      const second = mockReqRes('10.0.0.30');
      mw(second.req, second.res, second.next);
      expect(second.next).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_001);

      const third = mockReqRes('10.0.0.30');
      mw(third.req, third.res, third.next);
      expect(third.next).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('two independent rateLimit() instances do not share state', () => {
    const mwA = rateLimit(1, 60_000);
    const mwB = rateLimit(1, 60_000);
    const a = mockReqRes('10.0.0.40');
    mwA(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalledOnce();

    // A fresh middleware instance (as auth/login.ts creates for its own
    // brute-force limiter) must not be affected by mwA's usage of the same key.
    const b = mockReqRes('10.0.0.40');
    mwB(b.req, b.res, b.next);
    expect(b.next).toHaveBeenCalledOnce();
  });

  // Unbounded growth was the other half of the finding: an attacker forcing
  // a fresh key per request (previously possible via Authorization; not
  // possible at all now that the key is IP-based) would otherwise grow
  // `hits` forever. The periodic sweep bounds it regardless of the key
  // source, so this also covers a future custom keyFn misusing an
  // attacker-controlled value.
  it('sweeps expired entries out of hits so the map does not grow without bound', () => {
    vi.useFakeTimers();
    try {
      const mw = rateLimit(1, 1_000);
      for (let i = 0; i < 50; i++) {
        const { req, res, next } = mockReqRes(`10.1.0.${i}`);
        mw(req, res, next);
      }
      expect(mw.hits.size).toBe(50);

      // Two full sweep cycles: the first (at t=1000) lands exactly on
      // entry.resetAt, which the main middleware also treats as still-live
      // (`resetAt < now`, not `<=`) — consistent, not a bug, but it means one
      // cycle only clears entries strictly older than the window, not
      // exactly-at-the-boundary ones. The second cycle (t=2000) is
      // unambiguously past every entry's resetAt=1000.
      vi.advanceTimersByTime(2_001);

      const { req, res, next } = mockReqRes('10.1.0.999');
      mw(req, res, next);
      expect(mw.hits.size).toBe(1); // every stale entry swept; only the fresh one remains
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a custom keyFn — for tests and for a future post-auth, per-verified-token limiter', () => {
    const mw = rateLimit(1, 60_000, () => 'fixed-key');
    const a = mockReqRes('10.0.0.50');
    mw(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalledOnce();

    // Different IP, but the custom keyFn ignores it entirely — same bucket.
    const b = mockReqRes('10.0.0.51');
    mw(b.req, b.res, b.next);
    expect(b.next).not.toHaveBeenCalled();
  });
});
