/**
 * AgentWeb Interactive Module
 *
 * Provides click, type, form, and advanced interaction capabilities
 * for AI agents that need to navigate and interact with web pages.
 *
 * Features:
 *   - Snapshot-based element references (stable IDs across actions)
 *   - Form auto-fill: fill all fields in one call
 *   - Wait helpers: waitForText, waitForSelector, waitForNavigation
 *   - Evaluate: run arbitrary JS in page context
 *   - extractText: grab specific element content by CSS selector
 *   - Select: choose dropdown values
 *   - History: go back/forward
 *   - Page info: title, URL, meta
 */

import { chromium } from 'playwright';

export class InteractiveSession {
  constructor(options = {}) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.options = {
      headless: true,
      timeout: 30000,
      viewport: { width: 1280, height: 720 },
      ...options
    };
    this.elementCache = new Map(); // id -> selector
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async start(url) {
    this.browser = await chromium.launch({
      headless: this.options.headless
    });

    this.context = await this.browser.newContext({
      viewport: this.options.viewport,
      userAgent: 'AgentWeb/0.2 Interactive (AI Agent)',
    });

    this.page = await this.context.newPage();
    await this.page.goto(url, {
      waitUntil: 'networkidle',
      timeout: this.options.timeout
    });

    return this.snapshot();
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  // ─── Snapshot ───────────────────────────────────────────────────────────────

  /**
   * Take a snapshot of the current page state.
   * Returns structured data with stable element IDs for interaction.
   */
  async snapshot() {
    if (!this.page) throw new Error('No active session');

    const data = await this.page.evaluate(() => {
      const elements = [];
      const selectors = [];

      // Find all interactive elements
      const interactives = document.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [onclick], [tabindex]'
      );

      interactives.forEach((el, idx) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.top > window.innerHeight * 2) return; // Skip way-off-screen elements

        // Build a unique selector for this element
        let selector = '';
        if (el.id) {
          // CSS.escape is available in browser context (inside page.evaluate)
          selector = `#${CSS.escape(el.id)}`;
        } else if (el.name && el.tagName.toLowerCase() !== 'a') {
          selector = `[name="${el.name}"]`;
        } else {
          selector = `[data-aw-id="${idx}"]`;
          el.setAttribute('data-aw-id', String(idx));
        }

        elements.push({
          id: idx,
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          text: (el.textContent || el.value || '').trim().slice(0, 80),
          href: el.href || null,
          value: el.value || null,
          placeholder: el.placeholder || null,
          name: el.name || null,
          selector,
          visible: rect.top >= 0 && rect.top < window.innerHeight,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          }
        });
        selectors.push({ id: idx, selector });
      });

      // Collect forms with their fields
      const forms = [];
      document.querySelectorAll('form').forEach((form, formIdx) => {
        const fields = [];
        form.querySelectorAll('input:not([type=hidden]), select, textarea').forEach(field => {
          fields.push({
            name: field.name || field.id || null,
            type: field.type || field.tagName.toLowerCase(),
            placeholder: field.placeholder || null,
            required: field.required,
            value: field.value || null,
          });
        });
        forms.push({
          id: formIdx,
          action: form.action || null,
          method: (form.method || 'get').toUpperCase(),
          fields,
        });
      });

      const title = document.title;
      const url = window.location.href;

