/**
 * AgentWeb — Headless web rendering for AI agents
 *
 * Renders web pages into structured, LLM-friendly data:
 *   - Static pages: zero-dependency lite renderer (~50-300ms)
 *   - SPAs/JS-heavy: Playwright Chromium fallback (~2-8s)
 *   - SQLite cache: 49x speedup on repeated requests
 *   - Interactive sessions: click, type, form submission
 *
 * @example
 * import { render, renderSummary, InteractiveSession } from 'agentweb';
 *
 * // One-shot render
 * const page = await render('https://news.ycombinator.com');
 * console.log(page.title, page.stats);
 *
 * // Human-readable summary
 * const summary = await renderSummary('https://example.com');
 *
 * // Interactive session
 * const session = new InteractiveSession();
 * const state = await session.start('https://github.com/search');
 * await session.type(0, 'CarapaceOS');
 * await session.press('Enter');
 * const results = await session.snapshot();
 * await session.close();
 */

export { render, renderSummary, cacheStats, invalidateCache } from './prototype/smart-renderer.js';
export { InteractiveSession } from './prototype/interactive.js';
export { PageCache } from './prototype/cache.js';
