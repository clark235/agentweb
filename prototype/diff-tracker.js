/**
 * AgentWeb Diff Tracker
 *
 * Snapshots pages at intervals and emits semantic diffs when content changes.
 * Built for agents that need to watch pages for updates without polling the raw DOM.
 *
 * Designed around what *agents care about*:
 *   - Did the main content change? (article text, product info, etc.)
 *   - Did prices, numbers, or key data change?
 *   - Did links appear or disappear?
 *   - Did forms or interactive elements change?
 *   - Did headings change? (title, section structure)
 *
 * Not built for:
 *   - Pixel-perfect visual diffs (use screenshot diffing for that)
 *   - DOM attribute tracking (too noisy, too brittle)
 *   - Full text diffs (too verbose for agent consumption)
 *
 * ## Usage
 *
 *   import { DiffTracker } from './diff-tracker.js';
 *
 *   const tracker = new DiffTracker({ render });
 *
 *   // One-shot: compare two snapshots
 *   const snap1 = await tracker.snapshot('https://news.ycombinator.com');
 *   // ... wait a bit ...
 *   const diff = await tracker.diff('https://news.ycombinator.com', snap1);
 *   // → { changed: true, changes: [...], summary: "..." }
 *
 *   // Watch mode: poll and emit when something changes
 *   const watcher = tracker.watch('https://news.ycombinator.com', {
 *     intervalMs: 60_000,
 *     onChange: (diff) => console.log('Page changed:', diff.summary),
 *   });
 *   await watcher.stop();
 *
 * @module diff-tracker
 */

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────
/**
 * @typedef {object} PageSnapshot
 * @property {string} url
 * @property {number} timestamp
 * @property {string} title
 * @property {string[]} headings       - h1-h6 texts, in order
 * @property {LinkEntry[]} links       - visible links with text + href
 * @property {FormEntry[]} forms       - forms with field names
 * @property {string} textFingerprint  - hash of normalized text content
 * @property {string[]} numbers        - all numeric values found in page text
 * @property {string} textSample       - first 2000 chars of main content
 * @property {object} stats            - interactiveCount, formCount, linkCount, wordCount
 */

/**
 * @typedef {object} LinkEntry
 * @property {string} text
 * @property {string} href
 */

/**
 * @typedef {object} FormEntry
 * @property {string} id
 * @property {string[]} fields
 */

/**
 * @typedef {object} DiffResult
 * @property {boolean} changed
 * @property {string} url
 * @property {number} snapshotAge       - ms since the baseline snapshot
 * @property {Change[]} changes         - list of detected changes
 * @property {string} summary           - human-readable summary for agents
 * @property {PageSnapshot} baseline    - original snapshot
 * @property {PageSnapshot} current     - new snapshot
 */

/**
 * @typedef {object} Change
 * @property {string} type   - 'title'|'headings'|'links_added'|'links_removed'|'numbers'|'text_fingerprint'|'forms'|'stats'
 * @property {string} label  - human-readable change description
 * @property {'low'|'medium'|'high'} severity
 * @property {*} before
 * @property {*} after
 */

// ─── Fingerprinting ───────────────────────────────────────────────────────────

/**
 * A deterministic, fast string hash (djb2-style).
 * Not cryptographic — just good enough to detect changes.
 * @param {string} str
 * @returns {string} hex-ish hash string
 */
function quickHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0; // keep as unsigned 32-bit
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Normalize text for comparison:
 * - lowercase
 * - collapse whitespace
 * - remove punctuation that commonly changes without meaningful content shift
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[""'']/g, '"')
    .trim();
}

/**
 * Extract all numeric values from text.
 * Captures prices, counts, percentages, etc.
 * @param {string} text
 * @returns {string[]}
 */
function extractNumbers(text) {
  const matches = text.match(/\$?[\d,]+(?:\.\d+)?%?/g) ?? [];
  return [...new Set(matches.filter(m => m.replace(/[,$%]/g, '').length > 0))].sort();
}

// ─── Snapshot Building ────────────────────────────────────────────────────────

/**
 * Convert a raw AgentWeb render result into a DiffTracker snapshot.
 * Works with any render backend (lite-renderer or playwright output).
 *
 * @param {string} url
 * @param {object} renderResult - output from render(), renderLite(), etc.
 * @returns {PageSnapshot}
 */
