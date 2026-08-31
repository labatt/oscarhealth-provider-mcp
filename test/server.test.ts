import { describe, it, expect, vi } from 'vitest';
import { createHostValidationMiddleware, isMainModule } from '../src/server.js';
import { pathToFileURL } from 'node:url';

function res() {
  const r = { statusCode: 0, body: undefined as unknown };
  return {
    status(c: number) { r.statusCode = c; return this; },
    json(b: unknown) { r.body = b; return this; },
    captured: r
  };
}

describe('createHostValidationMiddleware', () => {
  it('passes a request whose Host is allowlisted', () => {
    const next = vi.fn();
    const mw = createHostValidationMiddleware(['mcp.example.com']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw({ headers: { host: 'mcp.example.com' } } as any, res() as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects an unknown Host with 403 and a JSON-RPC error envelope', () => {
    const next = vi.fn();
    const r = res();
    const mw = createHostValidationMiddleware(['mcp.example.com']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw({ headers: { host: 'evil.example' } } as any, r as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.captured.statusCode).toBe(403);
    expect(r.captured.body).toMatchObject({ jsonrpc: '2.0' });
  });

  it('rejects a request with no Host header at all', () => {
    const next = vi.fn();
    const r = res();
    const mw = createHostValidationMiddleware(['mcp.example.com']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw({ headers: {} } as any, r as any, next);
    expect(r.captured.statusCode).toBe(403);
  });
});

describe('isMainModule', () => {
  const url = pathToFileURL('/srv/mcp.example.com/dist/server.js').href;

  it('matches when argv[1] is the entry point', () => {
    expect(isMainModule(url, '/srv/mcp.example.com/dist/server.js', undefined)).toBe(true);
  });

  it("prefers pm2's pm_exec_path over argv[1]", () => {
    // Under pm2 fork mode argv[1] is pm2's wrapper, not the app. Trusting it
    // means main() never runs: pm2 reports "online" but nothing binds the port.
    expect(isMainModule(url, '/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js',
      '/srv/mcp.example.com/dist/server.js')).toBe(true);
  });

  it('returns false when neither path is the entry point', () => {
    expect(isMainModule(url, '/somewhere/else.js', undefined)).toBe(false);
  });

  it('returns false when there is no entry path at all', () => {
    expect(isMainModule(url, undefined, undefined)).toBe(false);
  });
});