      const main = document.querySelector('main, [role="main"], article, .content, #content');
      const textContent = (main || document.body).textContent
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);

      return { title, url, elements, selectors, forms, textContent };
    });

    // Cache selectors for interaction
    this.elementCache.clear();
    data.selectors.forEach(s => this.elementCache.set(s.id, s.selector));
    delete data.selectors;

    return {
      title: data.title,
      url: data.url,
      elements: data.elements,
      forms: data.forms,
      textContent: data.textContent,
      elementCount: data.elements.length,
    };
  }

  // ─── Basic Interactions ─────────────────────────────────────────────────────

  /**
   * Click an element by ID (from snapshot).
   */
  async click(elementId) {
    if (!this.page) throw new Error('No active session');

    const selector = this._getSelector(elementId);
    await this.page.click(selector);
    await this.page.waitForLoadState('networkidle').catch(() => {});

    return this.snapshot();
  }

  /**
   * Type text into an element.
   * @param {number} elementId - ID from snapshot
   * @param {string} text - Text to type
   * @param {boolean} [clear=true] - Clear existing content first
   */
  async type(elementId, text, clear = true) {
    if (!this.page) throw new Error('No active session');

    const selector = this._getSelector(elementId);
    if (clear) {
      await this.page.fill(selector, text);
    } else {
      await this.page.type(selector, text);
    }

    return this.snapshot();
  }

  /**
   * Select a value in a <select> dropdown.
   * @param {number} elementId - ID of the <select> element
   * @param {string|string[]} value - Option value(s) to select
   */
  async select(elementId, value) {
    if (!this.page) throw new Error('No active session');

    const selector = this._getSelector(elementId);
    const values = Array.isArray(value) ? value : [value];
    await this.page.selectOption(selector, values);

    return this.snapshot();
  }

  /**
   * Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.)
   */
  async press(key) {
    if (!this.page) throw new Error('No active session');
    await this.page.keyboard.press(key);
    await this.page.waitForLoadState('networkidle').catch(() => {});
    return this.snapshot();
  }

  // ─── Form Helpers ───────────────────────────────────────────────────────────

  /**
   * Fill an entire form at once.
   *
   * Matches fields by name, id, placeholder, or aria-label.
   * Handles input, textarea, select elements.
   *
   * @param {object} data - Field name → value mapping
   * @param {object} [opts]
   * @param {boolean} [opts.submit=false] - Press Enter after filling
   * @param {string} [opts.submitSelector] - CSS selector for submit button to click
   * @returns {{ filled: string[], skipped: string[], state: object }}
   */
  async fillForm(data, opts = {}) {
    if (!this.page) throw new Error('No active session');

    const filled = [];
    const skipped = [];

    // CSS.escape polyfill for Node.js (browser has it natively)
    function cssEscape(s) {
      return s.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~\s]/g, '\\$&');
    }

    for (const [key, value] of Object.entries(data)) {
      // Try multiple locator strategies
      const strategies = [
        `[name="${key}"]`,
        `#${cssEscape(key)}`,
        `[placeholder*="${key}" i]`,
        `[aria-label*="${key}" i]`,
        `[id*="${key}" i]`,
      ];

      let found = false;
      for (const sel of strategies) {
        try {
          const el = this.page.locator(sel).first();
          const count = await el.count();
          if (count === 0) continue;

          const tag = await el.evaluate(e => e.tagName.toLowerCase());
          const type = await el.evaluate(e => e.type || '').catch(() => '');

          if (tag === 'select') {
            await el.selectOption(String(value));
          } else if (type === 'checkbox' || type === 'radio') {
            const checked = Boolean(value);
            if (checked) {
              await el.check();
            } else {
              await el.uncheck().catch(() => {}); // uncheck may not be supported on radio
            }
          } else {
            await el.fill(String(value));
          }

          filled.push(key);
          found = true;
          break;
        } catch (err) {
          // Try next strategy
        }
      }

      if (!found) {
        skipped.push(key);
      }
    }

    if (opts.submit) {
      await this.page.keyboard.press('Enter');
      await this.page.waitForLoadState('networkidle').catch(() => {});
    } else if (opts.submitSelector) {
      await this.page.click(opts.submitSelector);
      await this.page.waitForLoadState('networkidle').catch(() => {});
    }

    const state = await this.snapshot();
    return { filled, skipped, state };
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  /**
   * Navigate to a URL (preserves cookies/auth state).
   */
  async goto(url) {
    if (!this.page) throw new Error('No active session');
    await this.page.goto(url, {
      waitUntil: 'networkidle',
      timeout: this.options.timeout
    });
    return this.snapshot();
  }

  /**
   * Go back in browser history.
   */
  async back() {
    if (!this.page) throw new Error('No active session');
    await this.page.goBack({ waitUntil: 'networkidle' });
    return this.snapshot();
  }

  /**
   * Go forward in browser history.
   */
  async forward() {
    if (!this.page) throw new Error('No active session');
    await this.page.goForward({ waitUntil: 'networkidle' });
    return this.snapshot();
  }

  /**
   * Reload the current page.
   */
  async reload() {
    if (!this.page) throw new Error('No active session');
    await this.page.reload({ waitUntil: 'networkidle' });
    return this.snapshot();
  }

  // ─── Scroll ─────────────────────────────────────────────────────────────────

  /**
   * Scroll the page.
   * @param {'up'|'down'} [direction='down']
   * @param {number} [amount=500] - Pixels to scroll
   */
  async scroll(direction = 'down', amount = 500) {
    if (!this.page) throw new Error('No active session');
    const delta = direction === 'up' ? -amount : amount;
    await this.page.mouse.wheel(0, delta);
    await this.page.waitForTimeout(300);
    return this.snapshot();
  }

  // ─── Wait Helpers ───────────────────────────────────────────────────────────

  /**
   * Wait for text to appear somewhere on the page.
   *
   * @param {string} text - Text to wait for
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=10000]
   * @returns {object} Page snapshot when text is found
   */
  async waitForText(text, opts = {}) {
    if (!this.page) throw new Error('No active session');
    const timeoutMs = opts.timeoutMs ?? 10_000;
    await this.page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      text,
      { timeout: timeoutMs }
    );
    return this.snapshot();
  }

  /**
   * Wait for a CSS selector to appear in the DOM.
   *
   * @param {string} selector - CSS selector to wait for
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=10000]
   * @param {'attached'|'detached'|'visible'|'hidden'} [opts.state='visible']
   * @returns {object} Page snapshot when element is found
   */
  async waitForSelector(selector, opts = {}) {
    if (!this.page) throw new Error('No active session');
    await this.page.waitForSelector(selector, {
      state: opts.state ?? 'visible',
      timeout: opts.timeoutMs ?? 10_000,
    });
    return this.snapshot();
  }

  /**
   * Wait for a network request to complete (useful after form submits).
   *
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=10000]
   */
  async waitForNavigation(opts = {}) {
    if (!this.page) throw new Error('No active session');
    await this.page.waitForLoadState('networkidle', {
      timeout: opts.timeoutMs ?? 10_000,
    });
    return this.snapshot();
  }

  // ─── Content Extraction ─────────────────────────────────────────────────────

  /**
   * Extract text content from a specific element (or list of elements).
   *
   * @param {string} selector - CSS selector
   * @param {object} [opts]
   * @param {boolean} [opts.all=false] - Return all matching elements (not just first)
   * @returns {string|string[]}
   */
  async extractText(selector, opts = {}) {
    if (!this.page) throw new Error('No active session');

    if (opts.all) {
      const elements = await this.page.locator(selector).all();
      const texts = await Promise.all(elements.map(el => el.innerText().catch(() => '')));
      return texts.map(t => t.trim()).filter(Boolean);
    }

    const el = this.page.locator(selector).first();
    const count = await el.count();
    if (count === 0) return null;
    return (await el.innerText()).trim();
  }

  /**
   * Extract attribute values from matching elements.
   *
   * @param {string} selector - CSS selector
   * @param {string} attribute - Attribute name (e.g., 'href', 'src', 'value')
   * @param {object} [opts]
   * @param {boolean} [opts.all=true] - Return all matches (default) or just first
   * @returns {string|string[]|null}
   */
  async extractAttribute(selector, attribute, opts = { all: true }) {
    if (!this.page) throw new Error('No active session');

    if (opts.all) {
      const elements = await this.page.locator(selector).all();
      const values = await Promise.all(
        elements.map(el => el.getAttribute(attribute).catch(() => null))
      );
      return values.filter(v => v !== null);
    }

    const el = this.page.locator(selector).first();
    const count = await el.count();
    if (count === 0) return null;
    return el.getAttribute(attribute);
  }

  // ─── Page Evaluation ────────────────────────────────────────────────────────

  /**
   * Execute arbitrary JavaScript in the page context.
   * Use for custom extraction, manipulation, or reading JS state.
   *
   * @param {Function|string} fn - Function or expression to evaluate
   * @param {*} [arg] - Optional argument to pass to the function
   * @returns {*} The return value of fn (must be JSON-serializable)
   *
   * @example
   * const count = await session.evaluate(() => document.querySelectorAll('li').length);
   * const title = await session.evaluate(() => document.title);
   * const data = await session.evaluate((sel) => {
   *   return [...document.querySelectorAll(sel)].map(el => el.textContent.trim());
   * }, 'h2');
   */
  async evaluate(fn, arg) {
    if (!this.page) throw new Error('No active session');
    if (arg !== undefined) {
      return this.page.evaluate(fn, arg);
    }
    return this.page.evaluate(fn);
  }

  // ─── Misc ───────────────────────────────────────────────────────────────────

  /**
   * Take a screenshot.
   * @param {object} [opts]
   * @param {'base64'|'binary'} [opts.encoding='base64']
   * @param {boolean} [opts.fullPage=false]
   * @returns {string|Buffer}
   */
  async screenshot(opts = {}) {
    if (!this.page) throw new Error('No active session');
    return this.page.screenshot({
      encoding: opts.encoding ?? 'base64',
      fullPage: opts.fullPage ?? false,
    });
  }

  /**
   * Get the current URL.
   */
  currentUrl() {
    return this.page?.url() ?? null;
  }

  /**
   * Get page title.
   */
  async title() {
    if (!this.page) throw new Error('No active session');
    return this.page.title();
  }

  /**
   * Get all cookies for the current page.
   */
  async cookies() {
    if (!this.context) throw new Error('No active session');
    return this.context.cookies();
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  _getSelector(elementId) {
    const selector = this.elementCache.get(Number(elementId));
    if (!selector) throw new Error(
      `Element ID ${elementId} not in cache — call snapshot() first or ID may be stale`
    );
    return selector;
  }
}

export default InteractiveSession;
