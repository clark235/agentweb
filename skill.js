/**
 * AgentWeb OpenClaw Skill
 *
 * Integrates AgentWeb with OpenClaw's skill system.
 * Provides structured web rendering and interactive browser sessions.
 *
 * Usage in OpenClaw:
 *   const { render, renderSummary, session } = await import('./ventures/agentweb/skill.js');
 *
 * Tool functions:
 *   render(url, options?)        — render page to structured JSON
 *   renderSummary(url)           — human-readable page summary
 *   sessionOpen(url)             — start an interactive session
 *   sessionClick(id, elementId)  — click an element
 *   sessionType(id, el, text)    — type into a field
 *   sessionPress(id, key)        — press a key (Enter, Tab, Escape...)
 *   sessionGoto(id, url)         — navigate to a new URL
 *   sessionScroll(id, dir)       — scroll up or down
 *   sessionSnapshot(id)          — get current page state
 *   sessionClose(id)             — close the session
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Dynamic imports (Playwright optional) ───────────────────────────────────

async function getRenderer() {
  const { render: _render, renderSummary: _renderSummary, cacheStats: _cacheStats } =
    await import('./prototype/smart-renderer.js');
  return { render: _render, renderSummary: _renderSummary, cacheStats: _cacheStats };
}

async function getInteractiveSession() {
  const { InteractiveSession } = await import('./prototype/interactive.js');
  return InteractiveSession;
}

// ─── Session registry ────────────────────────────────────────────────────────
// Agents can hold multiple concurrent interactive sessions.

const _sessions = new Map(); // id -> InteractiveSession instance
let _nextId = 1;

function sessionId() {
  return `aw-${_nextId++}`;
}

// ─── Render API ──────────────────────────────────────────────────────────────

/**
 * Render a web page to structured data.
 *
 * @param {string} url - The URL to render
 * @param {object} [options]
 * @param {string} [options.query] - Semantic search query to highlight relevant sections
 * @param {'lite'|'playwright'} [options.force] - Force a specific backend
 * @param {boolean} [options.noCache=false] - Bypass cache
 * @returns {object} Page data: { title, url, headings, interactives, forms, textContent, stats, backend, ms }
 */
export async function render(url, options = {}) {
  if (!url || typeof url !== 'string') throw new Error('render: url must be a non-empty string');
  const { render: _render } = await getRenderer();
  const result = await _render(url, options);
  return result;
}

/**
 * Render a page and return a human-readable markdown summary.
 *
 * @param {string} url
 * @param {string} [query] - Optional focus query
 * @returns {string} Markdown-formatted summary
 */
export async function renderSummary(url, query = '') {
  if (!url || typeof url !== 'string') throw new Error('renderSummary: url must be a non-empty string');
  const { renderSummary: _renderSummary } = await getRenderer();
  const result = await _renderSummary(url, { query });
  return result;
}

/**
 * Get cache statistics.
 * @returns {{ hits, misses, hitRate, entryCount, oldestMs }}
 */
export async function cacheStats() {
  const { cacheStats: _cacheStats } = await getRenderer();
  return _cacheStats();
}

// ─── Interactive Session API ─────────────────────────────────────────────────

/**
 * Open an interactive browser session.
 *
 * @param {string} url - Starting URL
 * @param {object} [options]
 * @param {boolean} [options.headless=true]
 * @param {number} [options.timeout=30000]
 * @returns {{ sessionId: string, state: object }} Session ID and initial page state
 */
export async function sessionOpen(url, options = {}) {
  if (!url || typeof url !== 'string') throw new Error('sessionOpen: url must be a non-empty string');

  const InteractiveSession = await getInteractiveSession();
  const sess = new InteractiveSession({
    headless: options.headless !== false,
    timeout: options.timeout ?? 30000,
  });

  const state = await sess.start(url);
  const id = sessionId();
  _sessions.set(id, sess);

  return { sessionId: id, state };
}

/**
 * Click an element in an interactive session.
 *
 * @param {string} sessionId - Session ID from sessionOpen
 * @param {number} elementId - Element ID from the snapshot
 * @returns {object} New page state after click
 */
export async function sessionClick(sessionId, elementId) {
  const sess = _getSession(sessionId);
  return await sess.click(Number(elementId));
}

/**
 * Type text into a form field.
 *
 * @param {string} sessionId
 * @param {number} elementId - Element ID from the snapshot
 * @param {string} text - Text to type
 * @param {boolean} [clear=true] - Clear existing content first
 * @returns {object} New page state
 */
export async function sessionType(sessionId, elementId, text, clear = true) {
  const sess = _getSession(sessionId);
  return await sess.type(Number(elementId), text, clear);
}

/**
 * Press a keyboard key.
 *
 * @param {string} sessionId
 * @param {string} key - Key name: 'Enter', 'Tab', 'Escape', 'ArrowDown', etc.
 * @returns {object} New page state
 */
export async function sessionPress(sessionId, key) {
  const sess = _getSession(sessionId);
  return await sess.press(key);
}

/**
 * Navigate to a new URL in an existing session (preserving cookies/state).
 *
 * @param {string} sessionId
 * @param {string} url
 * @returns {object} New page state
 */
export async function sessionGoto(sessionId, url) {
  const sess = _getSession(sessionId);
  return await sess.goto(url);
}

