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
