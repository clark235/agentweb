/**
 * AgentWeb Cache Layer Tests
 *
 * Tests the SQLite-backed PageCache and its integration with smart-renderer.
 * Run: node test-cache.js
 */

import { PageCache } from './cache.js';
import { render, cacheStats, invalidateCache } from './smart-renderer.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

// ── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n${name}`);
  console.log('─'.repeat(name.length));
}

// ── Unit tests: PageCache directly ───────────────────────────────────────────

section('Unit: PageCache CRUD');

const dbPath = join(tmpdir(), `agentweb-test-cache-${Date.now()}.db`);
const cache = new PageCache({ ttlMs: 5000, maxEntries: 10, dbPath, verbose: false });

// Basic set/get
cache.set('https://example.com', '', { backend: 'lite', title: 'Example' });
const hit1 = cache.get('https://example.com', '');
assert(hit1 !== null, 'GET after SET returns entry');
assert(hit1.backend === 'lite', 'GET returns correct data', JSON.stringify(hit1));
assert(hit1.title === 'Example', 'GET preserves all fields');

// Miss
const miss1 = cache.get('https://not-cached.com', '');
assert(miss1 === null, 'GET miss returns null');

// Query distinction
cache.set('https://example.com', 'login form', { backend: 'playwright', info: 'login' });
const hit2 = cache.get('https://example.com', 'login form');
const hit3 = cache.get('https://example.com', '');  // original still there
assert(hit2 !== null && hit2.info === 'login', 'Query-keyed entries are distinct');
assert(hit3 !== null && hit3.title === 'Example', 'Original entry unaffected by new query entry');

// Overwrite (same url+query)
cache.set('https://example.com', '', { backend: 'lite', title: 'Updated' });
const hit4 = cache.get('https://example.com', '');
assert(hit4?.title === 'Updated', 'SET overwrites existing entry');

section('Unit: TTL and Expiry');

// Immediate TTL (already expired before we read)
cache.set('https://ttl-test.com', '', { backend: 'lite', x: 1 }, 1); // 1ms TTL
await new Promise(r => setTimeout(r, 10));
const expired = cache.get('https://ttl-test.com', '');
assert(expired === null, 'Expired entry returns null');

// Normal TTL still valid
cache.set('https://ttl-valid.com', '', { backend: 'lite', x: 2 }, 60_000);
const valid = cache.get('https://ttl-valid.com', '');
assert(valid !== null, 'Non-expired entry is returned');

section('Unit: Invalidation');

cache.set('https://inv-test.com', '', { backend: 'lite' });
cache.set('https://inv-test.com', 'query1', { backend: 'playwright' });
const removed = cache.invalidate('https://inv-test.com');
assert(removed === 2, `Invalidate removes all query variants (got ${removed})`);
assert(cache.get('https://inv-test.com', '') === null, 'Invalidated URL is gone (empty query)');
assert(cache.get('https://inv-test.com', 'query1') === null, 'Invalidated URL is gone (with query)');

section('Unit: LRU Eviction');

// Fill to max (10) + 3 extra
const lruCache = new PageCache({ ttlMs: 60_000, maxEntries: 5, dbPath, verbose: false });
for (let i = 0; i < 8; i++) {
  lruCache.set(`https://lru-${i}.com`, '', { backend: 'lite', i });
}
const stats = lruCache.stats();
assert(stats.active <= 5, `LRU eviction keeps entries ≤ maxEntries (got ${stats.active})`);

section('Unit: Stats');

const s = cache.stats();
assert(typeof s.entries === 'number', 'stats.entries is a number');
assert(typeof s.active === 'number', 'stats.active is a number');
assert(s.backends && typeof s.backends === 'object', 'stats.backends is an object');
assert(Array.isArray(s.topHits), 'stats.topHits is an array');
console.log(`  ℹ️  Stats: ${JSON.stringify(s, null, 2).split('\n').join('\n  ')}`);

cache.close();

section('Integration: smart-renderer cache hits');

console.log('  Fetching Hacker News (first call — should be a MISS)...');
const t1 = Date.now();
const r1 = await render('https://news.ycombinator.com', { verbose: false });
const ms1 = Date.now() - t1;
assert(r1.backend === 'lite', `First render uses lite backend (got ${r1.backend})`);
assert(!r1.cached, 'First render is not from cache');
console.log(`  ℹ️  First call: ${ms1}ms`);

console.log('  Fetching Hacker News (second call — should be a HIT)...');
const t2 = Date.now();
const r2 = await render('https://news.ycombinator.com', { verbose: false });
const ms2 = Date.now() - t2;
assert(r2.cached === true, 'Second render is served from cache');
assert(ms2 < 50, `Cache hit is fast (<50ms, got ${ms2}ms)`);
console.log(`  ℹ️  Cache hit: ${ms2}ms (${Math.round(ms1 / ms2)}x speedup)`);

console.log('  Fetching with noCache=true...');
const t3 = Date.now();
const r3 = await render('https://news.ycombinator.com', { noCache: true });
const ms3 = Date.now() - t3;
assert(!r3.cached, 'noCache=true bypasses cache');
assert(ms3 > 50, `noCache forces real fetch (took ${ms3}ms)`);
console.log(`  ℹ️  noCache fetch: ${ms3}ms`);

section('Integration: Cache stats after renders');

const finalStats = cacheStats();
console.log(`  ℹ️  Total entries: ${finalStats.entries}`);
console.log(`  ℹ️  Active: ${finalStats.active}`);
console.log(`  ℹ️  Backends:`, finalStats.backends);
assert(finalStats.active >= 1, 'At least 1 active cached entry after renders');

// ── Cleanup ──────────────────────────────────────────────────────────────────

try {
  rmSync(dbPath);
} catch { /* best effort */ }

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);

if (failed === 0) {
  console.log('\n🎉 All cache tests passed!');
  process.exit(0);
} else {
  console.log('\n💥 Some tests failed.');
  process.exit(1);
}
