/**
 * Tests for AgentWeb DiffTracker — no network/browser required.
 * All tests use synthetic page data.
 */

import { buildSnapshot, computeDiff, formatDiff, DiffTracker } from './diff-tracker.js';

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    errors.push({ name, error: e.message });
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    errors.push({ name, error: e.message });
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'Expected equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// ─── Synthetic page data ──────────────────────────────────────────────────────

function makePage(overrides = {}) {
  return {
    title: 'Test Page',
    headings: [{ text: 'Main Heading' }, { text: 'Section 1' }],
    interactives: [
      { tag: 'a', text: 'Link One', href: 'https://example.com/1' },
      { tag: 'a', text: 'Link Two', href: 'https://example.com/2' },
    ],
    forms: [
      { id: 'search', action: '/search', fields: [{ name: 'q' }] },
    ],
    textContent: 'This is the main content of the page. It has some words. Price: $99.99. Count: 42.',
    stats: { interactiveCount: 2, formCount: 1 },
    ...overrides,
  };
}

// ─── buildSnapshot tests ──────────────────────────────────────────────────────

console.log('\n🌐 AgentWeb DiffTracker Tests\n');
console.log('buildSnapshot');

test('builds snapshot with correct url and timestamp', () => {
  const snap = buildSnapshot('https://example.com', makePage());
  assertEqual(snap.url, 'https://example.com', 'url');
  assert(typeof snap.timestamp === 'number', 'timestamp is number');
  assert(snap.timestamp <= Date.now(), 'timestamp not in future');
});

test('extracts title', () => {
  const snap = buildSnapshot('https://x.com', makePage({ title: 'My Page' }));
  assertEqual(snap.title, 'My Page', 'title');
});

test('extracts headings as strings', () => {
  const snap = buildSnapshot('https://x.com', makePage());
  assert(Array.isArray(snap.headings), 'headings is array');
  assertEqual(snap.headings[0], 'Main Heading', 'first heading');
  assertEqual(snap.headings[1], 'Section 1', 'second heading');
});

test('extracts links (filters non-href interactives)', () => {
  const snap = buildSnapshot('https://x.com', makePage());
  assertEqual(snap.links.length, 2, '2 links');
  assertEqual(snap.links[0].href, 'https://example.com/1', 'first link href');
  assertEqual(snap.links[0].text, 'Link One', 'first link text');
});

test('filters javascript: hrefs', () => {
  const page = makePage({
    interactives: [
      { tag: 'a', text: 'Click', href: 'javascript:void(0)' },
      { tag: 'a', text: 'Real', href: 'https://example.com' },
    ],
  });
  const snap = buildSnapshot('https://x.com', page);
  assertEqual(snap.links.length, 1, 'only real links');
  assertEqual(snap.links[0].text, 'Real', 'real link text');
});

test('extracts numbers from text content', () => {
  const snap = buildSnapshot('https://x.com', makePage({
    textContent: 'Price: $19.99. Count: 100. Rate: 5.7%.',
  }));
  assert(snap.numbers.includes('$19.99'), 'price extracted');
  assert(snap.numbers.includes('100'), 'count extracted');
});

test('builds text fingerprint (hash)', () => {
  const snap = buildSnapshot('https://x.com', makePage());
  assert(typeof snap.textFingerprint === 'string', 'fingerprint is string');
  assert(snap.textFingerprint.length > 0, 'fingerprint non-empty');
});

test('same content → same fingerprint', () => {
  const s1 = buildSnapshot('https://x.com', makePage());
  const s2 = buildSnapshot('https://x.com', makePage());
  assertEqual(s1.textFingerprint, s2.textFingerprint, 'same content same fingerprint');
});

test('different content → different fingerprint', () => {
  const s1 = buildSnapshot('https://x.com', makePage({ textContent: 'hello world' }));
  const s2 = buildSnapshot('https://x.com', makePage({ textContent: 'completely different content here' }));
  assert(s1.textFingerprint !== s2.textFingerprint, 'different content different fingerprint');
});

