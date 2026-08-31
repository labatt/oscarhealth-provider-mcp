import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Upper bound on cached responses. At roughly 80 KB per stored search page this
 * is a few hundred MB — generous for real use, and finite under an adversarial
 * one.
 */
const MAX_ROWS = 5000;

export interface CacheHit {
  body: unknown;
  cachedAt: number;
}

/**
 * Persistent response cache. SQLite rather than an in-memory Map because the
 * process runs under pm2 and restarts (deploys, max_memory_restart) would
 * otherwise throw away a cache whose whole purpose is to keep upstream request
 * volume low. The provider directory changes on the order of weeks, so a cache
 * that survives restarts is the main politeness mechanism in this server.
 */
export class ResponseCache {
  private readonly db: Database.Database;
  private readonly maxRows: number;

  /** `maxRows` is injectable so the eviction bound can be tested cheaply. */
  constructor(dbPath: string, opts: { maxRows?: number } = {}) {
    this.maxRows = opts.maxRows ?? MAX_ROWS;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        key TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      )
    `);
  }

  get(key: string, ttlMs: number): CacheHit | undefined {
    const row = this.db
      .prepare('SELECT body, cached_at FROM responses WHERE key = ?')
      .get(key) as { body: string; cached_at: number } | undefined;
    if (!row) return undefined;
    if (Date.now() - row.cached_at >= ttlMs) return undefined;
    return { body: JSON.parse(row.body), cachedAt: row.cached_at };
  }

  set(key: string, body: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO responses (key, body, cached_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(body), Date.now());
    this.evictBeyond(this.maxRows);
  }

  /**
   * Age-based expiry alone does not bound this table. The cache key embeds
   * caller-chosen arguments (a name query, a ZIP, a group name), so a client can
   * mint unlimited distinct keys, each storing a full upstream response for the
   * full TTL. `data/` also holds the OAuth database, so filling the disk would
   * take the auth store down with it. Evicting all but the most recently cached
   * rows makes growth bounded regardless of key cardinality.
   */
  private evictBeyond(maxRows: number): void {
    this.db
      .prepare(
        // rowid breaks ties on cached_at. Millisecond timestamps collide freely
        // — a single search fetches several pages in a burst — and with a tie
        // SQLite's row order is arbitrary, so eviction could drop the newest
        // entries instead of the oldest. INSERT OR REPLACE assigns a fresh
        // rowid, so it tracks write recency exactly.
        `DELETE FROM responses WHERE key NOT IN (
           SELECT key FROM responses ORDER BY cached_at DESC, rowid DESC LIMIT ?
         )`
      )
      .run(maxRows);
  }

  purgeExpired(maxAgeMs: number): void {
    this.db.prepare('DELETE FROM responses WHERE cached_at < ?').run(Date.now() - maxAgeMs);
  }
}
