/**
 * AgentWeb Core Renderer
 * 
 * Renders web pages and extracts structured information
 * optimized for AI agent consumption.
 */

import { chromium } from 'playwright';

export class AgentWebRenderer {
  constructor(options = {}) {
    this.browser = null;
    this.options = {
      headless: true,
      timeout: 30000,
      ...options
    };
  }

  async init() {
    if (!this.browser) {
      this.browser = await chromium.launch({ 
        headless: this.options.headless 
      });
    }
    return this;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Render a page and extract structured data
   * @param {string} url - URL to render
   * @param {object} options - Render options
   * @returns {object} Structured page representation
   */
  async render(url, options = {}) {
    await this.init();
    
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'AgentWeb/0.1 (AI Agent Browser)'
    });
    
    const page = await context.newPage();
    
    try {
      await page.goto(url, { 
        waitUntil: 'networkidle',
        timeout: this.options.timeout 
      });
      
      // Extract structured data
      const result = await page.evaluate(() => {
        // Get all interactive elements
        const interactives = [];
        const elements = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]');
        
        elements.forEach((el, idx) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          
          interactives.push({
            id: idx,
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            text: (el.textContent || '').trim().slice(0, 100),
            href: el.href || null,
            name: el.name || null,
            placeholder: el.placeholder || null,
            ariaLabel: el.getAttribute('aria-label'),
            role: el.getAttribute('role'),
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          });
        });

        // Get headings structure
        const headings = [];
        document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
          headings.push({
            level: parseInt(h.tagName[1]),
            text: h.textContent.trim().slice(0, 200)
          });
        });

        // Get main content (simplified)
        const main = document.querySelector('main, [role="main"], article, .content, #content');
        const mainText = main ? main.textContent.trim() : document.body.textContent.trim();

        // Get forms
        const forms = [];
        document.querySelectorAll('form').forEach((form, idx) => {
          const fields = [];
          form.querySelectorAll('input, select, textarea').forEach(field => {
            fields.push({
              tag: field.tagName.toLowerCase(),
              type: field.type,
              name: field.name,
              placeholder: field.placeholder,
              required: field.required
            });
          });
          forms.push({
            id: idx,
            action: form.action,
            method: form.method,
            fields
          });
        });

        return {
          title: document.title,
          url: window.location.href,
          meta: {
            description: document.querySelector('meta[name="description"]')?.content,
            keywords: document.querySelector('meta[name="keywords"]')?.content
          },
          headings,
          interactives,
          forms,
          textContent: mainText.slice(0, 5000),
          stats: {
            interactiveCount: interactives.length,
            formCount: forms.length,
            headingCount: headings.length
          }
        };
      });

      // Add screenshot if requested
      if (options.screenshot) {
        result.screenshot = await page.screenshot({ 
          encoding: 'base64',
          fullPage: false 
        });
      }

      return result;
      
    } finally {
      await context.close();
    }
  }
}

export default AgentWebRenderer;
