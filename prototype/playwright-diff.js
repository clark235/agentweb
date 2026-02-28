/**
 * AgentWeb — Playwright-Backed DiffTracker
 *
 * Combines the full Playwright renderer (renderer.js) with DiffTracker
 * so agents can watch real SPA pages — not just static HTML.
 *
 * The lite renderer (lite-renderer.js) uses HTTP + cheerio and is fast but
 * misses JavaScript-rendered content. This module uses a real headless
 * Chromium browser, so it captures:
 *   - React / Vue / Angular SPAs
 *   - Lazy-loaded content
 *   - Dynamically injected links and numbers
 *   - Content behind soft auth (if you supply cookies)
 *
 * ## Usage
 *
 *   import { PlaywrightDiffTracker, watchPage, diffPages } from './playwright-diff.js';
 *
 *   // High-level one-shot diff
 *   const { diff, close } = await diffPages('https://example.com');
 *   console.log(diff.summary);
 *   await close();
 *
 *   // Watch with callback
 *   const tracker = new PlaywrightDiffTracker();
 *   await tracker.setBaseline('https://news.ycombinator.com');
 *
 *   const watcher = tracker.watch('https://news.ycombinator.com', {
 *     intervalMs: 5 * 60_000,
 *     onChange: (diff) => console.log(formatDiff(diff)),
 *   });
 *
 *   // Stop after 30 minutes
 *   setTimeout(() => watcher.stop(), 30 * 60_000);
 *   await tracker.close();
 *
 * @module playwright-diff
 */

import { chromium } from 'playwright';
import { DiffTracker, buildSnapshot, computeDiff, formatDiff } from './diff-tracker.js';

export { buildSnapshot, computeDiff, formatDiff };

// ─── PlaywrightRenderer ───────────────────────────────────────────────────────

/**
 * Lightweight wrapper around a persistent Playwright browser instance.
 * Reuses one browser for all renders (much faster than launching per-call).
 */
export class PlaywrightRenderer {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.headless=true]
   * @param {number} [opts.timeout=30000]          - page navigation timeout in ms
   * @param {string} [opts.waitUntil='networkidle'] - Playwright waitUntil strategy
   * @param {object} [opts.storageState]            - cookies/localStorage for auth
   * @param {string} [opts.userAgent]
   */
  constructor(opts = {}) {
    this._opts = {
      headless: true,
      timeout: 30_000,
      waitUntil: 'networkidle',
      userAgent: 'AgentWeb/0.2 DiffTracker (Playwright; headless)',
      ...opts,
    };
    this._browser = null;
  }

  async _getBrowser() {
    if (!this._browser) {
      this._browser = await chromium.launch({ headless: this._opts.headless });
    }
    return this._browser;
  }

  /**
   * Render a URL and return structured page data compatible with DiffTracker's
   * buildSnapshot() input format.
   *
   * @param {string} url
   * @param {object} [renderOpts]  - per-call overrides
   * @returns {Promise<object>}    - raw render result (pass to buildSnapshot)
   */
  async render(url, renderOpts = {}) {
    const opts = { ...this._opts, ...renderOpts };
    const browser = await this._getBrowser();

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: opts.userAgent,
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });

    const page = await context.newPage();

    try {
      await page.goto(url, {
        waitUntil: opts.waitUntil,
        timeout: opts.timeout,
      });

      // Optional extra wait for SPAs that are slow to stabilize
      if (opts.waitMs) {
        await page.waitForTimeout(opts.waitMs);
      }

      // Wait for a specific selector to appear (useful for SPAs)
      if (opts.waitForSelector) {
        await page.waitForSelector(opts.waitForSelector, { timeout: opts.timeout });
      }

      const data = await page.evaluate(() => {
        // ── Interactive elements ─────────────────────────────────────────────
        const interactives = [];
        const elements = document.querySelectorAll(
          'a, button, input, select, textarea, [role="button"], [onclick]'
        );
        elements.forEach((el, idx) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          interactives.push({
            id: idx,
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            text: (el.textContent || el.value || '').trim().slice(0, 100),
            href: el.href || null,
            name: el.name || null,
            placeholder: el.placeholder || null,
          });
        });

        // ── Headings ─────────────────────────────────────────────────────────
        const headings = [];
        document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
          const text = h.textContent.trim().slice(0, 200);
          if (text) headings.push({ level: parseInt(h.tagName[1]), text });
        });

        // ── Forms ─────────────────────────────────────────────────────────────
        const forms = [];
        document.querySelectorAll('form').forEach((form, idx) => {
          const fields = [];
          form.querySelectorAll('input, select, textarea').forEach(field => {
            fields.push({
              tag: field.tagName.toLowerCase(),
              type: field.type,
              name: field.name,
              id: field.id,
              placeholder: field.placeholder,
              required: field.required,
            });
          });
          forms.push({
            id: form.id || form.action || `form-${idx}`,
            action: form.action,
            method: form.method,
            fields,
          });
        });

        // ── Main content ───────────────────────────────────────────────────────
        const main =
          document.querySelector('main, [role="main"], article, .content, #content') ||
          document.body;
        const textContent = (main?.textContent || '').trim();

        return {
          title: document.title,
          url: window.location.href,
          meta: {
            description: document.querySelector('meta[name="description"]')?.content || '',
            keywords: document.querySelector('meta[name="keywords"]')?.content || '',
          },
          headings,
          interactives,
          forms,
          textContent: textContent.slice(0, 50_000),
          stats: {
            interactiveCount: interactives.length,
            formCount: forms.length,
            headingCount: headings.length,
          },
        };
      });

      return data;
    } finally {
      await context.close();
    }
  }

  /**
   * Close the underlying browser. Call when done watching.
   */
  async close() {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
    }
  }
}

