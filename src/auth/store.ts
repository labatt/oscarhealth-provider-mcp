import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * A dynamically registered client, exactly as the SDK models it. Aliasing the
 * SDK type rather than redeclaring a structural lookalike is what lets the
 * provider hand rows straight to `OAuthRegisteredClientsStore` with no casts.
 */
export type StoredClient = OAuthClientInformationFull;

export interface Pending {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource?: string;
  /** Failed login attempts already spent on this request. See MAX_LOGIN_ATTEMPTS. */
  attempts?: number;
}

export interface Code extends Pending {
  code: string;
  expiresAt: number;
}

export interface Token {
  token: string;
  kind: 'access' | 'refresh';
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

const PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * Bound on how many dynamically-registered client records this store will
 * hold at once. `/register` is unauthenticated by necessity — that is how
 * ChatGPT (and any other client) discovers and registers itself — so nothing
 * stops a flood of registrations that never go on to authorize. Combined with
 * `UNAUTHORIZED_CLIENT_TTL_MS` below, growth is bounded: a flood can push the
 * table up to this many rows, never further, and the never-authorized rows
 * driving the flood are pruned again the moment they go stale.
 */
const MAX_CLIENTS = 500;

/**
 * How long an unauthorized registration is kept before it counts as
 * abandoned and is pruned. A real client (ChatGPT included) registers and
 * then immediately starts the authorization flow — seconds apart, not hours
 * — so an hour is generous headroom for a slow operator to actually click
 * through consent, while still bounding how long a spam registration can
 * occupy a row.
 */
const UNAUTHORIZED_CLIENT_TTL_MS = 60 * 60 * 1000;

/**
 * SQLite-backed persistence for the OAuth authorization server.
 *
 * Everything here is deliberately synchronous: better-sqlite3 serialises
 * statements on the calling thread, which is what makes `takeCode` /
 * `takePending` genuinely single-use — a SELECT followed by a DELETE cannot be
 * interleaved with another request's SELECT the way it could with an async
 * driver. Two concurrent redemptions of the same code therefore cannot both
 * observe the row.
 */
export class AuthStore {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, json TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, json TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
    this.migrateClientsTable();
    if (path !== ':memory:') this.securePermissions(path);
  }

  /**
   * Adds `created_at` / `authorized_at` to `clients` on top of a table that
   * may already exist (and already hold live rows, including a real
   * already-authorized ChatGPT registration) from before this task. Plain
   * `CREATE TABLE IF NOT EXISTS` does not add columns to an existing table,
   * so this runs as an idempotent migration instead, guarded by checking
   * `PRAGMA table_info` rather than by catching a duplicate-column error.
   *
   * Backfill matters as much as the schema change: a pre-existing client row
   * has no history of *when* it registered or *whether* it ever completed
   * authorization, so a naive backfill of `authorized_at = NULL` would make
   * `pruneStaleClients` treat an already-working, already-authorized client
   * as abandoned and delete it out from under a live integration the moment
   * this migration runs. Any client id that already holds a token (access or
   * refresh) has unambiguously completed authorization at least once, so
   * those are backfilled as authorized "now" — never pruned.
   */
  private migrateClientsTable(): void {
    const cols = this.db.prepare('PRAGMA table_info(clients)').all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    const now = Date.now();

    if (!names.has('created_at')) {
      this.db.exec(`ALTER TABLE clients ADD COLUMN created_at INTEGER NOT NULL DEFAULT ${now}`);
    }
    if (!names.has('authorized_at')) {
      this.db.exec('ALTER TABLE clients ADD COLUMN authorized_at INTEGER');
      const rows = this.db.prepare('SELECT json FROM tokens').all() as Array<{ json: string }>;
      const liveClientIds = new Set(rows.map(r => (JSON.parse(r.json) as Token).clientId));
      const mark = this.db.prepare('UPDATE clients SET authorized_at = ? WHERE client_id = ?');
      const markAll = this.db.transaction((ids: string[]) => { for (const id of ids) mark.run(now, id); });
      markAll([...liveClientIds]);
    }
  }

  /**
   * Tokens (access and refresh) live in this file, so it is kept at 0600 —
   * unreadable to any other local user — on every start, regardless of the
   * umask the file happened to be created under and regardless of whether it
   * already existed with a looser mode from before this task. Self-healing
   * on every start is deliberate: `data/` being 700 is currently the only
   * thing standing between this file and the rest of the box, and a mode
   * fixed once at first-create would not survive that directory's
   * permissions ever loosening. WAL mode's sidecar files (`-wal`, `-shm`)
   * hold the same live data and are secured the same way; either may not
   * exist yet on a brand-new database, which is not an error.
   */
  private securePermissions(path: string): void {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(p, 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }

  /**
   * Registers a client, first pruning abandoned registrations and then
   * refusing outright if the store is still at capacity — see MAX_CLIENTS
   * and UNAUTHORIZED_CLIENT_TTL_MS. Thrown as a plain Error: the SDK's
   * registration handler (RegisterHandler.ts) catches any non-OAuthError
   * thrown from `registerClient` and reports it as a 500 server_error, which
   * is the correct signal here — this is a capacity problem, not a malformed
   * request.
   */
  saveClient(c: StoredClient): void {
    this.pruneStaleClients();
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number };
    if (n >= MAX_CLIENTS) {
      throw new Error('Client registration limit reached. Try again later.');
    }
    this.db
      .prepare('INSERT OR REPLACE INTO clients (client_id, json, created_at, authorized_at) VALUES (?, ?, ?, NULL)')
      .run(c.client_id, JSON.stringify(c), Date.now());
  }

