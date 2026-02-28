/**
 * AgentWeb Watch Server
 *
 * HTTP server that exposes DiffTracker as a REST API.
 * Agents can register page watches, get diffs, and subscribe to change events
 * — all via HTTP, from any language.
 *
 * Usage:
 *   node prototype/watch-server.js [--port=7376] [--interval=60000]
 *
 * API:
 *   GET  /health                         → server status + watcher count
 *   GET  /watches                        → list all active watches
 *   POST /watches                        → register a new watch
 *   GET  /watches/:id                    → get watch status + last diff
 *   DELETE /watches/:id                  → stop a watch
 *   POST /watches/:id/snapshot           → take an immediate snapshot
 *   POST /watches/:id/baseline           → set current snapshot as new baseline
 *   GET  /watches/:id/diff               → get current diff vs baseline
 *   GET  /events                         → SSE stream of all change events
 *   GET  /watches/:id/events             → SSE stream for a specific watch
 *   GET  /metrics                        → Prometheus-style counters
 */

import { createServer } from 'http';
import { DiffTracker } from './diff-tracker.js';
import { render } from './smart-renderer.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const PORT = parseInt(args.find(a => a.startsWith('--port='))?.slice(7) || process.env.AGENTWEB_PORT || '7376', 10);
const DEFAULT_INTERVAL = parseInt(args.find(a => a.startsWith('--interval='))?.slice(11) || '60000', 10);
const HOST = '127.0.0.1'; // local only by default

// ─── State ───────────────────────────────────────────────────────────────────

const tracker = new DiffTracker({ render });

/** @type {Map<string, WatchRecord>} */
const watches = new Map();

/** @type {Set<import('http').ServerResponse>} SSE clients for /events */
const globalSseClients = new Set();

/** @type {Map<string, Set<import('http').ServerResponse>>} SSE per watch */
const watchSseClients = new Map();

const metrics = {
  watchesCreated: 0,
  watchesDestroyed: 0,
  snapshotsTaken: 0,
  diffsComputed: 0,
  changesDetected: 0,
  errors: 0,
  sseConnections: 0,
  startedAt: Date.now(),
};

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} WatchRecord
 * @property {string} id
 * @property {string} url
 * @property {number} intervalMs
 * @property {number} createdAt
 * @property {number} lastCheckedAt
 * @property {number} checkCount
 * @property {number} changeCount
 * @property {any|null} lastDiff
 * @property {any|null} baseline
 * @property {string} status  - 'active' | 'paused' | 'error'
 * @property {string|null} lastError
 * @property {Function} stop
 */

// ─── ID Generator ────────────────────────────────────────────────────────────

let _idCounter = 0;
function newId() {
  return `w${Date.now().toString(36)}${(++_idCounter).toString(36)}`;
}

// ─── Watch Management ────────────────────────────────────────────────────────

function createWatch({ url, intervalMs = DEFAULT_INTERVAL, label = null }) {
  const id = newId();
  metrics.watchesCreated++;

  const record = {
    id,
    url,
    label: label || url,
    intervalMs,
    createdAt: Date.now(),
    lastCheckedAt: null,
    checkCount: 0,
    changeCount: 0,
    lastDiff: null,
    baseline: null,
    status: 'active',
    lastError: null,
    stop: null,
  };

  // Start the watcher
  const watcher = tracker.watch(url, {
    intervalMs,
    onChange: (diff) => {
      record.lastDiff = diff;
      record.lastCheckedAt = Date.now();
      record.checkCount++;
      record.changeCount++;
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
      };

      // Emit to SSE clients
      emitSSE(globalSseClients, event);
      emitSSE(watchSseClients.get(id) || new Set(), event);
    },
  });

  // Capture stop function
  record.stop = () => watcher.stop();

  // Take initial snapshot to establish baseline
  (async () => {
    try {
      const snap = await tracker.snapshot(url);
      record.baseline = snap;
      record.lastCheckedAt = Date.now();
      record.checkCount++;
      metrics.snapshotsTaken++;
    } catch (e) {
      record.status = 'error';
      record.lastError = e.message;
      metrics.errors++;
    }
  })();

  watches.set(id, record);
  return record;
}

