#!/usr/bin/env node
/**
 * AgentWeb CLI
 *
 * Renders web pages to structured, agent-friendly output.
 * Uses smart-renderer: lite (fast, no browser) for static pages,
 * Playwright fallback for SPAs.
 *
 * Usage:
 *   agentweb <url>                         Structured JSON output
 *   agentweb <url> --summary               Human-readable summary
 *   agentweb <url> --query "install guide" Semantic query filter
 *   agentweb <url> --force lite            Force lite renderer
 *   agentweb <url> --force playwright      Force Playwright
 *   agentweb <url> --no-cache              Bypass cache
 *   agentweb <url> --cache-stats           Show cache statistics
 *   agentweb --help                        Show this help
 */

import { render, formatResult, cacheStats } from './smart-renderer.js';

function help() {
  console.log(`
AgentWeb — Headless web rendering for AI agents

Usage:
  agentweb <url>                    Render page and output JSON
  agentweb <url> --summary          Human-readable markdown summary
  agentweb <url> --query <text>     Filter output to query-relevant sections
  agentweb <url> --force lite       Skip SPA detection, use lite renderer
  agentweb <url> --force playwright Force Playwright (useful for SPAs)
  agentweb <url> --no-cache         Bypass cache, always fetch fresh
  agentweb --cache-stats            Show SQLite cache statistics

Options:
  --summary         Output human-readable text instead of JSON
  --query <text>    Semantic search query (highlights relevant content)
  --force <backend> Force rendering backend: lite or playwright
  --no-cache        Bypass the SQLite page cache
  --cache-stats     Print cache statistics and exit
  --help            Show this help

Examples:
  agentweb https://example.com
  agentweb https://github.com/trending --summary
  agentweb https://news.ycombinator.com --query "machine learning"
  agentweb https://reactjs.org --force playwright
  agentweb --cache-stats
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    help();
    process.exit(0);
  }

  // --cache-stats
  if (args.includes('--cache-stats')) {
    const stats = cacheStats();
    console.log('AgentWeb Cache Statistics');
    console.log('─'.repeat(30));
    console.log(`Entries:   ${stats.activeEntries ?? stats.entryCount ?? '?'} active`);
    console.log(`Hit rate:  ${stats.hitRate != null ? (stats.hitRate * 100).toFixed(1) + '%' : '?'}`);
    console.log(`Hits:      ${stats.hits ?? '?'}`);
    console.log(`Misses:    ${stats.misses ?? '?'}`);
    if (stats.oldestMs) {
      const mins = Math.round(stats.oldestMs / 60000);
      console.log(`Oldest:    ${mins} min ago`);
    }
    process.exit(0);
  }

  // Parse flags
  const url = args.find(a => !a.startsWith('--') && !['lite', 'playwright'].includes(a));
  const wantSummary = args.includes('--summary');
  const noCache = args.includes('--no-cache');
  const forceIdx = args.indexOf('--force');
  const force = forceIdx >= 0 ? args[forceIdx + 1] : undefined;
  const queryIdx = args.indexOf('--query');
  const query = queryIdx >= 0 ? args[queryIdx + 1] : undefined;

  if (!url) {
    console.error('Error: URL is required');
    console.error('Usage: agentweb <url> [options]');
    process.exit(1);
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    console.error(`Error: Invalid URL "${url}" — must start with http:// or https://`);
    process.exit(1);
  }

  const opts = { noCache };
  if (force) opts.force = force;
  if (query) opts.query = query;

  try {
    process.stderr.write(`Rendering ${url}...\n`);
    const result = await render(url, opts);

    if (wantSummary) {
      console.log(formatResult(result));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
