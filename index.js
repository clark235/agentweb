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
 * import { render, formatResult, InteractiveSession } from 'agentweb';
 *
 * // One-shot render (structured JSON)
 * const result = await render('https://news.ycombinator.com');
 * console.log(result.data.title, result.backend, result.ms);
 *
 * // Human-readable summary
 * const summary = formatResult(result);
 *
 * // Interactive session
 * const session = new InteractiveSession();
 * const state = await session.start('https://github.com/search');
 * await session.type(0, 'CarapaceOS');
 * await session.press('Enter');
 * const results = await session.snapshot();
 * await session.close();
 */

export { render, formatResult, cacheStats, invalidateCache, detectSPA } from './prototype/smart-renderer.js';
export { InteractiveSession } from './prototype/interactive.js';
export { PageCache } from './prototype/cache.js';
export { renderLite, parseHTML, formatSummary as formatLiteSummary } from './prototype/lite-renderer.js';