// ─── PlaywrightDiffTracker ────────────────────────────────────────────────────

/**
 * DiffTracker backed by a real Playwright browser.
 * Extends DiffTracker with browser lifecycle management.
 */
export class PlaywrightDiffTracker extends DiffTracker {
  /**
   * @param {object} [opts]
   * @param {object} [opts.rendererOptions]  - passed to PlaywrightRenderer constructor
   * @param {object} [opts.renderOptions]    - default per-render options
   */
  constructor(opts = {}) {
    const renderer = new PlaywrightRenderer(opts.rendererOptions ?? {});

    // Wrap renderer.render to match DiffTracker's render(url, options) signature
    super({
      render: (url, renderOptions = {}) => renderer.render(url, renderOptions),
      renderOptions: opts.renderOptions ?? {},
    });

    this._renderer = renderer;
  }

  /**
   * Close the browser. Always call this when done.
   */
  async close() {
    await this._renderer.close();
  }
}

// ─── High-level helpers ───────────────────────────────────────────────────────

/**
 * Snapshot a URL twice (with a delay between) and return the diff.
 * Useful for one-shot change detection in scripts.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.delayMs=5000]         - wait between snapshots
 * @param {object} [opts.rendererOptions]      - PlaywrightRenderer options
 * @param {object} [opts.renderOptions]        - per-render overrides
 * @returns {Promise<{ diff: DiffResult, close: Function, tracker: PlaywrightDiffTracker }>}
 */
export async function diffPages(url, opts = {}) {
  const tracker = new PlaywrightDiffTracker({
    rendererOptions: opts.rendererOptions ?? {},
    renderOptions: opts.renderOptions ?? {},
  });

  const baseline = await tracker.setBaseline(url);
  const delayMs = opts.delayMs ?? 5_000;

  await new Promise(r => setTimeout(r, delayMs));

  const diff = await tracker.diff(url);

  return {
    diff,
    baseline,
    tracker,
    close: () => tracker.close(),
  };
}

/**
 * Watch a URL with a Playwright-backed DiffTracker.
 * Returns a handle with stop() and the underlying tracker.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=60000]
 * @param {Function} opts.onChange
 * @param {Function} [opts.onError]
 * @param {object} [opts.rendererOptions]
 * @param {object} [opts.renderOptions]
 * @returns {{ watcher: object, tracker: PlaywrightDiffTracker }}
 */
export function watchPage(url, opts = {}) {
  const tracker = new PlaywrightDiffTracker({
    rendererOptions: opts.rendererOptions ?? {},
    renderOptions: opts.renderOptions ?? {},
  });

  const watcher = tracker.watch(url, {
    intervalMs: opts.intervalMs ?? 60_000,
    onChange: opts.onChange,
    onError: opts.onError,
    emitUnchanged: opts.emitUnchanged ?? false,
  });

  return {
    watcher,
    tracker,
    stop: async () => {
      watcher.stop();
      await tracker.close();
    },
  };
}

export default PlaywrightDiffTracker;