export function buildSnapshot(url, renderResult) {
  const data = renderResult.data ?? renderResult; // support both { backend, data } and raw

  const title = (data.title ?? '').trim();

  const headings = (data.headings ?? []).map(h =>
    typeof h === 'string' ? h : h.text ?? ''
  ).filter(Boolean);

  const links = (data.interactives ?? data.links ?? [])
    .filter(el => el.tag === 'a' || el.href)
    .map(el => ({ text: (el.text ?? '').trim().slice(0, 100), href: el.href ?? '' }))
    .filter(l => l.href && !l.href.startsWith('javascript:'));

  const forms = (data.forms ?? []).map((f, i) => ({
    id: f.id ?? f.action ?? `form-${i}`,
    fields: (f.fields ?? []).map(fld => fld.name ?? fld.id ?? fld.placeholder ?? '').filter(Boolean),
  }));

  const rawText = data.textContent ?? data.content ?? '';
  const textSample = rawText.slice(0, 2000);
  const textFingerprint = quickHash(normalizeText(rawText.slice(0, 10000)));
  const numbers = extractNumbers(rawText.slice(0, 20000));

  const stats = {
    interactiveCount: data.stats?.interactiveCount ?? data.interactives?.length ?? 0,
    formCount: data.stats?.formCount ?? forms.length,
    linkCount: links.length,
    wordCount: rawText.split(/\s+/).filter(Boolean).length,
  };

  return {
    url,
    timestamp: Date.now(),
    title,
    headings,
    links,
    forms,
    textFingerprint,
    numbers,
    textSample,
    stats,
  };
}

// ─── Diff Computation ─────────────────────────────────────────────────────────

/**
 * Compare two snapshots and return a structured diff.
 *
 * @param {PageSnapshot} baseline
 * @param {PageSnapshot} current
 * @returns {DiffResult}
 */
export function computeDiff(baseline, current) {
  const changes = [];

  // ── Title ──────────────────────────────────────────────────────────────────
  if (baseline.title !== current.title) {
    changes.push({
      type: 'title',
      label: `Title changed: "${baseline.title}" → "${current.title}"`,
      severity: 'high',
      before: baseline.title,
      after: current.title,
    });
  }

  // ── Headings ───────────────────────────────────────────────────────────────
  const baseHeadStr = baseline.headings.join('|');
  const currHeadStr = current.headings.join('|');
  if (baseHeadStr !== currHeadStr) {
    const added = current.headings.filter(h => !baseline.headings.includes(h));
    const removed = baseline.headings.filter(h => !current.headings.includes(h));
    if (added.length > 0 || removed.length > 0) {
      changes.push({
        type: 'headings',
        label: `Headings changed (${added.length} added, ${removed.length} removed)`,
        severity: 'medium',
        before: baseline.headings,
        after: current.headings,
        added,
        removed,
      });
    }
  }

  // ── Text fingerprint (main content change) ─────────────────────────────────
  if (baseline.textFingerprint !== current.textFingerprint) {
    // Compute word-count delta for severity
    const wordDelta = Math.abs((current.stats.wordCount - baseline.stats.wordCount));
    const pct = baseline.stats.wordCount > 0
      ? Math.round(wordDelta / baseline.stats.wordCount * 100)
      : 100;

    changes.push({
      type: 'text_content',
      label: `Main content changed (~${pct}% word count delta, ${wordDelta} words)`,
      severity: pct >= 20 ? 'high' : pct >= 5 ? 'medium' : 'low',
      before: baseline.textFingerprint,
      after: current.textFingerprint,
      wordDelta,
      percentDelta: pct,
    });
  }

  // ── Numbers (prices, counts, etc.) ─────────────────────────────────────────
  const baseNumSet = new Set(baseline.numbers);
  const currNumSet = new Set(current.numbers);
  const numbersAdded = current.numbers.filter(n => !baseNumSet.has(n));
  const numbersRemoved = baseline.numbers.filter(n => !currNumSet.has(n));

  if (numbersAdded.length > 0 || numbersRemoved.length > 0) {
    changes.push({
      type: 'numbers',
      label: `Numeric values changed (${numbersAdded.length} new, ${numbersRemoved.length} removed)`,
      severity: numbersAdded.length + numbersRemoved.length > 5 ? 'high' : 'medium',
      added: numbersAdded.slice(0, 20),
      removed: numbersRemoved.slice(0, 20),
    });
  }

  // ── Links (added/removed) ──────────────────────────────────────────────────
  const baseHrefs = new Set(baseline.links.map(l => l.href));
  const currHrefs = new Set(current.links.map(l => l.href));

  const linksAdded = current.links.filter(l => !baseHrefs.has(l.href));
  const linksRemoved = baseline.links.filter(l => !currHrefs.has(l.href));

  if (linksAdded.length > 0) {
    changes.push({
      type: 'links_added',
      label: `${linksAdded.length} new link(s) appeared`,
      severity: linksAdded.length >= 5 ? 'medium' : 'low',
      links: linksAdded.slice(0, 10),
    });
  }

  if (linksRemoved.length > 0) {
    changes.push({
      type: 'links_removed',
      label: `${linksRemoved.length} link(s) disappeared`,
      severity: linksRemoved.length >= 5 ? 'medium' : 'low',
      links: linksRemoved.slice(0, 10),
    });
  }

  // ── Forms ──────────────────────────────────────────────────────────────────
  const baseFormIds = new Set(baseline.forms.map(f => f.id));
  const currFormIds = new Set(current.forms.map(f => f.id));
  const formsAdded = current.forms.filter(f => !baseFormIds.has(f.id));
  const formsRemoved = baseline.forms.filter(f => !currFormIds.has(f.id));

  if (formsAdded.length > 0 || formsRemoved.length > 0) {
    changes.push({
      type: 'forms',
      label: `Forms changed (${formsAdded.length} added, ${formsRemoved.length} removed)`,
      severity: 'medium',
      added: formsAdded,
      removed: formsRemoved,
    });
  }

  // ── Build summary ──────────────────────────────────────────────────────────
  const changed = changes.length > 0;
  const snapshotAge = current.timestamp - baseline.timestamp;
  const ageStr = snapshotAge < 60_000
    ? `${Math.round(snapshotAge / 1000)}s`
    : `${Math.round(snapshotAge / 60_000)}m`;

  let summary;
  if (!changed) {
    summary = `No changes detected (snapshot age: ${ageStr})`;
  } else {
    const high = changes.filter(c => c.severity === 'high').length;
    const med = changes.filter(c => c.severity === 'medium').length;
    const low = changes.filter(c => c.severity === 'low').length;
    const labels = changes.map(c => c.label).join('; ');
    summary = `${changes.length} change(s) in ${ageStr} [high=${high} med=${med} low=${low}]: ${labels}`;
  }

  return {
    changed,
    url: current.url,
    snapshotAge,
    changes,
    summary,
    baseline,
    current,
  };
}

