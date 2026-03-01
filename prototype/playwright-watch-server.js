/**
 * AgentWeb Playwright Watch Server
 *
 * Same HTTP API as watch-server.js, but uses a real headless Chromium browser
 * (via Playwright) instead of the lite HTTP renderer. This means it correctly
 * renders SPAs, React/Vue/Angular pages, lazy-loaded content, and anything
 * that requires JavaScript execution.
 *
 * Usage:
 *   node prototype/playwright-watch-server.js [--port=7377] [--interval=60000]
 *
 * Extra options vs watch-server:
 *   --port=7377          HTTP port (default: 7377, separate from lite server on 7376)
 *   --interval=60000     Default poll interval in ms
 *   --headless=false     Show browser window (debug)
 *   --timeout=30000      Playwright page load timeout in ms
 *   --wait-until=load    Playwright waitUntil strategy (load|domcontentloaded|networkidle)
 *
 * Same REST API:
 *   GET  /health
 *   GET  /watches
 *   POST /watches           { url, intervalMs?, label?, waitForSelector?, waitMs? }
 *   GET  /watches/:id
 *   DELETE /watches/:id
 *   POST /watches/:id/snapshot
 *   POST /watches/:id/baseline
 *   GET  /watches/:id/diff
 *   GET  /events            SSE: all change events
 *   GET  /watches/:id/events  SSE: per-watch change events
 *   GET  /metrics
 *   GET  /browser           Browser status (pid, contexts, version)
 *   POST /browser/restart   Force-restart the browser instance
 *
 * Why two ports?
 *   The lite server (7376) is always fast/cheap. The Playwright server (7377)
 *   starts a browser — heavier, but works on any page. Run both and agents can
 *   pick the right renderer for each URL.
 *
 * @module playwright-watch-server
 */

import { createServer } from 'http';
import { PlaywrightDiffTracker, formatDiff } from './playwright-diff.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function argVal(prefix) {
  const a = args.find(a => a.startsWith(prefix));
  return a ? a.slice(prefix.length) : null;
}

const PORT           = parseInt(argVal('--port=')     || process.env.AGENTWEB_PW_PORT  || '7377', 10);
const DEFAULT_INTV   = parseInt(argVal('--interval=') || '60000', 10);
const HEADLESS       = argVal('--headless=') !== 'false';
const PW_TIMEOUT     = parseInt(argVal('--timeout=')  || '30000', 10);
const WAIT_UNTIL     = argVal('--wait-until=') || 'networkidle';
const HOST           = '127.0.0.1';

// ─── State ───────────────────────────────────────────────────────────────────

/** @type {PlaywrightDiffTracker} */
let tracker = null;

/** @type {Map<string, WatchRecord>} */
const watches = new Map();

/** @type {Set<import('http').ServerResponse>} SSE global clients */
const globalSseClients = new Set();

/** @type {Map<string, Set<import('http').ServerResponse>>} SSE per-watch clients */
const watchSseClients = new Map();

const metrics = {
  watchesCreated: 0,
  watchesDestroyed: 0,
  snapshotsTaken: 0,
  diffsComputed: 0,
  changesDetected: 0,
  browserRestarts: 0,
  errors: 0,
  sseConnections: 0,
  startedAt: Date.now(),
};

// ─── Browser / Tracker Lifecycle ─────────────────────────────────────────────

async function getTracker() {
  if (!tracker) {
    tracker = new PlaywrightDiffTracker({
      headless: HEADLESS,
      timeout: PW_TIMEOUT,
      waitUntil: WAIT_UNTIL,
    });
  }
  return tracker;
}

async function restartBrowser() {
  console.log('[PlaywrightWatchServer] Restarting browser...');
  if (tracker) {
    try { await tracker.close(); } catch {}
    tracker = null;
  }
  metrics.browserRestarts++;
  await getTracker();
  console.log('[PlaywrightWatchServer] Browser restarted.');
}

// ─── ID Generator ────────────────────────────────────────────────────────────

let _idCtr = 0;
function newId() {
  return `pw${Date.now().toString(36)}${(++_idCtr).toString(36)}`;
}

// ─── SSE Helpers ─────────────────────────────────────────────────────────────

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
}

function emitSSE(clients, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.write(payload); } catch { clients.delete(client); }
  }
}

function keepAlive(res) {
  const iv = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(iv); }
  }, 25_000);
  res.on('close', () => clearInterval(iv));
  return iv;
}

