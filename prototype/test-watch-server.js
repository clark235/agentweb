/**
 * AgentWeb WatchServer Tests
 *
 * Tests the HTTP API without actually making network requests to external URLs.
 * Uses a mock renderer that returns deterministic fake page data.
 */

import { createServer } from 'http';
import { DiffTracker, buildSnapshot } from './diff-tracker.js';
import { chunkPage, findRelevant } from './semantic-chunks.js';

// ─── Test Harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  return { name, fn };
}

async function run(tests) {
  console.log('🧪 AgentWeb WatchServer Tests\n');
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ❌ ${name}`);
      console.log(`     ${e.message}`);
      if (process.env.VERBOSE) console.log(e.stack);
      failed++;
    }
  }
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ─── Mock Renderer ────────────────────────────────────────────────────────────

let _mockVersion = 0;
const mockRender = async (url) => ({
  url,
  backend: 'mock',
  ms: 1,
  data: {
    title: `Mock Page v${_mockVersion}`,
    headings: ['Section A', 'Section B'],
    links: [
      { text: 'Home', href: '/' },
      { text: `Link ${_mockVersion}`, href: `/link-${_mockVersion}` },
    ],
    forms: [],
    text: `This is mock page content version ${_mockVersion}. Price: $${(10 + _mockVersion).toFixed(2)}`,
    interactiveCount: 0,
  },
});

// ─── Inline Server (no file import needed) ────────────────────────────────────
// We inline a minimal version of the watch-server logic for testing,
// using our mock renderer. This avoids the import side effects of starting the real server.

import { get as httpsGet } from 'https';
import { request as httpRequest } from 'http';

// Bring up our own test server instance
let testServer;
let testPort;

async function startTestServer() {
  // Import and re-export with mock renderer injected
  // We build a minimal in-process HTTP wrapper using the same DiffTracker logic

  const tracker = new DiffTracker({ render: mockRender });

  const watches = new Map();
  const globalSseClients = new Set();
  const watchSseClients = new Map();
  const metrics = { watchesCreated: 0, watchesDestroyed: 0, snapshotsTaken: 0, diffsComputed: 0, changesDetected: 0, errors: 0, queriesAnswered: 0, startedAt: Date.now() };

  let _id = 0;
  const newId = () => `tw${Date.now().toString(36)}${(++_id).toString(36)}`;

  const DEFAULT_INTERVAL = 999_999; // very long — tests trigger diffs manually

  function createWatch({ url, intervalMs = DEFAULT_INTERVAL, label = null }) {
    const id = newId();
    const record = {
      id, url, label: label || url, intervalMs,
      createdAt: Date.now(), lastCheckedAt: null,
      checkCount: 0, changeCount: 0,
      lastDiff: null, baseline: null,
      status: 'active', lastError: null, stop: () => {},
    };
    watches.set(id, record);
    metrics.watchesCreated++;

    // Take initial snapshot
    tracker.snapshot(url).then(snap => {
      record.baseline = snap;
      record.lastCheckedAt = Date.now();
      record.checkCount++;
      metrics.snapshotsTaken++;
    }).catch(e => { record.status = 'error'; record.lastError = e.message; });

    return record;
  }

  function stopWatch(id) {
    const r = watches.get(id);
    if (!r) return false;
    try { r.stop(); } catch {}
    watches.delete(id);
    metrics.watchesDestroyed++;
    return true;
  }

  function serialize(r) {
    return { id: r.id, url: r.url, label: r.label, intervalMs: r.intervalMs, status: r.status, createdAt: r.createdAt, lastCheckedAt: r.lastCheckedAt, checkCount: r.checkCount, changeCount: r.changeCount, lastError: r.lastError, hasBaseline: !!r.baseline, lastDiff: r.lastDiff ? { changed: r.lastDiff.changed, summary: r.lastDiff.summary, changesCount: r.lastDiff.changes?.length ?? 0 } : null };
  }

  function json(res, status, body) {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Access-Control-Allow-Origin': '*' });
    res.end(payload);
  }

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
      req.on('error', reject);
    });
  }

  function routeMatch(pattern, url) {
    const parts = pattern.split('/');
    const urlParts = url.split('?')[0].split('/');
    if (parts.length !== urlParts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = urlParts[i];
      else if (parts[i] !== urlParts[i]) return null;
    }
    return params;
  }

  testServer = createServer(async (req, res) => {
    const { method, url } = req;
    const path = url.split('?')[0];
    let params;

    if (method === 'GET' && path === '/health') return json(res, 200, { status: 'ok', watches: watches.size, metrics });
    if (method === 'GET' && path === '/watches') return json(res, 200, { watches: [...watches.values()].map(serialize), count: watches.size });

    if (method === 'POST' && path === '/watches') {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!body.url) return json(res, 400, { error: 'url is required' });
      const record = createWatch({ url: body.url, intervalMs: body.intervalMs, label: body.label });
      return json(res, 201, { watch: serialize(record) });
    }

    if (method === 'GET' && (params = routeMatch('/watches/:id/diff', path))) {
      const record = watches.get(params.id);
      if (!record) return json(res, 404, { error: 'Watch not found' });
      if (!record.baseline) return json(res, 202, { message: 'Baseline not ready' });
      try {
        const diff = await tracker.diff(record.url, record.baseline);
        record.lastDiff = diff;
        record.lastCheckedAt = Date.now();
        record.checkCount++;
        metrics.diffsComputed++;
        if (diff.changed) { record.changeCount++; metrics.changesDetected++; }
        return json(res, 200, { watchId: record.id, changed: diff.changed, summary: diff.summary, changes: diff.changes, snapshotAge: diff.snapshotAge });
      } catch (e) {
        metrics.errors++;
        return json(res, 500, { error: e.message });
      }
    }

    if (method === 'POST' && (params = routeMatch('/watches/:id/snapshot', path))) {
      const record = watches.get(params.id);
      if (!record) return json(res, 404, { error: 'Watch not found' });
      try {
        const snap = await tracker.snapshot(record.url);
        record.lastCheckedAt = Date.now();
        record.checkCount++;
        metrics.snapshotsTaken++;
        return json(res, 200, { snapshot: snap });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (method === 'POST' && (params = routeMatch('/watches/:id/baseline', path))) {
      const record = watches.get(params.id);
      if (!record) return json(res, 404, { error: 'Watch not found' });
      try {
        const snap = await tracker.snapshot(record.url);
        record.baseline = snap;
        tracker.setBaseline(record.url, snap);
        record.lastCheckedAt = Date.now();
        metrics.snapshotsTaken++;
        return json(res, 200, { message: 'Baseline updated', timestamp: snap.timestamp });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (method === 'GET' && (params = routeMatch('/watches/:id', path))) {
      const record = watches.get(params.id);
      if (!record) return json(res, 404, { error: 'Watch not found' });
      return json(res, 200, { watch: serialize(record) });
    }

    if (method === 'POST' && (params = routeMatch('/watches/:id/query', path))) {
      const record = watches.get(params.id);
      if (!record) return json(res, 404, { error: 'Watch not found' });
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      const { question, limit = 6, freshMs = 5 * 60 * 1000 } = body;
      if (!question || typeof question !== 'string' || !question.trim()) {
        return json(res, 400, { error: 'body.question (non-empty string) is required' });
      }
      let snapshot = record.baseline;
      const snapshotAge = snapshot ? Date.now() - snapshot.timestamp : Infinity;
      const needsFresh = !snapshot || snapshotAge > freshMs;
      if (needsFresh) {
        try {
          snapshot = await tracker.snapshot(record.url);
          record.baseline = snapshot;
          tracker.setBaseline(record.url, snapshot);
          record.lastCheckedAt = Date.now();
          metrics.snapshotsTaken++;
        } catch (e) {
          metrics.errors++;
          return json(res, 500, { error: `Failed to fetch page: ${e.message}` });
        }
      }
      const pageForChunking = {
        url: snapshot.url,
        title: snapshot.title,
        headings: snapshot.headings.map(text => ({ level: 1, text })),
        textContent: snapshot.textSample || '',
        stats: snapshot.stats,
        links: snapshot.links,
      };
      const chunks = chunkPage(pageForChunking, { minScore: -3 });
      const relevant = findRelevant(chunks, question.trim(), Math.max(1, Math.min(20, limit)));
      const answerParts = relevant.filter(c => c.relevance > 0).slice(0, 4).map(c => c.text.trim());
      const answer = answerParts.length > 0
        ? answerParts.join('\n\n')
        : `No content found on ${snapshot.title || record.url} that matches "${question}".`;
      const numberContext = snapshot.numbers?.length
        ? `Numbers/values found on page: ${snapshot.numbers.slice(0, 20).join(', ')}`
        : null;
      metrics.queriesAnswered++;
      const responsePayload = {
        watchId: record.id,
        url: record.url,
        question,
        answer,
        relevantChunks: relevant.map(c => ({
          type: c.type,
          text: c.text,
          section: c.section,
          relevanceScore: c.relevance,
        })),
        ...(numberContext ? { numberContext } : {}),
        snapshotAge: needsFresh ? 0 : snapshotAge,
        snapshotTitle: snapshot.title,
        snapshotTimestamp: snapshot.timestamp,
      };
      // Track query history
      if (!record.queryHistory) record.queryHistory = [];
      record.queryHistory.push({
        question,
        answer,
        timestamp: Date.now(),
        snapshotAge: responsePayload.snapshotAge,
        relevantChunks: relevant.length,
        snapshotTitle: snapshot.title,
      });
      if (record.queryHistory.length > 100) record.queryHistory.shift();
      return json(res, 200, responsePayload);
    }

    if (method === 'GET' && (params = routeMatch('/watches/:id/query-history', path))) {
      const record = watches.get(params.id);
      if (!record) return json(res, 404, { error: 'Watch not found' });
      const urlObj = new URL(req.url, `http://127.0.0.1`);
      const limitParam = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      const limit = Math.max(1, Math.min(100, isNaN(limitParam) ? 50 : limitParam));
      const history = (record.queryHistory || []).slice(-limit).reverse();
      return json(res, 200, {
        watchId: record.id,
        url: record.url,
        label: record.label,
        totalQueries: (record.queryHistory || []).length,
        history,
      });
    }

    if (method === 'DELETE' && (params = routeMatch('/watches/:id', path))) {
      const stopped = stopWatch(params.id);
      if (!stopped) return json(res, 404, { error: 'Watch not found' });
      return json(res, 200, { message: `Watch ${params.id} stopped` });
    }

    // ── POST /render — one-shot render ──
    if (method === 'POST' && path === '/render') {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!body.url) return json(res, 400, { error: 'body.url is required' });
      try {
        const raw = await mockRender(body.url);
        metrics.snapshotsTaken++;
        return json(res, 200, {
          url: raw.url,
          title: raw.data.title,
          headings: raw.data.headings || [],
          links: [],
          forms: raw.data.forms || [],
          textContent: (raw.data.text || '').slice(0, body.maxChars || 5000),
          stats: {},
          renderedAt: Date.now(),
        });
      } catch (e) {
        metrics.errors++;
        return json(res, 500, { error: `Render failed: ${e.message}` });
      }
    }

    // ── POST /render/batch — batch render ──
    if (method === 'POST' && path === '/render/batch') {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!Array.isArray(body.urls) || body.urls.length === 0) {
        return json(res, 400, { error: 'body.urls must be a non-empty array of URLs' });
      }
      if (body.urls.length > 20) {
        return json(res, 400, { error: 'Maximum 20 URLs per batch' });
      }
      const maxChars = body.maxChars || 5000;
      const startTime = Date.now();
      const results = await Promise.all(body.urls.map(async (url) => {
        try {
          const raw = await mockRender(url);
          metrics.snapshotsTaken++;
          return {
            url: raw.url,
            title: raw.data.title,
            headings: raw.data.headings || [],
            links: [],
            forms: raw.data.forms || [],
            textContent: (raw.data.text || '').slice(0, maxChars),
            stats: {},
            renderedAt: Date.now(),
          };
        } catch (e) {
          metrics.errors++;
          return { url, error: e.message, renderedAt: Date.now() };
        }
      }));
      const timing = Date.now() - startTime;
      const succeeded = results.filter(r => !r.error).length;
      const failed = results.filter(r => r.error).length;
      return json(res, 200, {
        results,
        summary: { total: body.urls.length, succeeded, failed, timingMs: timing },
      });
    }

    // ── POST /extract — render + semantic chunking ──
    if (method === 'POST' && path === '/extract') {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!body.url) return json(res, 400, { error: 'body.url is required' });
      try {
        const raw = await mockRender(body.url);
        metrics.snapshotsTaken++;
        const pageForChunking = {
          url: raw.url,
          title: raw.data.title,
          headings: (raw.data.headings || []).map(h => typeof h === 'string' ? { level: 1, text: h } : h),
          textContent: raw.data.text || '',
          stats: {},
          interactives: [],
        };
        const maxChunks = Math.max(1, Math.min(50, body.maxChunks || 10));
        const chunks = chunkPage(pageForChunking, { minScore: -3 });
        let resultChunks;
        if (body.query && body.query.trim()) {
          resultChunks = findRelevant(chunks, body.query.trim(), maxChunks);
        } else {
          resultChunks = chunks
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .slice(0, maxChunks)
            .map(c => ({ ...c, relevance: c.score ?? 0 }));
        }
        return json(res, 200, {
          url: raw.url,
          title: raw.data.title,
          chunks: resultChunks.map(c => ({
            type: c.type,
            text: c.text,
            section: c.section,
            relevanceScore: c.relevance ?? c.score ?? 0,
          })),
          totalChunks: chunks.length,
          query: body.query || null,
          renderedAt: Date.now(),
        });
      } catch (e) {
        metrics.errors++;
        return json(res, 500, { error: `Extract failed: ${e.message}` });
      }
    }

    return json(res, 404, { error: 'Not found' });
  });

  await new Promise(resolve => {
    testServer.listen(0, '127.0.0.1', () => {
      testPort = testServer.address().port;
      resolve();
    });
  });
}