  /** Discards registrations that never completed an authorization within the window. */
  private pruneStaleClients(): void {
    this.db
      .prepare('DELETE FROM clients WHERE authorized_at IS NULL AND created_at < ?')
      .run(Date.now() - UNAUTHORIZED_CLIENT_TTL_MS);
  }

  /**
   * Marks a client as having completed at least one real authorization —
   * called once a code issued to it is actually redeemed for tokens (see
   * OscarOAuthProvider.exchangeAuthorizationCode). From this point on
   * `pruneStaleClients` never touches it, no matter how long it goes before
   * its next request.
   */
  markClientAuthorized(clientId: string): void {
    this.db
      .prepare('UPDATE clients SET authorized_at = ? WHERE client_id = ? AND authorized_at IS NULL')
      .run(Date.now(), clientId);
  }

  getClient(id: string): StoredClient | undefined {
    const row = this.db.prepare('SELECT json FROM clients WHERE client_id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  /** `createdAt` is injectable so tests can age a record without sleeping. */
  savePending(p: Pending, createdAt = Date.now()): string {
    const id = randomBytes(24).toString('hex');
    this.db.prepare('INSERT INTO pending (id, json, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(p), createdAt);
    return id;
  }

  /** Read a parked request without consuming it — used to render the consent page. */
  peekPending(id: string): Pending | undefined {
    const row = this.db.prepare('SELECT json FROM pending WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  takePending(id: string): Pending | undefined {
    const row = this.db.prepare('SELECT json FROM pending WHERE id = ?').get(id) as { json: string } | undefined;
    if (!row) return undefined;
    this.db.prepare('DELETE FROM pending WHERE id = ?').run(id);
    return JSON.parse(row.json);
  }

  saveCode(c: Code): void {
    this.db
      .prepare('INSERT OR REPLACE INTO codes (code, json, expires_at) VALUES (?, ?, ?)')
      .run(c.code, JSON.stringify(c), c.expiresAt);
  }

  /**
   * Redeem a code. Deletes unconditionally, so a code that turns out to be
   * expired is also burned rather than left available for another attempt.
   */
  takeCode(code: string): Code | undefined {
    const row = this.db.prepare('SELECT json, expires_at FROM codes WHERE code = ?').get(code) as
      | { json: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    this.db.prepare('DELETE FROM codes WHERE code = ?').run(code);
    return row.expires_at < Date.now() ? undefined : JSON.parse(row.json);
  }

  /**
   * Read a code without redeeming it.
   *
   * Exists so `challengeForAuthorizationCode` never has to delete-then-reinsert
   * to answer a question. Take-then-restore would briefly remove the row (so a
   * concurrent redemption could miss it) and, worse, would resurrect a code the
   * caller had already failed to redeem.
   */
  peekCode(code: string): Code | undefined {
    const row = this.db.prepare('SELECT json, expires_at FROM codes WHERE code = ?').get(code) as
      | { json: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < Date.now()) return undefined;
    return JSON.parse(row.json);
  }

  saveToken(t: Token): void {
    this.db
      .prepare('INSERT OR REPLACE INTO tokens (token, json, expires_at) VALUES (?, ?, ?)')
      .run(t.token, JSON.stringify(t), t.expiresAt);
  }

  getToken(token: string): Token | undefined {
    const row = this.db.prepare('SELECT json, expires_at FROM tokens WHERE token = ?').get(token) as
      | { json: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < Date.now()) {
      this.deleteToken(token);
      return undefined;
    }
    return JSON.parse(row.json);
  }

  deleteToken(token: string): void {
    this.db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
  }

  /** Housekeeping — call on an interval so the tables do not grow without bound. */
  purgeExpired(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM codes WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM pending WHERE created_at < ?').run(now - PENDING_TTL_MS);
    // Bounds client-table growth even between registrations — saveClient
    // already prunes on every write, but a quiet spell with no new
    // registrations would otherwise let abandoned rows sit until the next one.
    this.pruneStaleClients();
  }

  /** Test/diagnostic helper: row counts per table. */
  countRows(): { clients: number; pending: number; codes: number; tokens: number } {
    const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { clients: count('clients'), pending: count('pending'), codes: count('codes'), tokens: count('tokens') };
  }

  close(): void {
    this.db.close();
  }
}