// ─── Watch Record ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} WatchRecord
 * @property {string} id
 * @property {string} url
 * @property {string} label
 * @property {number} intervalMs
 * @property {object} renderOpts  - waitForSelector, waitMs passed to Playwright
 * @property {'active'|'paused'|'error'} status
 * @property {number} createdAt
 * @property {number|null} lastCheckedAt
 * @property {number} checkCount
 * @property {number} changeCount
 * @property {any|null} lastDiff
 * @property {string|null} lastError
 * @property {Function} stop
 */

function serializeWatch(r) {
  return {
    id: r.id,
    url: r.url,
    label: r.label,
    intervalMs: r.intervalMs,
    renderOpts: r.renderOpts,
    status: r.status,
    createdAt: r.createdAt,
    lastCheckedAt: r.lastCheckedAt,
    checkCount: r.checkCount,
    changeCount: r.changeCount,
    lastError: r.lastError,
    hasBaseline: r.hasBaseline,
    lastDiff: r.lastDiff ? {
      changed: r.lastDiff.changed,
      summary: r.lastDiff.summary,
      changesCount: r.lastDiff.changes?.length ?? 0,
      snapshotAge: r.lastDiff.snapshotAge,
    } : null,
    renderer: 'playwright',
  };
}

// ─── Watch Lifecycle ──────────────────────────────────────────────────────────

async function createWatch({ url, intervalMs = DEFAULT_INTV, label = null, waitForSelector = null, waitMs = 0 }) {
  const id = newId();
  metrics.watchesCreated++;

  const renderOpts = {};
  if (waitForSelector) renderOpts.waitForSelector = waitForSelector;
  if (waitMs > 0) renderOpts.waitMs = waitMs;

  /** @type {WatchRecord} */
  const record = {
    id,
    url,
    label: label || url,
    intervalMs,
    renderOpts,
    status: 'active',
    createdAt: Date.now(),
    lastCheckedAt: null,
    checkCount: 0,
    changeCount: 0,
    lastDiff: null,
    lastError: null,
    hasBaseline: false,
    stop: null,
  };

  const t = await getTracker();

  // Take initial baseline — snapshot with renderOpts, then store as baseline
  try {
    const snap = await t.snapshot(url, renderOpts);
    await t.setBaseline(url, snap);
    record.hasBaseline = true;
    record.lastCheckedAt = Date.now();
    record.checkCount++;
    metrics.snapshotsTaken++;
    console.log(`[Watch ${id}] Baseline set for ${url}`);
  } catch (e) {
    record.status = 'error';
    record.lastError = e.message;
    metrics.errors++;
    console.error(`[Watch ${id}] Baseline failed: ${e.message}`);
  }

  // Start polling watcher
  // DiffTracker.watch() signature: (url, { intervalMs, onChange, onError, emitUnchanged, renderOptions })
  const watcher = t.watch(url, {
    intervalMs,
    renderOptions: renderOpts,
    emitUnchanged: true,  // so we can track checkCount on every poll
    onChange: (diff) => {
      record.lastCheckedAt = Date.now();
      record.checkCount++;
      metrics.snapshotsTaken++;

      if (!diff.changed) return;  // emitUnchanged=true means we get no-change diffs too

      record.lastDiff = diff;
      record.changeCount++;
      record.hasBaseline = true;
      metrics.diffsComputed++;
      metrics.changesDetected++;

      const event = {
        type: 'change',
        watchId: id,
        url,
        label: record.label,
        timestamp: Date.now(),
        summary: diff.summary,
        changes: diff.changes,
        changesCount: diff.changes.length,
        formattedDiff: formatDiff(diff),
        renderer: 'playwright',
      };

      emitSSE(globalSseClients, event);
      emitSSE(watchSseClients.get(id) || new Set(), event);

      console.log(`[Watch ${id}] Change detected: ${diff.summary}`);
    },
    onError: (e) => {
      record.lastError = e.message;
      record.status = 'error';
      metrics.errors++;
      console.error(`[Watch ${id}] Error: ${e.message}`);

      // Emit error event to SSE clients
      emitSSE(globalSseClients, { type: 'error', watchId: id, url, error: e.message });
      emitSSE(watchSseClients.get(id) || new Set(), { type: 'error', watchId: id, url, error: e.message });
    },
  });

  record.stop = () => watcher.stop();
  watches.set(id, record);

  console.log(`[Watch ${id}] Created — ${url} every ${intervalMs}ms`);
  return record;
}

