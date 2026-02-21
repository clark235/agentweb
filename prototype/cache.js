/**
 * AgentWeb Cache Layer
 *
 * SQLite-backed cache for rendered pages. Zero external dependencies —
 * uses Node.js 22+ built-in node:sqlite.
 *
 * Features:
 *   - Per-URL TTL (default 10 minutes)
 *   - Backend-aware (lite vs playwright cached separately)
 *   - Query-keyed: cache(url, query="") distinct from cache(url, query="install")
 *   - LRU eviction: keeps most-accessed entries, drops old ones
 *   - Metrics: hit rate, entry count, oldest entry
 *
 * Usage:
 *   import { PageCache } from './cache.js';
 *
 *   const cache = new PageCache({ ttlMs: 10 * 60 * 1000 });
 *   const hit = cache.get('https://example.com', 'query');
 *   if (!hit) {
 *     const result = await render(url);
 *     cache.set('https://example.com', 'query', result);
 *   }
 *   cache.close();
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const DEFAULT_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_DB_PATH = join(homedir(), '.agentweb', 'cache.db');

export class PageCache {
  /**
   * @param {object} opts
   * @param {number} [opts.ttlMs=600000]     - Default TTL per entry (ms)
   * @param {number} [opts.maxEntries=500]   - Max entries before LRU eviction
   * @param {string} [opts.dbPath]           - Path to SQLite DB file
   * @param {boolean} [opts.verbose=false]   - Log cache hits/misses
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    this.verbose = opts.verbose ?? false;

    // Ensure directory exists
    const dbDir = this.dbPath.replace(/\/[^/]+$/, '');
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    this._db = new DatabaseSync(this.dbPath);
    this._init();
  }

  _init() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS page_cache (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        url         TEXT    NOT NULL,
        query       TEXT    NOT NULL DEFAULT '',
        backend     TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        hit_count   INTEGER NOT NULL DEFAULT 0,
        last_hit    INTEGER NOT NULL DEFAULT 0
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_url_query
        ON page_cache (url, query);

      CREATE INDEX IF NOT EXISTS idx_expires
        ON page_cache (expires_at);

      CREATE INDEX IF NOT EXISTS idx_last_hit
        ON page_cache (last_hit);
    `);
  }

  /**
   * Look up a cached result.
   * Returns the parsed result object, or null on miss/expiry.
   *
   * @param {string} url
   * @param {string} [query='']
   * @returns {object|null}
   */
  get(url, query = '') {
    const now = Date.now();

    const row = this._db.prepare(`
      SELECT id, result_json, expires_at, hit_count
      FROM page_cache
      WHERE url = ? AND query = ?
      LIMIT 1
    `).get(url, query);

    if (!row) {
      this._verbose(`MISS ${url} q="${query}"`);
      return null;
    }

    if (row.expires_at < now) {
      this._verbose(`EXPIRED ${url} q="${query}" (expired ${Math.round((now - row.expires_at) / 1000)}s ago)`);
      this._db.prepare('DELETE FROM page_cache WHERE id = ?').run(row.id);
      return null;
    }

    // Update hit count + last_hit
    this._db.prepare(`
      UPDATE page_cache SET hit_count = hit_count + 1, last_hit = ? WHERE id = ?
    `).run(now, row.id);

    this._verbose(`HIT  ${url} q="${query}" (hits: ${row.hit_count + 1})`);
    try {
      return JSON.parse(row.result_json);
    } catch {
      return null;
    }
  }

  /**
   * Store a result in the cache.
   *
   * @param {string} url
   * @param {string} query
   * @param {object} result        - The render result to cache
   * @param {number} [ttlMs]      - Override TTL for this entry
   */
  set(url, query = '', result, ttlMs) {
    const now = Date.now();
    const ttl = ttlMs ?? this.ttlMs;
    const expiresAt = now + ttl;
    const backend = result?.backend ?? 'unknown';

    // Strip large Playwright page objects if they accidentally snuck in
    const safeResult = stripUnserializable(result);

    this._db.prepare(`
      INSERT INTO page_cache (url, query, backend, result_json, created_at, expires_at, hit_count, last_hit)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT (url, query) DO UPDATE SET
        backend     = excluded.backend,
        result_json = excluded.result_json,
        created_at  = excluded.created_at,
        expires_at  = excluded.expires_at,
        hit_count   = 0,
        last_hit    = excluded.last_hit
    `).run(url, query, backend, JSON.stringify(safeResult), now, expiresAt, now);

    this._verbose(`SET  ${url} q="${query}" backend=${backend} ttl=${Math.round(ttl / 1000)}s`);

    // Evict if over limit
    this._evictIfNeeded();
  }

  /**
   * Invalidate a specific URL (all queries).
   */
  invalidate(url) {
    const { changes } = this._db.prepare('DELETE FROM page_cache WHERE url = ?').run(url);
    this._verbose(`INVALIDATE ${url} (${changes} entries removed)`);
    return changes;
  }

  /**
   * Remove all expired entries.
   * @returns {number} rows removed
   */
  purgeExpired() {
    const { changes } = this._db.prepare(
      'DELETE FROM page_cache WHERE expires_at < ?'
    ).run(Date.now());
    return changes;
  }

  /**
   * LRU eviction: if over maxEntries, remove the oldest/least-hit entries.
   */
  _evictIfNeeded() {
    const count = this._db.prepare('SELECT COUNT(*) as n FROM page_cache').get().n;
    if (count <= this.maxEntries) return;

    const toRemove = count - this.maxEntries;
    // Evict: expired first, then by last_hit ascending (LRU)
    this._db.exec(`
      DELETE FROM page_cache WHERE id IN (
        SELECT id FROM page_cache
        ORDER BY
          CASE WHEN expires_at < ${Date.now()} THEN 0 ELSE 1 END ASC,
          last_hit ASC
        LIMIT ${toRemove}
      )
    `);
    this._verbose(`EVICT ${toRemove} entries (was ${count}, limit ${this.maxEntries})`);
  }

  /**
   * Cache statistics.
   * @returns {{ entries: number, backends: object, oldestMs: number|null }}
   */
  stats() {
    const total = this._db.prepare('SELECT COUNT(*) as n FROM page_cache').get().n;
    const expired = this._db.prepare(
      'SELECT COUNT(*) as n FROM page_cache WHERE expires_at < ?'
    ).get(Date.now()).n;

    const byBackend = this._db.prepare(`
      SELECT backend, COUNT(*) as n FROM page_cache GROUP BY backend
    `).all();

    const oldest = this._db.prepare(
      'SELECT MIN(created_at) as t FROM page_cache'
    ).get()?.t ?? null;

    const topHits = this._db.prepare(`
      SELECT url, query, hit_count, backend
      FROM page_cache ORDER BY hit_count DESC LIMIT 5
    `).all();

    return {
      entries: total,
      expired,
      active: total - expired,
      backends: Object.fromEntries(byBackend.map(r => [r.backend, r.n])),
      oldestMs: oldest ? Date.now() - oldest : null,
      topHits,
    };
  }

  _verbose(msg) {
    if (this.verbose) console.error(`[cache] ${msg}`);
  }

  close() {
    try { this._db.close(); } catch { /* ignore */ }
  }
}

/**
 * Remove circular references and non-serializable values from a result object.
 * Playwright Page objects, functions, etc. would break JSON.stringify.
 */
function stripUnserializable(obj, depth = 0) {
  if (depth > 10) return '[too deep]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'function') return undefined;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => stripUnserializable(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function') continue;
    if (v && typeof v === 'object' && v.constructor?.name === 'Page') continue;
    out[k] = stripUnserializable(v, depth + 1);
  }
  return out;
}

export default PageCache;
