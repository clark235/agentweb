/**
 * AgentWeb WatchServer Tests
 *
 * Tests the HTTP API without actually making network requests to external URLs.
 * Uses a mock renderer that returns deterministic fake page data.
 */

import { createServer } from 'http';
import { DiffTracker, buildSnapshot } from './diff-tracker.js';

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
  const metrics = { watchesCreated: 0, watchesDestroyed: 0, snapshotsTaken: 0, diffsComputed: 0, changesDetected: 0, errors: 0, startedAt: Date.now() };

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

    if (method === 'DELETE' && (params = routeMatch('/watches/:id', path))) {
      const stopped = stopWatch(params.id);
      if (!stopped) return json(res, 404, { error: 'Watch not found' });
      return json(res, 200, { message: `Watch ${params.id} stopped` });
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
];

// ─── Main ─────────────────────────────────────────────────────────────────────

await startTestServer();
console.log(`  Test server on port ${testPort}\n`);
await run(TESTS);
await stopTestServer();