test('stats include wordCount', () => {
  const snap = buildSnapshot('https://x.com', makePage({ textContent: 'one two three four five' }));
  assertEqual(snap.stats.wordCount, 5, 'wordCount=5');
});

test('handles render({ backend, data }) wrapper format', () => {
  const snap = buildSnapshot('https://x.com', { backend: 'lite', data: makePage() });
  assertEqual(snap.title, 'Test Page', 'title extracted from data wrapper');
});

// ─── computeDiff tests ────────────────────────────────────────────────────────

console.log('\ncomputeDiff');

function snapOf(overrides = {}) {
  return buildSnapshot('https://example.com', makePage(overrides));
}

test('no changes → changed=false', () => {
  const s = snapOf();
  const diff = computeDiff(s, { ...s, timestamp: s.timestamp + 1000 });
  assertEqual(diff.changed, false, 'not changed');
  assertEqual(diff.changes.length, 0, 'no changes');
});

test('title change → high severity change', () => {
  const base = snapOf({ title: 'Old Title' });
  const curr = { ...snapOf({ title: 'New Title' }), timestamp: base.timestamp + 5000 };
  const diff = computeDiff(base, curr);
  assert(diff.changed, 'changed');
  const change = diff.changes.find(c => c.type === 'title');
  assert(change, 'title change detected');
  assertEqual(change.severity, 'high', 'high severity');
  assertEqual(change.before, 'Old Title', 'before');
  assertEqual(change.after, 'New Title', 'after');
});

test('text content change → text_content change', () => {
  const base = snapOf({ textContent: 'original content that is quite long' });
  const curr = {
    ...snapOf({ textContent: 'totally different content entirely new words here and more text' }),
    timestamp: base.timestamp + 10000,
  };
  const diff = computeDiff(base, curr);
  const change = diff.changes.find(c => c.type === 'text_content');
  assert(change, 'text_content change detected');
  assert(typeof change.percentDelta === 'number', 'has percentDelta');
});

test('new link → links_added change', () => {
  const base = snapOf();
  const currPage = makePage({
    interactives: [
      { tag: 'a', text: 'Link One', href: 'https://example.com/1' },
      { tag: 'a', text: 'Link Two', href: 'https://example.com/2' },
      { tag: 'a', text: 'New Link', href: 'https://example.com/new' },
    ],
  });
  const curr = { ...buildSnapshot('https://example.com', currPage), timestamp: base.timestamp + 5000 };
  const diff = computeDiff(base, curr);
  const change = diff.changes.find(c => c.type === 'links_added');
  assert(change, 'links_added change');
  assertEqual(change.links[0].href, 'https://example.com/new', 'new link href');
});

test('removed link → links_removed change', () => {
  const base = snapOf();
  const currPage = makePage({
    interactives: [
      { tag: 'a', text: 'Link One', href: 'https://example.com/1' },
      // Link Two removed
    ],
  });
  const curr = { ...buildSnapshot('https://example.com', currPage), timestamp: base.timestamp + 5000 };
  const diff = computeDiff(base, curr);
  const change = diff.changes.find(c => c.type === 'links_removed');
  assert(change, 'links_removed change');
  assertEqual(change.links[0].href, 'https://example.com/2', 'removed link href');
});

test('price change → numbers change', () => {
  const base = snapOf({ textContent: 'Price: $99.99 and $50' });
  const curr = { ...snapOf({ textContent: 'Price: $149.99 and $75' }), timestamp: base.timestamp + 5000 };
  const diff = computeDiff(base, curr);
  const change = diff.changes.find(c => c.type === 'numbers');
  assert(change, 'numbers change detected');
  assert(change.added.length > 0 || change.removed.length > 0, 'has added or removed numbers');
});

test('heading change → headings change', () => {
  const base = snapOf();
  const curr = {
    ...snapOf({ headings: [{ text: 'New Heading' }, { text: 'Other Section' }] }),
    timestamp: base.timestamp + 5000,
  };
  const diff = computeDiff(base, curr);
  const change = diff.changes.find(c => c.type === 'headings');
  assert(change, 'headings change detected');
  assert(change.added.includes('New Heading'), 'added heading');
  assert(change.removed.includes('Main Heading'), 'removed heading');
});