function stopWatch(id) {
  const record = watches.get(id);
  if (!record) return false;
  try { record.stop(); } catch {}
  watches.delete(id);
  metrics.watchesDestroyed++;

  const clients = watchSseClients.get(id);
  if (clients) {
    for (const c of clients) { try { c.end(); } catch {} }
    watchSseClients.delete(id);
  }
  console.log(`[Watch ${id}] Stopped`);
  return true;
}

// ─── Router ──────────────────────────────────────────────────────────────────

function routeMatch(pattern, path) {
  const patParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// ─── Request Handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const method = req.method;
  const url = new URL(req.url, `http://${HOST}`);
  const path = url.pathname;
  let params;

  // ── GET /health ──
  if (method === 'GET' && path === '/health') {
    const t = await getTracker();
    let browserInfo = null;
    try {
      browserInfo = await t.browserStatus();
    } catch {}

    return json(res, 200, {
      status: 'ok',
      renderer: 'playwright',
      uptime: Date.now() - metrics.startedAt,
      watches: watches.size,
      sseClients: globalSseClients.size,
      browser: browserInfo,
      metrics: { ...metrics, uptime: Date.now() - metrics.startedAt },
    });
  }

  // ── GET /metrics ──
  if (method === 'GET' && path === '/metrics') {
    const lines = Object.entries(metrics).map(([k, v]) => `agentweb_${k} ${v}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(lines.join('\n') + '\n');
  }

  // ── GET /browser ──
  if (method === 'GET' && path === '/browser') {
    const t = await getTracker();
    try {
      const info = await t.browserStatus();
      return json(res, 200, { renderer: 'playwright', ...info });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /browser/restart ──
  if (method === 'POST' && path === '/browser/restart') {
    try {
      await restartBrowser();
      return json(res, 200, { message: 'Browser restarted', restarts: metrics.browserRestarts });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /events (global SSE) ──
  if (method === 'GET' && path === '/events') {
    sseHeaders(res);
    globalSseClients.add(res);
    metrics.sseConnections++;
    keepAlive(res);
    res.on('close', () => { globalSseClients.delete(res); });
    return;
  }

  // ── GET /watches ──
  if (method === 'GET' && path === '/watches') {
    return json(res, 200, {
      watches: Array.from(watches.values()).map(serializeWatch),
      total: watches.size,
      renderer: 'playwright',
    });
  }

  // ── POST /watches ──
  if (method === 'POST' && path === '/watches') {
    const body = await parseBody(req);
    if (!body.url) return json(res, 400, { error: 'url is required' });

    try {
      const record = await createWatch({
        url: body.url,
        intervalMs: body.intervalMs,
        label: body.label,
        waitForSelector: body.waitForSelector || null,
        waitMs: body.waitMs || 0,
      });
      return json(res, 201, { watch: serializeWatch(record) });
    } catch (e) {
      metrics.errors++;
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /watches/:id/events (per-watch SSE) ──
  if (method === 'GET' && (params = routeMatch('/watches/:id/events', path))) {
    const record = watches.get(params.id);
    if (!record) return json(res, 404, { error: 'Watch not found' });

    sseHeaders(res);
    if (!watchSseClients.has(params.id)) watchSseClients.set(params.id, new Set());
    watchSseClients.get(params.id).add(res);
    metrics.sseConnections++;
    keepAlive(res);
    res.on('close', () => { watchSseClients.get(params.id)?.delete(res); });
    return;
  }

  // ── POST /watches/:id/snapshot ──
  if (method === 'POST' && (params = routeMatch('/watches/:id/snapshot', path))) {
    const record = watches.get(params.id);
    if (!record) return json(res, 404, { error: 'Watch not found' });

    try {
      const t = await getTracker();
      const snap = await t.renderer.render(record.url, record.renderOpts);
      record.lastCheckedAt = Date.now();
      record.checkCount++;
      metrics.snapshotsTaken++;
      return json(res, 200, { snapshot: snap, timestamp: snap.fetchedAt });
    } catch (e) {
      metrics.errors++;
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /watches/:id/baseline ──
  if (method === 'POST' && (params = routeMatch('/watches/:id/baseline', path))) {
    const record = watches.get(params.id);
    if (!record) return json(res, 404, { error: 'Watch not found' });

    try {
      const t = await getTracker();
      const snap = await t.snapshot(record.url, record.renderOpts);
      await t.setBaseline(record.url, snap);
      record.hasBaseline = true;
      record.lastCheckedAt = Date.now();
      record.checkCount++;
      metrics.snapshotsTaken++;
      return json(res, 200, { message: 'Baseline updated', timestamp: Date.now() });
    } catch (e) {
      metrics.errors++;
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /watches/:id/diff ──
  if (method === 'GET' && (params = routeMatch('/watches/:id/diff', path))) {
    const record = watches.get(params.id);
    if (!record) return json(res, 404, { error: 'Watch not found' });

    try {
      const t = await getTracker();
      // diff(url, baseline?, renderOptions?) — pass undefined for baseline to use stored one
      const diff = await t.diff(record.url, undefined, record.renderOpts);
      record.lastDiff = diff;
      record.lastCheckedAt = Date.now();
      metrics.diffsComputed++;
      return json(res, 200, {
        watchId: params.id,
        diff,
        formattedDiff: formatDiff(diff),
        renderer: 'playwright',
      });
    } catch (e) {
      metrics.errors++;
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /watches/:id ──
  if (method === 'GET' && (params = routeMatch('/watches/:id', path))) {
    const record = watches.get(params.id);
    if (!record) return json(res, 404, { error: 'Watch not found' });
    return json(res, 200, { watch: serializeWatch(record) });
  }

  // ── DELETE /watches/:id ──
  if (method === 'DELETE' && (params = routeMatch('/watches/:id', path))) {
    const stopped = stopWatch(params.id);
    if (!stopped) return json(res, 404, { error: 'Watch not found' });
    return json(res, 200, { message: `Watch ${params.id} stopped` });
  }

  // ── 404 ──
  return json(res, 404, {
    error: 'Not found',
    renderer: 'playwright',
    endpoints: [
      'GET  /health',
      'GET  /metrics',
      'GET  /browser',
      'POST /browser/restart',
      'GET  /events',
      'GET  /watches',
      'POST /watches',
      'GET  /watches/:id',
      'DELETE /watches/:id',
      'POST /watches/:id/snapshot',
      'POST /watches/:id/baseline',
      'GET  /watches/:id/diff',
      'GET  /watches/:id/events',
    ],
  });
}

// ─── Browser Status Helper ────────────────────────────────────────────────────
// Patch PlaywrightDiffTracker to expose browser status info

// Expose browser status via the internal _renderer reference
PlaywrightDiffTracker.prototype.browserStatus = async function () {
  const browser = this._renderer?._browser;
  if (!browser) return { connected: false };
  try {
    const version = browser.version();
    const contexts = browser.contexts().length;
    return { connected: browser.isConnected(), version, contexts };
  } catch {
    return { connected: false };
  }
};

// ─── Server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    metrics.errors++;
    console.error('[PlaywrightWatchServer] Unhandled error:', e);
    try { json(res, 500, { error: 'Internal server error' }); } catch {}
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  // Pre-warm the browser before accepting connections
  console.log('[PlaywrightWatchServer] Starting Playwright browser...');
  try {
    await getTracker();
    console.log('[PlaywrightWatchServer] Browser ready.');
  } catch (e) {
    console.error('[PlaywrightWatchServer] Warning: browser pre-warm failed:', e.message);
    console.error('  The server will still start; browser will be launched on first request.');
  }

  server.listen(PORT, HOST, () => {
    console.log(`\n[AgentWeb PlaywrightWatchServer] 🎭 Listening on http://${HOST}:${PORT}`);
    console.log(`  Renderer: Playwright (headless Chromium)`);
    console.log(`  Default poll interval: ${DEFAULT_INTV}ms`);
    console.log(`  Headless: ${HEADLESS}`);
    console.log(`  Endpoints:`);
    console.log(`    POST   http://${HOST}:${PORT}/watches           → create watch`);
    console.log(`    GET    http://${HOST}:${PORT}/watches           → list watches`);
    console.log(`    GET    http://${HOST}:${PORT}/watches/:id/diff  → get diff`);
    console.log(`    GET    http://${HOST}:${PORT}/events            → SSE change stream`);
    console.log(`    GET    http://${HOST}:${PORT}/health            → status + browser info`);
    console.log(`    POST   http://${HOST}:${PORT}/browser/restart   → restart Chromium`);
    console.log('');
  });
}

main().catch(e => {
  console.error('[PlaywrightWatchServer] Fatal startup error:', e);
  process.exit(1);
});

// Graceful shutdown
async function shutdown() {
  console.log('\n[PlaywrightWatchServer] Shutting down...');
  for (const [id] of watches) stopWatch(id);

  if (tracker) {
    try { await tracker.close(); } catch {}
  }

  server.close(() => {
    console.log('[PlaywrightWatchServer] Stopped.');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { server };
