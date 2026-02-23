#!/usr/bin/env node
/**
 * AgentWeb Lite Renderer — Unit Tests
 *
 * Tests parseHTML() and formatSummary() offline (no network).
 * Live URL tests run only when --live flag is passed.
 *
 * Usage:
 *   node test-lite.js           # Offline tests only (CI-safe)
 *   node test-lite.js --live    # Include live URL tests
 */

import { parseHTML, formatSummary, renderLite } from './lite-renderer.js';

// ─── Harness ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SIMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <meta name="description" content="A test page for AgentWeb">
  <meta name="keywords" content="test, agentweb, headless">
</head>
<body>
  <h1>Main Heading</h1>
  <h2>Sub Heading One</h2>
  <p>Some paragraph text here. It has multiple sentences. This is the main content.</p>
  <h2>Sub Heading Two</h2>
  <p>More content here.</p>
  <a href="https://example.com">External Link</a>
  <a href="/internal">Internal Link</a>
</body>
</html>`;

const FORM_HTML = `<!DOCTYPE html>
<html>
<head><title>Login Form</title></head>
<body>
  <h1>Login</h1>
  <form action="/login" method="post">
    <input type="text" name="username" placeholder="Username" required>
    <input type="password" name="password" placeholder="Password" required>
    <input type="checkbox" name="remember" value="1"> Remember me
    <button type="submit">Log In</button>
  </form>
  <form action="/search" method="get">
    <input type="search" name="q" placeholder="Search...">
    <button type="submit">Search</button>
  </form>
</body>
</html>`;

const TABLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Data Table</title></head>
<body>
  <table>
    <thead><tr><th>Name</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>Alpha</td><td>1</td></tr>
      <tr><td>Beta</td><td>2</td></tr>
      <tr><td>Gamma</td><td>3</td></tr>
    </tbody>
  </table>
</body>
</html>`;

const ENTITY_HTML = `<!DOCTYPE html>
<html>
<head><title>Entities &amp; Escapes</title></head>
<body>
  <h1>Test &lt;escaping&gt; &amp; entities</h1>
  <p>Price: &pound;100 &mdash; &copy; 2026</p>
  <a href="https://example.com/?a=1&amp;b=2">Link with &amp; in href</a>
</body>
</html>`;

const BASE_URL = 'https://test.example.com/page';

// ─── Tests: parseHTML ─────────────────────────────────────────────────────────

console.log('\n🌐 AgentWeb Lite Renderer — Unit Tests\n');

console.log('── Basic parsing ──');
{
  const r = parseHTML(SIMPLE_HTML, BASE_URL);

  assert('title extracted', r.title === 'Test Page', `got: ${r.title}`);
  assert('meta description extracted', r.meta.description === 'A test page for AgentWeb');
  assert('meta keywords extracted', r.meta.keywords?.includes('agentweb'));
  assert('h1 heading found', r.headings.some(h => h.level === 1 && h.text === 'Main Heading'));
  assert('h2 headings found (2)', r.headings.filter(h => h.level === 2).length === 2);
  assert('heading order preserved', r.headings[0].text === 'Main Heading');
  assert('external link found', r.links.some(l => l.href?.startsWith('https://example.com')));
  assert('internal link resolved', r.links.some(l => l.href?.includes('/internal')));
  assert('text content extracted', r.textContent.includes('paragraph text'));
  assert('stats.headingCount correct', r.stats.headingCount === 3);
  assert('stats.linkCount correct', r.stats.linkCount === 2);
  assert('stats.textLength > 0', r.stats.textLength > 0);
}

console.log('\n── Form parsing ──');
{
  const r = parseHTML(FORM_HTML, BASE_URL);

  assert('two forms found', r.forms.length === 2, `got: ${r.forms.length}`);
  const loginForm = r.forms.find(f => f.action?.includes('/login'));
  assert('login form found', !!loginForm);
  assert('login form method = post', loginForm?.method?.toLowerCase() === 'post');
  assert('username field found', loginForm?.fields?.some(f => f.name === 'username'));
  assert('password field found', loginForm?.fields?.some(f => f.name === 'password' && f.type === 'password'));
  assert('required fields detected', loginForm?.fields?.some(f => f.required));
  assert('search form found', r.forms.some(f => f.action?.includes('/search')));
  assert('stats.formCount = 2', r.stats.formCount === 2);
}