test('form added → forms change', () => {
  const base = snapOf({ forms: [] });
  const curr = {
    ...snapOf({ forms: [{ id: 'contact', action: '/contact', fields: [{ name: 'email' }] }] }),
    timestamp: base.timestamp + 5000,
  };
  const diff = computeDiff(base, curr);
  const change = diff.changes.find(c => c.type === 'forms');
  assert(change, 'forms change');
  assertEqual(change.added.length, 1, '1 form added');
});

test('summary includes all change labels', () => {
  const base = snapOf({ title: 'Old' });
  const curr = { ...snapOf({ title: 'New', textContent: 'Completely different long text content' }), timestamp: base.timestamp + 5000 };
  const diff = computeDiff(base, curr);
  assert(diff.summary.includes('change'), 'summary mentions changes');
  assert(typeof diff.snapshotAge === 'number', 'snapshotAge is number');
});

test('no-change summary says "No changes"', () => {
  const s = snapOf();
  const diff = computeDiff(s, { ...s, timestamp: s.timestamp + 3000 });
  assert(diff.summary.includes('No changes'), 'no-change summary');
});

// ─── formatDiff tests ─────────────────────────────────────────────────────────

console.log('\nformatDiff');

test('formatDiff on no-change diff returns ✅', () => {
  const s = snapOf();
  const diff = computeDiff(s, { ...s, timestamp: s.timestamp + 5000 });
  const text = formatDiff(diff);
  assert(text.startsWith('✅'), 'starts with ✅');
  assert(text.includes('No changes'), 'says No changes');
});

test('formatDiff on changed diff returns 🔄', () => {
  const base = snapOf({ title: 'Old' });
  const curr = { ...snapOf({ title: 'New' }), timestamp: base.timestamp + 5000 };
  const diff = computeDiff(base, curr);
  const text = formatDiff(diff);
  assert(text.startsWith('🔄'), 'starts with 🔄');
  assert(text.includes('Title changed'), 'mentions title change');
});

test('formatDiff includes link additions', () => {
  const base = snapOf();
  const currPage = makePage({
    interactives: [
      { tag: 'a', text: 'Link One', href: 'https://example.com/1' },
      { tag: 'a', text: 'Link Two', href: 'https://example.com/2' },
      { tag: 'a', text: 'Brand New', href: 'https://example.com/brand-new' },
    ],
  });
  const curr = { ...buildSnapshot('https://example.com', currPage), timestamp: base.timestamp + 5000 };
  const diff = computeDiff(base, curr);
  const text = formatDiff(diff);
  assert(text.includes('Brand New') || text.includes('new link'), 'mentions new link');
});

// ─── DiffTracker class tests ──────────────────────────────────────────────────

console.log('\nDiffTracker');

function makeMockRender(pages = {}) {
  let callCount = 0;
  return async (url) => {
    callCount++;
    return pages[url] ?? makePage();
  };
}

await testAsync('constructor throws if no render', async () => {
  let threw = false;
  try { new DiffTracker(); } catch { threw = true; }
  assert(threw, 'threw without render');
});

await testAsync('snapshot() returns a PageSnapshot', async () => {
  const render = makeMockRender({ 'https://x.com': makePage({ title: 'X' }) });
  const tracker = new DiffTracker({ render });
  const snap = await tracker.snapshot('https://x.com');
  assertEqual(snap.url, 'https://x.com', 'url');
  assertEqual(snap.title, 'X', 'title');
});

await testAsync('setBaseline() stores baseline', async () => {
  const render = makeMockRender({ 'https://x.com': makePage() });
  const tracker = new DiffTracker({ render });
  await tracker.setBaseline('https://x.com');
  const baseline = tracker.getBaseline('https://x.com');
  assert(baseline !== null, 'baseline exists');
  assertEqual(baseline.url, 'https://x.com', 'baseline url');
});

