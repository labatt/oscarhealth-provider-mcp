import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

  constructor(dbPath: string) {
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
  }

  purgeExpired(maxAgeMs: number): void {
    this.db.prepare('DELETE FROM responses WHERE cached_at < ?').run(Date.now() - maxAgeMs);
  }
}
