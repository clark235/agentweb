/**
 * AgentWeb Interactive Module
 * 
 * Provides click, type, and form interaction capabilities
 * for AI agents that need to navigate and interact with web pages.
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

  async start(url) {
    this.browser = await chromium.launch({ 
      headless: this.options.headless 
    });
    
    this.context = await this.browser.newContext({
      viewport: this.options.viewport,
      userAgent: 'AgentWeb/0.1 Interactive (AI Agent)'
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

  /**
   * Take a snapshot of the current page state
   * Returns structured data with clickable element IDs
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
        if (rect.top > window.innerHeight * 2) return; // Skip elements way off screen
        
        // Build a unique selector for this element
        let selector = '';
        if (el.id) {
          selector = `#${el.id}`;
        } else if (el.name && el.tagName.toLowerCase() !== 'a') {
          selector = `[name="${el.name}"]`;
        } else {
          // Use data attribute we'll add
          selector = `[data-aw-id="${idx}"]`;
          el.setAttribute('data-aw-id', idx);
        }
        
        elements.push({
          id: idx,
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          text: (el.textContent || el.value || '').trim().slice(0, 80),
          href: el.href || null,
          value: el.value || null,
          placeholder: el.placeholder || null,
          selector,
          visible: rect.top >= 0 && rect.top < window.innerHeight,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          }
        });
        selectors.push({ id: idx, selector });
      });

      // Get page state
      const title = document.title;
      const url = window.location.href;
      
      // Get visible text content
      const main = document.querySelector('main, [role="main"], article, .content, #content');
      const textContent = (main || document.body).textContent
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);

      return { title, url, elements, selectors, textContent };
    });

    // Cache selectors for interaction
    this.elementCache.clear();
    data.selectors.forEach(s => this.elementCache.set(s.id, s.selector));
    delete data.selectors; // Don't expose internal selectors

    return {
      title: data.title,
      url: data.url,
      elements: data.elements,
      textContent: data.textContent,
      elementCount: data.elements.length
    };
  }

  /**
   * Click an element by ID
   * @param {number} elementId - The ID from the snapshot
   * @returns {object} New page snapshot
   */
  async click(elementId) {
    if (!this.page) throw new Error('No active session');
    
    const selector = this.elementCache.get(elementId);
    if (!selector) throw new Error(`Element ${elementId} not found in cache`);
    
    await this.page.click(selector);
    await this.page.waitForLoadState('networkidle').catch(() => {});
    
    return this.snapshot();
  }

  /**
   * Type text into an element
   * @param {number} elementId - The ID from the snapshot
   * @param {string} text - Text to type
   * @param {boolean} clear - Clear existing content first
   * @returns {object} New page snapshot
   */
  async type(elementId, text, clear = true) {
    if (!this.page) throw new Error('No active session');
    
    const selector = this.elementCache.get(elementId);
    if (!selector) throw new Error(`Element ${elementId} not found in cache`);
    
    if (clear) {
      await this.page.fill(selector, text);
    } else {
      await this.page.type(selector, text);
    }
    
    return this.snapshot();
  }

  /**
   * Press a key (Enter, Escape, Tab, etc.)
   */
  async press(key) {
    if (!this.page) throw new Error('No active session');
    await this.page.keyboard.press(key);
    await this.page.waitForLoadState('networkidle').catch(() => {});
    return this.snapshot();
  }

  /**
   * Navigate to a URL
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
   * Scroll the page
   * @param {string} direction - 'up' or 'down'
   * @param {number} amount - pixels to scroll (default 500)
   */
  async scroll(direction = 'down', amount = 500) {
    if (!this.page) throw new Error('No active session');
    
    const delta = direction === 'up' ? -amount : amount;
    await this.page.mouse.wheel(0, delta);
    await this.page.waitForTimeout(300);
    
    return this.snapshot();
  }

  /**
   * Take a screenshot
   * @returns {string} Base64 encoded PNG
   */
  async screenshot() {
    if (!this.page) throw new Error('No active session');
    return await this.page.screenshot({ encoding: 'base64' });
  }

  /**
   * Get current URL
   */
  currentUrl() {
    return this.page?.url() || null;
  }
}

export default InteractiveSession;