await testAsync('diff() throws if no baseline set', async () => {
  const render = makeMockRender();
  const tracker = new DiffTracker({ render });
  let threw = false;
  try { await tracker.diff('https://x.com'); } catch { threw = true; }
  assert(threw, 'threw with no baseline');
});

await testAsync('diff() with explicit baseline detects change', async () => {
  const base = buildSnapshot('https://x.com', makePage({ title: 'Old' }));
  let callCount = 0;
  const render = async () => { callCount++; return makePage({ title: 'New' }); };
  const tracker = new DiffTracker({ render });
  const diff = await tracker.diff('https://x.com', base);
  assert(diff.changed, 'changed');
  assertEqual(callCount, 1, 'render called once');
  const titleChange = diff.changes.find(c => c.type === 'title');
  assert(titleChange, 'title change in diff');
});

await testAsync('diff() updates stored baseline after each call', async () => {
  let page = makePage({ title: 'V1' });
  const render = async () => ({ ...page });
  const tracker = new DiffTracker({ render });

  const base = buildSnapshot('https://x.com', makePage({ title: 'V0' }));
  await tracker.diff('https://x.com', base); // base=V0, current=V1 → stores V1

  page = makePage({ title: 'V2' });
  const diff2 = await tracker.diff('https://x.com'); // base=V1, current=V2
  assert(diff2.changed, 'detects V1→V2 change');
  assertEqual(diff2.baseline.title, 'V1', 'baseline is V1 not V0');
});

await testAsync('watch() calls onChange when content changes', async () => {
  let version = 0;
  const render = async () => makePage({ title: `Version ${version}` });
  const tracker = new DiffTracker({ render });

  // Seed baseline
  await tracker.setBaseline('https://x.com');
  version = 1; // change the page

  const diffs = [];
  const watcher = tracker.watch('https://x.com', {
    intervalMs: 10, // fast for testing
    onChange: (diff) => diffs.push(diff),
  });

  await new Promise(r => setTimeout(r, 80)); // wait for a few polls
  watcher.stop();

  assert(diffs.length > 0, 'at least one diff received');
  assert(diffs[0].changed, 'first diff shows change');
});

await testAsync('watch() does not call onChange when no change', async () => {
  const render = async () => makePage({ title: 'Same Page' });
  const tracker = new DiffTracker({ render });
  await tracker.setBaseline('https://x.com');

  const diffs = [];
  const watcher = tracker.watch('https://x.com', {
    intervalMs: 10,
    onChange: (diff) => diffs.push(diff),
    emitUnchanged: false,
  });

  await new Promise(r => setTimeout(r, 80));
  watcher.stop();

  assert(diffs.length === 0, 'no diffs when page does not change');
});

await testAsync('watch() emitUnchanged=true always fires onChange', async () => {
  const render = async () => makePage();
  const tracker = new DiffTracker({ render });
  await tracker.setBaseline('https://x.com');

  const diffs = [];
  const watcher = tracker.watch('https://x.com', {
    intervalMs: 10,
    onChange: (diff) => diffs.push(diff),
    emitUnchanged: true,
  });

  await new Promise(r => setTimeout(r, 80));
  watcher.stop();

  assert(diffs.length > 0, 'diffs emitted even without change');
});

await testAsync('watchAll() stops all watchers', async () => {
  const render = async () => makePage();
  const tracker = new DiffTracker({ render });

  let count = 0;
  const multi = tracker.watchAll(['https://a.com', 'https://b.com'], {
    intervalMs: 5,
    onChange: () => count++,
    emitUnchanged: false,
  });

  await new Promise(r => setTimeout(r, 50));
  multi.stop();
  const countAtStop = count;

  await new Promise(r => setTimeout(r, 50));
  // After stop, count should not increase
  assertEqual(count, countAtStop, 'no more diffs after stop');
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (errors.length > 0) {
  console.log('\nFailures:');
  for (const { name, error } of errors) {
    console.log(`  ❌ ${name}: ${error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