// ─── DiffTracker ──────────────────────────────────────────────────────────────

export class DiffTracker {
  /**
   * @param {object} opts
   * @param {Function} opts.render - render(url, options?) → { data: {...} } or raw page data
   * @param {object} [opts.renderOptions] - default options passed to render()
   */
  constructor({ render, renderOptions = {} } = {}) {
    if (!render) throw new Error('DiffTracker requires a render function');
    this._render = render;
    this._renderOptions = renderOptions;

    /** @type {Map<string, PageSnapshot>} */
    this._snapshots = new Map();
  }

  /**
   * Render a URL and return a snapshot (does NOT store it).
   * @param {string} url
   * @param {object} [renderOptions]
   * @returns {Promise<PageSnapshot>}
   */
  async snapshot(url, renderOptions = {}) {
    const result = await this._render(url, { ...this._renderOptions, ...renderOptions });
    return buildSnapshot(url, result);
  }

  /**
   * Store a snapshot as the baseline for a URL.
   * Future diff() calls compare against this.
   * @param {string} url
   * @param {PageSnapshot} [snap] - if omitted, fetches a fresh snapshot
   */
  async setBaseline(url, snap) {
    const snapshot = snap ?? await this.snapshot(url);
    this._snapshots.set(url, snapshot);
    return snapshot;
  }

  /**
   * Get the stored baseline for a URL (or null if none).
   * @param {string} url
   * @returns {PageSnapshot|null}
   */
  getBaseline(url) {
    return this._snapshots.get(url) ?? null;
  }

  /**
   * Compare a URL against a baseline snapshot.
   * If baseline is omitted, uses stored baseline (from setBaseline or previous diff).
   * Updates stored baseline to the new snapshot after diff.
   *
   * @param {string} url
   * @param {PageSnapshot} [baseline] - explicit baseline to compare against
   * @param {object} [renderOptions]
   * @returns {Promise<DiffResult>}
   */
  async diff(url, baseline, renderOptions = {}) {
    const base = baseline ?? this._snapshots.get(url);
    if (!base) {
      throw new Error(`No baseline for ${url} — call setBaseline() first or pass a baseline snapshot`);
    }

    const current = await this.snapshot(url, renderOptions);
    const result = computeDiff(base, current);

    // Update stored baseline to current (rolling window)
    this._snapshots.set(url, current);

    return result;
  }

