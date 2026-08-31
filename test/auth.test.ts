import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../src/auth/store.js';
import { OscarOAuthProvider } from '../src/auth/provider.js';
import { buildMetadataDocuments } from '../src/auth/metadata.js';

let dir: string;
let store: AuthStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'auth-')); store = new AuthStore(join(dir, 'o.db')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('OAuth metadata', () => {
  it('advertises the configured issuer exactly', () => {
    const provider = new OscarOAuthProvider(store, {});
    const docs = buildMetadataDocuments('https://mcp.example.com', provider);
    expect(docs.authorizationServer.issuer).toBe('https://mcp.example.com');
  });

  it('points the protected-resource document at the /mcp endpoint', () => {
    const provider = new OscarOAuthProvider(store, {});
    const docs = buildMetadataDocuments('https://mcp.example.com', provider);
    expect(JSON.stringify(docs.protectedResource)).toContain('/mcp');
  });
});

describe('AuthStore', () => {
  it('purges expired rows without throwing on an empty database', () => {
    expect(() => store.purgeExpired()).not.toThrow();
  });
});

describe('redirect host allowlist', () => {
  const allowed = (provider: OscarOAuthProvider, uri: string): boolean =>
    // redirectHostAllowed is private; exercise it the way /authorize does.
    (provider as unknown as { redirectHostAllowed(u: string): boolean }).redirectHostAllowed(uri);

  it('denies every host when the allowlist is unset — fails closed', () => {
    // Dynamic registration is open, so an unconfigured allowlist previously let
    // an attacker register a client pointing at their own callback and phish a
    // real consent screen on the operator's own domain.
    const p = new OscarOAuthProvider(store, {});
    expect(allowed(p, 'https://claude.ai/cb')).toBe(false);
    expect(allowed(p, 'https://evil.test/cb')).toBe(false);
  });

  it('allows exactly the configured hosts', () => {
    const p = new OscarOAuthProvider(store, { allowedRedirectHosts: ['claude.ai'] });
    expect(allowed(p, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(allowed(p, 'https://evil.test/cb')).toBe(false);
  });

  it('matches the whole hostname, not a suffix', () => {
    const p = new OscarOAuthProvider(store, { allowedRedirectHosts: ['claude.ai'] });
    expect(allowed(p, 'https://claude.ai.evil.test/cb')).toBe(false);
    expect(allowed(p, 'https://notclaude.ai/cb')).toBe(false);
  });

  it('treats * as an explicit opt-out', () => {
    const p = new OscarOAuthProvider(store, { allowedRedirectHosts: ['*'] });
    expect(allowed(p, 'https://anything.test/cb')).toBe(true);
  });

  it('denies a redirect_uri that is not a parseable URL', () => {
    const p = new OscarOAuthProvider(store, { allowedRedirectHosts: ['claude.ai'] });
    expect(allowed(p, 'not a url')).toBe(false);
  });
});

describe('client registration under capacity pressure', () => {
  const mkClient = (id: string, name: string) => ({
    client_id: id, client_name: name, redirect_uris: ['https://example.test/cb'],
    client_id_issued_at: Math.floor(Date.now() / 1000)
  }) as never;

  it("lets the operator still register when the table is full of spam", () => {
    // Refusing at capacity meant anyone reaching /register could fill the table
    // and keep it full, locking the operator out of connecting their own client.
    for (let i = 0; i < 600; i++) store.saveClient(mkClient(`spam-${i}`, 'spam'));
    expect(() => store.saveClient(mkClient('operator-client', 'Claude'))).not.toThrow();
    expect(store.getClient('operator-client')).toBeDefined();
  });

  it('never evicts a client that has completed an authorization', () => {
    store.saveClient(mkClient('real-client', 'Claude'));
    store.markClientAuthorized('real-client');
    for (let i = 0; i < 600; i++) store.saveClient(mkClient(`flood-${i}`, 'flood'));
    expect(store.getClient('real-client')).toBeDefined();
  });
});