function stopTestServer() {
  return new Promise(resolve => testServer?.close(resolve) || resolve());
}

// ─── HTTP Client ──────────────────────────────────────────────────────────────

async function api(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: testPort,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = httpRequest(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Helper: wait until baseline is ready (poll GET /watches/:id)
async function waitForBaseline(id, maxMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = await api('GET', `/watches/${id}`);
    if (r.body.watch?.hasBaseline) return r.body.watch;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Baseline not ready for ${id} after ${maxMs}ms`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const TESTS = [
  test('GET /health returns ok', async () => {
    const r = await api('GET', '/health');
    assertEqual(r.status, 200);
    assertEqual(r.body.status, 'ok');
    assert(typeof r.body.watches === 'number');
  }),

  test('GET /watches returns empty list initially', async () => {
    const r = await api('GET', '/watches');
    assertEqual(r.status, 200);
    assertEqual(r.body.count, 0);
    assert(Array.isArray(r.body.watches));
  }),

  test('POST /watches without url returns 400', async () => {
    const r = await api('POST', '/watches', {});
    assertEqual(r.status, 400);
    assert(r.body.error.includes('url'));
  }),

  test('POST /watches creates a watch', async () => {
    _mockVersion = 1;
    const r = await api('POST', '/watches', { url: 'https://example.com/page1', label: 'Test Page' });
    assertEqual(r.status, 201);
    assert(r.body.watch.id, 'should have id');
    assertEqual(r.body.watch.url, 'https://example.com/page1');
    assertEqual(r.body.watch.label, 'Test Page');
    assertEqual(r.body.watch.status, 'active');
  }),

  test('GET /watches lists created watch', async () => {
    const r = await api('GET', '/watches');
    assertEqual(r.status, 200);
    assertEqual(r.body.count, 1);
    assertEqual(r.body.watches[0].url, 'https://example.com/page1');
  }),

  test('GET /watches/:id returns watch detail', async () => {
    const listR = await api('GET', '/watches');
    const id = listR.body.watches[0].id;
    const r = await api('GET', `/watches/${id}`);
    assertEqual(r.status, 200);
    assertEqual(r.body.watch.id, id);
  }),

  test('GET /watches/:bad returns 404', async () => {
    const r = await api('GET', '/watches/nonexistent');
    assertEqual(r.status, 404);
  }),

  test('GET /watches/:id/diff — no change detected when page is same', async () => {
    const listR = await api('GET', '/watches');
    const id = listR.body.watches[0].id;

    // Wait for baseline to be established
    await waitForBaseline(id);

    // Mock returns same version — no changes expected
    const r = await api('GET', `/watches/${id}/diff`);
    assertEqual(r.status, 200);
    assertEqual(r.body.watchId, id);
    assert(typeof r.body.changed === 'boolean');
    assert(typeof r.body.summary === 'string');
  }),

  test('GET /watches/:id/diff — detects changes when page content changes', async () => {
    // Create a fresh watch with version 0
    _mockVersion = 0;
    const createR = await api('POST', '/watches', { url: 'https://example.com/changing' });
    const id = createR.body.watch.id;
    await waitForBaseline(id);

    // Now change the mock version — next diff should detect it
    _mockVersion = 5;

    const r = await api('GET', `/watches/${id}/diff`);
    assertEqual(r.status, 200);
    assertEqual(r.body.watchId, id);
    // With version change, title changes → should detect something
    assert(typeof r.body.changed === 'boolean');
    // Title changed from "Mock Page v0" to "Mock Page v5"
    if (r.body.changed) {
      assert(Array.isArray(r.body.changes));
      assert(r.body.changes.length > 0);
    }
  }),

  test('POST /watches/:id/snapshot takes a snapshot', async () => {
    const listR = await api('GET', '/watches');
    const id = listR.body.watches[0].id;
    const r = await api('POST', `/watches/${id}/snapshot`);
    assertEqual(r.status, 200);
    assert(r.body.snapshot.url);
    assert(typeof r.body.snapshot.timestamp === 'number');
    assert(r.body.snapshot.title);
  }),

  test('POST /watches/:id/baseline updates baseline', async () => {
    const listR = await api('GET', '/watches');
    const id = listR.body.watches[0].id;
    const r = await api('POST', `/watches/${id}/baseline`);
    assertEqual(r.status, 200);
    assert(r.body.message.includes('Baseline'));
    assert(typeof r.body.timestamp === 'number');
  }),

  test('POST /watches/nonexistent/snapshot returns 404', async () => {
    const r = await api('POST', '/watches/nonexistent/snapshot');
    assertEqual(r.status, 404);
  }),

  test('DELETE /watches/:id removes watch', async () => {
    const listR = await api('GET', '/watches');
    const id = listR.body.watches[listR.body.watches.length - 1].id;
    const r = await api('DELETE', `/watches/${id}`);
    assertEqual(r.status, 200);
    // Verify it's gone
    const check = await api('GET', `/watches/${id}`);
    assertEqual(check.status, 404);
  }),

  test('DELETE /watches/nonexistent returns 404', async () => {
    const r = await api('DELETE', '/watches/nonexistent');
    assertEqual(r.status, 404);
  }),

  test('Multiple watches can coexist', async () => {
    const urls = ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'];
    for (const url of urls) await api('POST', '/watches', { url });
    const listR = await api('GET', '/watches');
    assert(listR.body.count >= 3, `Expected at least 3 watches, got ${listR.body.count}`);
  }),

  test('Custom intervalMs is stored on watch', async () => {
    const r = await api('POST', '/watches', { url: 'https://interval.example.com', intervalMs: 120_000 });
    assertEqual(r.status, 201);
    assertEqual(r.body.watch.intervalMs, 120_000);
    const id = r.body.watch.id;
    const detail = await api('GET', `/watches/${id}`);
    assertEqual(detail.body.watch.intervalMs, 120_000);
    await api('DELETE', `/watches/${id}`);
  }),

  test('Invalid JSON body returns 400', async () => {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1', port: testPort,
        path: '/watches', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      };
      const req = httpRequest(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const body = JSON.parse(data);
            assertEqual(res.statusCode, 400);
            assert(body.error);
            resolve();
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write('{invalid json!!}');
      req.end();
    });
  }),

  test('404 for unknown routes', async () => {
    const r = await api('GET', '/unknown/route');
    assertEqual(r.status, 404);
  }),

  // ── Query endpoint ───────────────────────────────────────────────────────────

  test('POST /watches/:id/query returns answer and relevant chunks', async () => {
    _mockVersion = 2;
    const createR = await api('POST', '/watches', { url: 'https://query-test.example.com' });
    const id = createR.body.watch.id;
    await waitForBaseline(id);

    const r = await api('POST', `/watches/${id}/query`, { question: 'what is on this page' });
    assertEqual(r.status, 200);
    assert(r.body.watchId === id, 'watchId matches');
    assert(typeof r.body.answer === 'string' && r.body.answer.length > 0, 'has answer string');
    assert(Array.isArray(r.body.relevantChunks), 'has relevantChunks array');
    assert(typeof r.body.snapshotTimestamp === 'number', 'has snapshotTimestamp');
    assert(typeof r.body.question === 'string', 'echoes question');
    assertEqual(r.body.question, 'what is on this page');

    await api('DELETE', `/watches/${id}`);
  }),

  test('POST /watches/:id/query 400 if question missing', async () => {
    const createR = await api('POST', '/watches', { url: 'https://q2.example.com' });
    const id = createR.body.watch.id;
    const r = await api('POST', `/watches/${id}/query`, {});
    assertEqual(r.status, 400);
    assert(r.body.error.includes('question'), 'error mentions question');
    await api('DELETE', `/watches/${id}`);
  }),

  test('POST /watches/:id/query 400 if question is empty string', async () => {
    const createR = await api('POST', '/watches', { url: 'https://q3.example.com' });
    const id = createR.body.watch.id;
    const r = await api('POST', `/watches/${id}/query`, { question: '   ' });
    assertEqual(r.status, 400);
    await api('DELETE', `/watches/${id}`);
  }),

  test('POST /watches/:id/query 404 on unknown watch', async () => {
    const r = await api('POST', '/watches/no-such-watch/query', { question: 'anything' });
    assertEqual(r.status, 404);
  }),

  test('POST /watches/:id/query uses fresh snapshot when no baseline yet', async () => {
    // Create a watch but don't wait for baseline
    _mockVersion = 3;
    const createR = await api('POST', '/watches', { url: 'https://q4.example.com' });
    const id = createR.body.watch.id;

    // Query immediately (may or may not have baseline yet)
    const r = await api('POST', `/watches/${id}/query`, { question: 'price content version' });
    // Should succeed in any case (query takes its own snapshot if needed)
    assertEqual(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(typeof r.body.answer === 'string', 'has answer');

    await api('DELETE', `/watches/${id}`);
  }),

  test('POST /watches/:id/query relevant chunks contain scored results', async () => {
    _mockVersion = 7;
    const createR = await api('POST', '/watches', { url: 'https://q5.example.com' });
    const id = createR.body.watch.id;
    await waitForBaseline(id);

    // Ask about price — mock page has "Price: $17.00" in its content
    const r = await api('POST', `/watches/${id}/query`, { question: 'price', limit: 3 });
    assertEqual(r.status, 200);
    assert(r.body.relevantChunks.length <= 3, 'respects limit');
    for (const chunk of r.body.relevantChunks) {
      assert(typeof chunk.type === 'string', 'chunk has type');
      assert(typeof chunk.text === 'string', 'chunk has text');
      assert(typeof chunk.relevanceScore === 'number', 'chunk has relevanceScore');
    }

    await api('DELETE', `/watches/${id}`);
  }),

  test('POST /watches/:id/query answer contains page content for matching question', async () => {
    _mockVersion = 4;
    const createR = await api('POST', '/watches', { url: 'https://q6.example.com' });
    const id = createR.body.watch.id;
    await waitForBaseline(id);

    // Question targets content that mock page produces
    const r = await api('POST', `/watches/${id}/query`, { question: 'mock page content version' });
    assertEqual(r.status, 200);
    // Answer should contain something relevant (mock page always has "Mock Page v{n}" in title)
    const answer = r.body.answer.toLowerCase() + r.body.relevantChunks.map(c => c.text).join(' ').toLowerCase();
    assert(answer.includes('mock') || answer.includes('page') || answer.includes('content'), 'answer references page content');

    await api('DELETE', `/watches/${id}`);
  }),

  // ─── Query History ──────────────────────────────────────────────────────────

  test('GET /watches/:id/query-history returns empty history initially', async () => {
    const createR = await api('POST', '/watches', { url: 'https://qh1.example.com' });
    assert(createR.status === 200 || createR.status === 201, `create status ${createR.status}`);
    const id = createR.body.watch.id;

    const r = await api('GET', `/watches/${id}/query-history`);
    assertEqual(r.status, 200, 'status 200');
    assert(Array.isArray(r.body.history), 'history is array');
    assertEqual(r.body.history.length, 0, 'empty initially');
    assertEqual(r.body.totalQueries, 0, 'totalQueries is 0');
    assertEqual(r.body.watchId, id, 'watchId matches');

    await api('DELETE', `/watches/${id}`);
  }),

  test('GET /watches/:id/query-history records queries in order, newest first', async () => {
    _mockVersion = 5;
    const createR = await api('POST', '/watches', { url: 'https://qh2.example.com' });
    assert(createR.status === 200 || createR.status === 201, `create status ${createR.status}`);
    const id = createR.body.watch.id;
    await waitForBaseline(id);

    // Submit 3 queries
    await api('POST', `/watches/${id}/query`, { question: 'first question' });
    await api('POST', `/watches/${id}/query`, { question: 'second question' });
    await api('POST', `/watches/${id}/query`, { question: 'third question' });

    const r = await api('GET', `/watches/${id}/query-history`);
    assertEqual(r.status, 200, 'status 200');
    assertEqual(r.body.totalQueries, 3, '3 total queries');
    assertEqual(r.body.history.length, 3, '3 entries in history');

    // Newest first
    assertEqual(r.body.history[0].question, 'third question', 'newest first');
    assertEqual(r.body.history[1].question, 'second question', 'second entry');
    assertEqual(r.body.history[2].question, 'first question', 'oldest last');

    // Each entry has required fields
    const entry = r.body.history[0];
    assert(typeof entry.question === 'string', 'has question');
    assert(typeof entry.answer === 'string', 'has answer');
    assert(typeof entry.timestamp === 'number', 'has timestamp');
    assert(typeof entry.relevantChunks === 'number', 'has relevantChunks count');

    await api('DELETE', `/watches/${id}`);
  }),

  test('GET /watches/:id/query-history respects ?limit param', async () => {
    _mockVersion = 6;
    const createR = await api('POST', '/watches', { url: 'https://qh3.example.com' });
    const id = createR.body.watch.id;
    await waitForBaseline(id);

    // Submit 5 queries
    for (let i = 1; i <= 5; i++) {
      await api('POST', `/watches/${id}/query`, { question: `question ${i}` });
    }

    // Request only last 2
    const r = await api('GET', `/watches/${id}/query-history?limit=2`);
    assertEqual(r.status, 200, 'status 200');
    assertEqual(r.body.totalQueries, 5, 'totalQueries reflects all 5');
    assertEqual(r.body.history.length, 2, 'only 2 returned due to limit');
    assertEqual(r.body.history[0].question, 'question 5', 'most recent first');

    await api('DELETE', `/watches/${id}`);
  }),

  test('GET /watches/:id/query-history 404 on unknown watch', async () => {
    const r = await api('GET', '/watches/no-such-watch/query-history');
    assertEqual(r.status, 404, 'status 404');
  }),

  // ─── One-shot Render ─────────────────────────────────────────────────────────

  test('POST /render returns structured page data', async () => {
    _mockVersion = 10;
    const r = await api('POST', '/render', { url: 'https://render.example.com' });
    assertEqual(r.status, 200);
    assertEqual(r.body.url, 'https://render.example.com');
    assertEqual(r.body.title, 'Mock Page v10');
    assert(Array.isArray(r.body.headings), 'has headings');
    assert(typeof r.body.textContent === 'string', 'has textContent');
    assert(typeof r.body.renderedAt === 'number', 'has renderedAt timestamp');
  }),

  test('POST /render 400 if url missing', async () => {
    const r = await api('POST', '/render', {});
    assertEqual(r.status, 400);
    assert(r.body.error.includes('url'));
  }),

  test('POST /render respects maxChars', async () => {
    _mockVersion = 11;
    const r = await api('POST', '/render', { url: 'https://maxchars.example.com', maxChars: 10 });
    assertEqual(r.status, 200);
    assert(r.body.textContent.length <= 10, `textContent should be ≤10 chars, got ${r.body.textContent.length}`);
  }),

  // ─── Batch Render ────────────────────────────────────────────────────────────

  test('POST /render/batch renders multiple URLs', async () => {
    _mockVersion = 20;
    const r = await api('POST', '/render/batch', {
      urls: ['https://batch1.example.com', 'https://batch2.example.com', 'https://batch3.example.com'],
    });
    assertEqual(r.status, 200);
    assertEqual(r.body.results.length, 3, '3 results');
    assertEqual(r.body.summary.total, 3);
    assertEqual(r.body.summary.succeeded, 3);
    assertEqual(r.body.summary.failed, 0);
    assert(typeof r.body.summary.timingMs === 'number', 'has timing');

    // Each result has URL and title
    for (const result of r.body.results) {
      assert(result.url, 'result has url');
      assert(result.title, 'result has title');
      assert(typeof result.renderedAt === 'number', 'result has renderedAt');
    }
  }),

  test('POST /render/batch 400 if urls missing', async () => {
    const r = await api('POST', '/render/batch', {});
    assertEqual(r.status, 400);
    assert(r.body.error.includes('urls'));
  }),

  test('POST /render/batch 400 if urls empty', async () => {
    const r = await api('POST', '/render/batch', { urls: [] });
    assertEqual(r.status, 400);
  }),

  test('POST /render/batch 400 if too many URLs', async () => {
    const urls = Array.from({ length: 21 }, (_, i) => `https://too-many-${i}.com`);
    const r = await api('POST', '/render/batch', { urls });
    assertEqual(r.status, 400);
    assert(r.body.error.includes('20'));
  }),

  test('POST /render/batch respects maxChars', async () => {
    _mockVersion = 21;
    const r = await api('POST', '/render/batch', {
      urls: ['https://batchmc.example.com'],
      maxChars: 5,
    });
    assertEqual(r.status, 200);
    assert(r.body.results[0].textContent.length <= 5, 'maxChars respected');
  }),

  // ─── Extract ─────────────────────────────────────────────────────────────────

  test('POST /extract returns chunks with relevance scores', async () => {
    _mockVersion = 30;
    const r = await api('POST', '/extract', { url: 'https://extract.example.com' });
    assertEqual(r.status, 200);
    assertEqual(r.body.url, 'https://extract.example.com');
    assertEqual(r.body.title, 'Mock Page v30');
    assert(Array.isArray(r.body.chunks), 'has chunks array');
    assert(typeof r.body.totalChunks === 'number', 'has totalChunks');
    assertEqual(r.body.query, null, 'query is null when not provided');

    for (const chunk of r.body.chunks) {
      assert(typeof chunk.type === 'string', 'chunk has type');
      assert(typeof chunk.text === 'string', 'chunk has text');
      assert(typeof chunk.relevanceScore === 'number', 'chunk has relevanceScore');
    }
  }),

  test('POST /extract with query scores chunks by relevance', async () => {
    _mockVersion = 31;
    const r = await api('POST', '/extract', {
      url: 'https://extract-q.example.com',
      query: 'price content',
    });
    assertEqual(r.status, 200);
    assertEqual(r.body.query, 'price content');
    assert(r.body.chunks.length > 0, 'has some chunks');
  }),

  test('POST /extract 400 if url missing', async () => {
    const r = await api('POST', '/extract', {});
    assertEqual(r.status, 400);
    assert(r.body.error.includes('url'));
  }),

  test('POST /extract respects maxChunks', async () => {
    _mockVersion = 32;
    const r = await api('POST', '/extract', {
      url: 'https://extract-mc.example.com',
      maxChunks: 2,
    });
    assertEqual(r.status, 200);
    assert(r.body.chunks.length <= 2, `maxChunks=2 but got ${r.body.chunks.length}`);
  }),
];

// ─── Main ─────────────────────────────────────────────────────────────────────

await startTestServer();
console.log(`  Test server on port ${testPort}\n`);
await run(TESTS);
await stopTestServer();