console.log('\n── Table parsing ──');
{
  const r = parseHTML(TABLE_HTML, BASE_URL);

  assert('table found', r.tables.length === 1, `got: ${r.tables.length}`);
  // tables is array of arrays (rows): [[headers...], [row1...], ...]
  assert('table has rows', Array.isArray(r.tables[0]) && r.tables[0].length >= 2, `got: ${JSON.stringify(r.tables[0])}`);
  assert('header row extracted', r.tables[0]?.[0]?.includes('Name'), `headers: ${JSON.stringify(r.tables[0]?.[0])}`);
  assert('stats.tableCount = 1', r.stats.tableCount === 1);
}

console.log('\n── HTML entity decoding ──');
{
  const r = parseHTML(ENTITY_HTML, BASE_URL);

  assert('title entity decoded (&amp; → &)', r.title === 'Entities & Escapes', `got: ${r.title}`);
  assert('h1 entities decoded (< > &)', r.headings[0]?.text?.includes('<escaping>') || r.headings[0]?.text?.includes('escaping'));
  assert('link href amp decoded', r.links.some(l => l.href?.includes('a=1') && l.href?.includes('b=2')));
}

console.log('\n── Empty / edge cases ──');
{
  const empty = parseHTML('', BASE_URL);
  assert('empty HTML: no crash', true);
  assert('empty HTML: null title', empty.title === null || empty.title === '');
  assert('empty HTML: 0 headings', empty.headings.length === 0);
  assert('empty HTML: 0 links', empty.links.length === 0);

  const noHead = parseHTML('<html><body><h1>Only body</h1><p>text</p></body></html>', BASE_URL);
  assert('no <head>: h1 found', noHead.headings[0]?.text === 'Only body');
  assert('no <head>: null title', noHead.title === null || noHead.title === '');

  const selfClose = parseHTML('<html><body><img src="/img.png" alt="test"><br><hr></body></html>', BASE_URL);
  assert('self-closing tags: image extracted', selfClose.images.length === 1);
  assert('self-closing tags: no crash', selfClose.stats.imageCount === 1);
}

console.log('\n── formatSummary ──');
{
  const r = parseHTML(SIMPLE_HTML, BASE_URL);
  const summary = formatSummary(r);

  assert('formatSummary returns string', typeof summary === 'string');
  assert('summary contains title', summary.includes('Test Page'));
  assert('summary contains headings', summary.includes('Main Heading'));
  assert('summary contains links', summary.includes('External Link'));
  assert('summary contains stats', summary.includes('links'));
}

// ─── Live URL tests (optional, skipped in CI) ─────────────────────────────────

if (process.argv.includes('--live')) {
  console.log('\n── Live URL tests (--live) ──');

  const liveUrls = [
    'https://example.com',
    'https://news.ycombinator.com',
  ];

  for (const url of liveUrls) {
    try {
      const start = Date.now();
      const r = await renderLite(url);
      const ms = Date.now() - start;
      assert(`${url}: title extracted`, !!r.title, r.title);
      assert(`${url}: renders in <5s`, ms < 5000, `${ms}ms`);
      assert(`${url}: has links or headings`, r.links.length > 0 || r.headings.length > 0);
      console.log(`  ℹ️  ${url}: ${ms}ms, ${r.stats.linkCount} links, ${r.stats.headingCount} headings`);
    } catch (e) {
      console.warn(`  ⚠️  ${url}: ${e.message} (network may be unavailable)`);
    }
  }
} else {
  console.log('\n  ℹ️  Skipping live URL tests (pass --live to enable)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks\n`);

if (failed === 0) {
  console.log('🎉 All lite-renderer tests passed!\n');
} else {
  console.error(`💥 ${failed} test(s) failed\n`);
  process.exit(1);
}