  /**
   * Watch a URL for changes, calling onChange when a diff is detected.
   *
   * @param {string} url
   * @param {object} opts
   * @param {number} [opts.intervalMs=60000]       - poll interval in ms
   * @param {Function} opts.onChange               - called with DiffResult when changed
   * @param {Function} [opts.onError]              - called with Error if render fails
   * @param {boolean} [opts.emitUnchanged=false]   - also call onChange for no-change polls
   * @param {object} [opts.renderOptions]          - render options
   * @returns {{ stop: Function, url: string }}    - watcher handle
   */
  watch(url, { intervalMs = 60_000, onChange, onError, emitUnchanged = false, renderOptions = {} } = {}) {
    if (!onChange) throw new Error('watch() requires opts.onChange callback');

    let stopped = false;
    let timer = null;
    let pollCount = 0;

    const poll = async () => {
      if (stopped) return;

      try {
        if (!this._snapshots.has(url)) {
          // First poll: just set baseline
          await this.setBaseline(url, undefined);
        } else {
          const result = await this.diff(url, undefined, renderOptions);
          pollCount++;
          if (result.changed || emitUnchanged) {
            onChange(result);
          }
        }
      } catch (e) {
        if (onError) onError(e);
        else console.error(`[DiffTracker] Error watching ${url}:`, e.message);
      }

      if (!stopped) {
        timer = setTimeout(poll, intervalMs);
      }
    };

    // Start immediately
    timer = setTimeout(poll, 0);

    return {
      url,
      get pollCount() { return pollCount; },
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  /**
   * Watch multiple URLs simultaneously.
   * @param {string[]} urls
   * @param {object} opts - same as watch()
   * @returns {{ stop: Function, watchers: object[] }}
   */
  watchAll(urls, opts = {}) {
    const watchers = urls.map(url => this.watch(url, {
      ...opts,
      onChange: (diff) => {
        if (opts.onChange) opts.onChange(diff, url);
      },
    }));

    return {
      watchers,
      stop: () => watchers.forEach(w => w.stop()),
    };
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Format a DiffResult for agent consumption.
 * Returns a compact text representation optimized for LLM context.
 *
 * @param {DiffResult} diff
 * @returns {string}
 */
export function formatDiff(diff) {
  if (!diff.changed) {
    return `✅ No changes at ${diff.url} (checked ${Math.round(diff.snapshotAge / 1000)}s ago)`;
  }

  const lines = [
    `🔄 Changes detected at ${diff.url}`,
    `   Age: ${Math.round(diff.snapshotAge / 1000)}s | Changes: ${diff.changes.length}`,
    '',
  ];

  for (const change of diff.changes) {
    const icon = { high: '🔴', medium: '🟡', low: '🔵' }[change.severity] ?? '⚪';
    lines.push(`${icon} ${change.label}`);

    if (change.type === 'links_added' && change.links?.length) {
      for (const l of change.links.slice(0, 3)) {
        lines.push(`     + ${l.text || l.href}`);
      }
      if (change.links.length > 3) lines.push(`     ... and ${change.links.length - 3} more`);
    }

    if (change.type === 'links_removed' && change.links?.length) {
      for (const l of change.links.slice(0, 3)) {
        lines.push(`     - ${l.text || l.href}`);
      }
    }

    if (change.type === 'numbers' && (change.added?.length || change.removed?.length)) {
      if (change.added?.length) lines.push(`     + ${change.added.slice(0, 5).join(', ')}`);
      if (change.removed?.length) lines.push(`     - ${change.removed.slice(0, 5).join(', ')}`);
    }

    if (change.type === 'headings' && (change.added?.length || change.removed?.length)) {
      if (change.added?.length) lines.push(`     + "${change.added[0]}"${change.added.length > 1 ? ` +${change.added.length - 1} more` : ''}`);
      if (change.removed?.length) lines.push(`     - "${change.removed[0]}"${change.removed.length > 1 ? ` +${change.removed.length - 1} more` : ''}`);
    }
  }

  return lines.join('\n');
}

export default DiffTracker;