function stopWatch(id) {
  const record = watches.get(id);
  if (!record) return false;
  try { record.stop(); } catch {}
  watches.delete(id);
  metrics.watchesDestroyed++;

  // Close SSE clients for this watch
  const clients = watchSseClients.get(id);
  if (clients) {
    for (const c of clients) { try { c.end(); } catch {} }
    watchSseClients.delete(id);
  }
  return true;
}

function serializeWatch(record) {
  return {
    id: record.id,
    url: record.url,
    label: record.label,
    intervalMs: record.intervalMs,
    status: record.status,
    createdAt: record.createdAt,
    lastCheckedAt: record.lastCheckedAt,
    checkCount: record.checkCount,
    changeCount: record.changeCount,
    lastError: record.lastError,
    hasBaseline: !!record.baseline,
    lastDiff: record.lastDiff ? {
      changed: record.lastDiff.changed,
      summary: record.lastDiff.summary,
      changesCount: record.lastDiff.changes?.length ?? 0,
      snapshotAge: record.lastDiff.snapshotAge,
    } : null,
  };
}

// ─── SSE Helpers ─────────────────────────────────────────────────────────────

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(':\n\n'); // comment to open the connection
}

function emitSSE(clients, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.write(payload); } catch { clients.delete(client); }
  }
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function routeMatch(pattern, url) {
  // Simple pattern: /watches/:id/events → match and extract params
  const parts = pattern.split('/');
  const urlParts = url.split('?')[0].split('/');
  if (parts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) {
      params[parts[i].slice(1)] = urlParts[i];
    } else if (parts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

// ─── Request Handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const { method, url } = req;
  const path = url.split('?')[0];

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // ── GET /health ──
  if (method === 'GET' && path === '/health') {
    return json(res, 200, {
      status: 'ok',
      uptime: Date.now() - metrics.startedAt,
      watches: watches.size,
      sseClients: globalSseClients.size,
      metrics,
    });
  }

  // ── GET /metrics ──
  if (method === 'GET' && path === '/metrics') {
    const lines = [
      `# HELP agentweb_watches_created_total Total watches created`,
      `agentweb_watches_created_total ${metrics.watchesCreated}`,
      `# HELP agentweb_watches_active Current active watches`,
      `agentweb_watches_active ${watches.size}`,
      `# HELP agentweb_snapshots_total Total snapshots taken`,
      `agentweb_snapshots_total ${metrics.snapshotsTaken}`,
      `# HELP agentweb_diffs_total Total diffs computed`,
      `agentweb_diffs_total ${metrics.diffsComputed}`,
      `# HELP agentweb_changes_total Total changes detected`,
      `agentweb_changes_total ${metrics.changesDetected}`,
      `# HELP agentweb_errors_total Total errors`,
      `agentweb_errors_total ${metrics.errors}`,
      `# HELP agentweb_uptime_seconds Server uptime in seconds`,
      `agentweb_uptime_seconds ${Math.floor((Date.now() - metrics.startedAt) / 1000)}`,
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(lines.join('\n') + '\n');
  }

  // ── GET /events (global SSE) ──
  if (method === 'GET' && path === '/events') {
    sseHeaders(res);
    globalSseClients.add(res);
    metrics.sseConnections++;
    req.on('close', () => globalSseClients.delete(res));
    // Send heartbeat every 30s to keep connection alive
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); } }, 30_000);
    req.on('close', () => clearInterval(hb));
    return;
  }

  // ── GET /watches ──
  if (method === 'GET' && path === '/watches') {
    return json(res, 200, {
      watches: [...watches.values()].map(serializeWatch),
      count: watches.size,
    });
  }

  // ── POST /watches ──
  if (method === 'POST' && path === '/watches') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!body.url) return json(res, 400, { error: 'url is required' });

    const record = createWatch({
      url: body.url,
      intervalMs: body.intervalMs || DEFAULT_INTERVAL,
      label: body.label || null,
    });

    return json(res, 201, { watch: serializeWatch(record), message: `Watching ${body.url}` });
  }

  // ── Routes with :id ──────────────────────────────────────────────────────

  let params;

  // GET /watches/:id/events (watch-specific SSE)
  if (method === 'GET' && (params = routeMatch('/watches/:id/events', path))) {
    const record = watches.get(params.id);
    if (!record) return json(res, 404, { error: 'Watch not found' });

    sseHeaders(res);
    if (!watchSseClients.has(params.id)) watchSseClients.set(params.id, new Set());
    watchSseClients.get(params.id).add(res);
    metrics.sseConnections++;
    req.on('close', () => watchSseClients.get(params.id)?.delete(res));
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); } }, 30_000);
    req.on('close', () => clearInterval(hb));
    return;
  }

  // GET /watches/:id/diff
  if (method === 'GET' && (params = routeMatch('/watches/:id/diff', path))) {
    const record = watches.get(params.id);
    if (!record) return json(res, 404, { error: 'Watch not found' });
    if (!record.baseline) return json(res, 202, { message: 'Baseline not yet established, check back soon' });

    try {
      const diff = await tracker.diff(record.url, record.baseline);
      record.lastDiff = diff;
      record.lastCheckedAt = Date.now();
      record.checkCount++;
      metrics.diffsComputed++;
      if (diff.changed) { record.changeCount++; metrics.changesDetected++; }
      return json(res, 200, {
        watchId: record.id,
        ...diff,
        baseline: undefined, // omit heavy snapshot data
        current: undefined,
      });
    } catch (e) {
      metrics.errors++;
      return json(res, 500, { error: e.message });
    }
  }

  // POST /watches/:id/snapshot
  if (method === 'POST' && (params = routeMatch('/watches/:id/snapshot', path))) {
    const record = watches.get(params.id);
    if (!record) return json(res, 404, { error: 'Watch not found' });

    try {
      const snap = await tracker.snapshot(record.url);
      record.lastCheckedAt = Date.now();
      record.checkCount++;
      metrics.snapshotsTaken++;
      return json(res, 200, { snapshot: snap });
    } catch (e) {
      metrics.errors++;
      return json(res, 500, { error: e.message });
    }
  }

  // POST /watches/:id/baseline — set current as new baseline
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
    } catch (e) {
      metrics.errors++;
      return json(res, 500, { error: e.message });
    }
  }

  // GET /watches/:id
  if (method === 'GET' && (params = routeMatch('/watches/:id', path))) {
    const record = watches.get(params.id);
    if (!record) return json(res, 404, { error: 'Watch not found' });
    return json(res, 200, { watch: serializeWatch(record) });
  }

  // DELETE /watches/:id
  if (method === 'DELETE' && (params = routeMatch('/watches/:id', path))) {
    const stopped = stopWatch(params.id);
    if (!stopped) return json(res, 404, { error: 'Watch not found' });
    return json(res, 200, { message: `Watch ${params.id} stopped and removed` });
  }

  // ── 404 ──
  return json(res, 404, {
    error: 'Not found',
    endpoints: [
      'GET  /health',
      'GET  /metrics',
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

// ─── Server Startup ───────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    metrics.errors++;
    console.error('[WatchServer] Unhandled error:', e);
    try { json(res, 500, { error: 'Internal server error' }); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[AgentWeb WatchServer] Listening on http://${HOST}:${PORT}`);
  console.log(`  Default poll interval: ${DEFAULT_INTERVAL}ms`);
  console.log(`  Endpoints:`);
  console.log(`    POST   http://${HOST}:${PORT}/watches           → create watch`);
  console.log(`    GET    http://${HOST}:${PORT}/watches           → list watches`);
  console.log(`    GET    http://${HOST}:${PORT}/watches/:id/diff  → get diff`);
  console.log(`    GET    http://${HOST}:${PORT}/events            → SSE change stream`);
  console.log(`    GET    http://${HOST}:${PORT}/health            → status`);
});

// Graceful shutdown
function shutdown() {
  console.log('\n[WatchServer] Shutting down...');
  for (const [id] of watches) stopWatch(id);
  server.close(() => { console.log('[WatchServer] Stopped.'); process.exit(0); });
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { server };