/**
 * Scroll the page.
 *
 * @param {string} sessionId
 * @param {'up'|'down'} [direction='down']
 * @param {number} [amount=500] - Pixels
 * @returns {object} New page state
 */
export async function sessionScroll(sessionId, direction = 'down', amount = 500) {
  const sess = _getSession(sessionId);
  return await sess.scroll(direction, amount);
}

/**
 * Get the current page state without performing any action.
 *
 * @param {string} sessionId
 * @returns {object} Current page snapshot
 */
export async function sessionSnapshot(sessionId) {
  const sess = _getSession(sessionId);
  return await sess.snapshot();
}

/**
 * Close an interactive session and free browser resources.
 *
 * @param {string} sessionId
 */
export async function sessionClose(sessionId) {
  const sess = _getSession(sessionId);
  await sess.close();
  _sessions.delete(sessionId);
}

/**
 * List all open session IDs and their current URLs.
 *
 * @returns {Array<{sessionId: string, url: string}>}
 */
export function sessionList() {
  return Array.from(_sessions.entries()).map(([id, sess]) => ({
    sessionId: id,
    url: sess.currentUrl(),
  }));
}

/**
 * Close all open sessions (cleanup on agent exit).
 */
export async function sessionCloseAll() {
  const ids = Array.from(_sessions.keys());
  await Promise.all(ids.map(id => sessionClose(id).catch(() => {})));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _getSession(id) {
  const sess = _sessions.get(id);
  if (!sess) throw new Error(`No active session with id "${id}". Call sessionOpen() first.`);
  return sess;
}

// ─── OpenClaw tool descriptor ─────────────────────────────────────────────────
// Used by OpenClaw to register these as callable agent tools.

export const TOOLS = [
  {
    name: 'agentweb_render',
    description: 'Render a web page to structured JSON data (title, headings, links, forms, text content). Fast for static pages, uses Playwright for SPAs.',
    fn: render,
    params: {
      url: { type: 'string', required: true, description: 'URL to render' },
      query: { type: 'string', required: false, description: 'Semantic query to highlight relevant sections' },
      noCache: { type: 'boolean', required: false, description: 'Bypass cache (default: false)' },
    },
  },
  {
    name: 'agentweb_summary',
    description: 'Get a human-readable markdown summary of a web page. Good for quick research.',
    fn: renderSummary,
    params: {
      url: { type: 'string', required: true, description: 'URL to summarize' },
      query: { type: 'string', required: false, description: 'Focus query' },
    },
  },
  {
    name: 'agentweb_session_open',
    description: 'Open an interactive browser session. Returns sessionId for subsequent actions.',
    fn: sessionOpen,
    params: {
      url: { type: 'string', required: true, description: 'Starting URL' },
    },
  },
  {
    name: 'agentweb_session_click',
    description: 'Click an element in an active browser session.',
    fn: sessionClick,
    params: {
      sessionId: { type: 'string', required: true, description: 'Session ID from sessionOpen' },
      elementId: { type: 'number', required: true, description: 'Element ID from snapshot' },
    },
  },
  {
    name: 'agentweb_session_type',
    description: 'Type text into a form field in an active browser session.',
    fn: sessionType,
    params: {
      sessionId: { type: 'string', required: true },
      elementId: { type: 'number', required: true, description: 'Input element ID from snapshot' },
      text: { type: 'string', required: true, description: 'Text to type' },
    },
  },
  {
    name: 'agentweb_session_press',
    description: 'Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.)',
    fn: sessionPress,
    params: {
      sessionId: { type: 'string', required: true },
      key: { type: 'string', required: true, description: 'Key name: Enter, Tab, Escape, ArrowDown, etc.' },
    },
  },
  {
    name: 'agentweb_session_goto',
    description: 'Navigate to a URL in an existing session (preserves cookies/auth state).',
    fn: sessionGoto,
    params: {
      sessionId: { type: 'string', required: true },
      url: { type: 'string', required: true },
    },
  },
  {
    name: 'agentweb_session_scroll',
    description: 'Scroll the page in a browser session.',
    fn: sessionScroll,
    params: {
      sessionId: { type: 'string', required: true },
      direction: { type: 'string', required: false, description: '"up" or "down" (default: down)' },
      amount: { type: 'number', required: false, description: 'Pixels to scroll (default: 500)' },
    },
  },
  {
    name: 'agentweb_session_snapshot',
    description: 'Get the current page state from an active browser session.',
    fn: sessionSnapshot,
    params: {
      sessionId: { type: 'string', required: true },
    },
  },
  {
    name: 'agentweb_session_close',
    description: 'Close a browser session and free resources.',
    fn: sessionClose,
    params: {
      sessionId: { type: 'string', required: true },
    },
  },
  {
    name: 'agentweb_session_list',
    description: 'List all open browser sessions and their current URLs.',
    fn: sessionList,
    params: {},
  },
  {
    name: 'agentweb_cache_stats',
    description: 'Get AgentWeb cache statistics (hit rate, entry count, etc.)',
    fn: cacheStats,
    params: {},
  },
];

export default {
  render,
  renderSummary,
  cacheStats,
  sessionOpen,
  sessionClick,
  sessionType,
  sessionPress,
  sessionGoto,
  sessionScroll,
  sessionSnapshot,
  sessionClose,
  sessionList,
  sessionCloseAll,
  TOOLS,
};
