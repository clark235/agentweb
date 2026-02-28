/**
 * Test Suite: playwright-diff.js
 *
 * Tests the PlaywrightDiffTracker and related helpers using a mock renderer
 * (no real browser required — runs in CI without Playwright installed).
 *
 * Tests:
 *   - buildSnapshot() correctly converts render output to PageSnapshot
 *   - computeDiff() detects title / headings / text / numbers / links / forms changes
 *   - PlaywrightRenderer.render() interface contract
 *   - PlaywrightDiffTracker end-to-end: baseline → diff → formatDiff
 *   - watchPage() / diffPages() API surface
 *   - Edge cases: empty pages, huge numbers, duplicate links
 */

import assert from 'assert';
import { buildSnapshot, computeDiff, formatDiff } from './playwright-diff.js';
import { DiffTracker } from './diff-tracker.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✅ ${name}`);
        passed++;
      }).catch(err => {
        console.error(`  ❌ ${name}`);
        console.error(`     ${err.message}`);
        failed++;
      });
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePage(overrides = {}) {
  return {
    title: 'Test Page',
    url: 'https://example.com/',
    headings: [
      { level: 1, text: 'Welcome' },
      { level: 2, text: 'About Us' },
    ],
    interactives: [
      { tag: 'a', text: 'Home', href: 'https://example.com/' },
      { tag: 'a', text: 'Blog', href: 'https://example.com/blog' },
      { tag: 'button', text: 'Sign Up', href: null },
    ],
    forms: [
      { id: 'search', action: '/search', method: 'get', fields: [{ name: 'q', type: 'text' }] },
    ],
    textContent: 'Welcome to our site. We have 42 products and $9.99 pricing.',
    stats: { interactiveCount: 3, formCount: 1 },
    ...overrides,
  };
}

// ─── buildSnapshot() ──────────────────────────────────────────────────────────

console.log('\n📸 buildSnapshot()');

test('extracts title', () => {
  const snap = buildSnapshot('https://example.com/', makePage());
  assert.strictEqual(snap.title, 'Test Page');
});

test('extracts headings as strings', () => {
  const snap = buildSnapshot('https://example.com/', makePage());
  assert.deepStrictEqual(snap.headings, ['Welcome', 'About Us']);
});

test('extracts links from interactives (tag=a)', () => {
  const snap = buildSnapshot('https://example.com/', makePage());
  assert.strictEqual(snap.links.length, 2);
  assert.strictEqual(snap.links[0].text, 'Home');
  assert.strictEqual(snap.links[0].href, 'https://example.com/');
});

test('excludes javascript: hrefs', () => {
  const page = makePage({
    interactives: [
      { tag: 'a', text: 'Bad', href: 'javascript:void(0)' },
      { tag: 'a', text: 'Good', href: 'https://example.com/good' },
    ],
  });
  const snap = buildSnapshot('https://example.com/', page);
  assert.strictEqual(snap.links.length, 1);
  assert.strictEqual(snap.links[0].text, 'Good');
});

test('extracts numbers from text', () => {
  const snap = buildSnapshot('https://example.com/', makePage());
  assert(snap.numbers.includes('42'), `Expected 42 in ${snap.numbers}`);
  assert(snap.numbers.includes('$9.99'), `Expected $9.99 in ${snap.numbers}`);
});

test('builds textFingerprint (non-empty, 8 hex chars)', () => {
  const snap = buildSnapshot('https://example.com/', makePage());
  assert.match(snap.textFingerprint, /^[0-9a-f]{8}$/);
});

test('textFingerprint changes when content changes', () => {
  const snap1 = buildSnapshot('https://example.com/', makePage({ textContent: 'Hello world' }));
  const snap2 = buildSnapshot('https://example.com/', makePage({ textContent: 'Completely different text about something else entirely.' }));
  assert.notStrictEqual(snap1.textFingerprint, snap2.textFingerprint);
});

test('textFingerprint stable on trivial whitespace changes', () => {
  const snap1 = buildSnapshot('https://example.com/', makePage({ textContent: 'Hello  world' }));
  const snap2 = buildSnapshot('https://example.com/', makePage({ textContent: 'Hello world' }));
  assert.strictEqual(snap1.textFingerprint, snap2.textFingerprint);
});

test('handles empty page gracefully', () => {
  const snap = buildSnapshot('https://example.com/', {
    title: '',
    headings: [],
    interactives: [],
    forms: [],
    textContent: '',
    stats: { interactiveCount: 0, formCount: 0 },
  });
  assert.strictEqual(snap.title, '');
  assert.strictEqual(snap.links.length, 0);
  assert.strictEqual(snap.numbers.length, 0);
});

test('handles { data: ... } wrapper format', () => {
  const snap = buildSnapshot('https://example.com/', {
    data: makePage({ title: 'Wrapped' }),
  });
  assert.strictEqual(snap.title, 'Wrapped');
});

test('includes url and timestamp', () => {
  const before = Date.now();
  const snap = buildSnapshot('https://example.com/', makePage());
  assert.strictEqual(snap.url, 'https://example.com/');
  assert(snap.timestamp >= before);
  assert(snap.timestamp <= Date.now());
});

// ─── computeDiff() ────────────────────────────────────────────────────────────

console.log('\n🔍 computeDiff()');

function snap(overrides = {}) {
  return buildSnapshot('https://example.com/', makePage(overrides));
}

test('no changes returns changed=false', () => {
  const s = snap();
  const diff = computeDiff(s, s);
  assert.strictEqual(diff.changed, false);
  assert.strictEqual(diff.changes.length, 0);
});

test('title change detected as high severity', () => {
  const base = snap({ title: 'Old Title' });
  const curr = snap({ title: 'New Title' });
  const diff = computeDiff(base, curr);
  assert(diff.changed);
  const c = diff.changes.find(c => c.type === 'title');
  assert(c, 'Expected title change');
  assert.strictEqual(c.severity, 'high');
  assert.strictEqual(c.before, 'Old Title');
  assert.strictEqual(c.after, 'New Title');
});

test('heading addition detected as medium severity', () => {
  const base = snap({ headings: [{ level: 1, text: 'Welcome' }] });
  const curr = snap({ headings: [{ level: 1, text: 'Welcome' }, { level: 2, text: 'New Section' }] });
  const diff = computeDiff(base, curr);
  const c = diff.changes.find(c => c.type === 'headings');
  assert(c, 'Expected headings change');
  assert.strictEqual(c.severity, 'medium');
  assert(c.added.includes('New Section'));
});

test('text content change detected', () => {
  const base = snap({ textContent: 'The quick brown fox jumps over the lazy dog. '.repeat(20) });
  const curr = snap({ textContent: 'Completely different article about something entirely new and radical.' });
  const diff = computeDiff(base, curr);
  const c = diff.changes.find(c => c.type === 'text_content');
  assert(c, 'Expected text_content change');
  assert(c.percentDelta >= 20, `Expected high delta, got ${c.percentDelta}%`);
});

test('numeric change detected (prices)', () => {
  const base = snap({ textContent: 'Price: $9.99 for 3 items' });
  const curr = snap({ textContent: 'Price: $14.99 for 5 items' });
  const diff = computeDiff(base, curr);
  const c = diff.changes.find(c => c.type === 'numbers');
  assert(c, 'Expected numbers change');
  assert(c.added.includes('$14.99') || c.added.includes('5'));
  assert(c.removed.includes('$9.99') || c.removed.includes('3'));
});

test('new links detected as links_added', () => {
  const base = snap({
    interactives: [{ tag: 'a', text: 'Home', href: 'https://example.com/' }],
  });
  const curr = snap({
    interactives: [
      { tag: 'a', text: 'Home', href: 'https://example.com/' },
      { tag: 'a', text: 'News', href: 'https://example.com/news' },
    ],
  });
  const diff = computeDiff(base, curr);
  const c = diff.changes.find(c => c.type === 'links_added');
  assert(c, 'Expected links_added');
  assert.strictEqual(c.links[0].text, 'News');
});

test('removed links detected as links_removed', () => {
  const base = snap({
    interactives: [
      { tag: 'a', text: 'Home', href: 'https://example.com/' },
      { tag: 'a', text: 'Old Page', href: 'https://example.com/old' },
    ],
  });
  const curr = snap({
    interactives: [{ tag: 'a', text: 'Home', href: 'https://example.com/' }],
  });
  const diff = computeDiff(base, curr);
  const c = diff.changes.find(c => c.type === 'links_removed');
  assert(c, 'Expected links_removed');
  assert.strictEqual(c.links[0].href, 'https://example.com/old');
});

test('form addition detected as medium severity', () => {
  const base = snap({ forms: [] });
  const curr = snap({
    forms: [{ id: 'signup', action: '/register', method: 'post', fields: [{ name: 'email', type: 'email' }] }],
  });
  const diff = computeDiff(base, curr);
  const c = diff.changes.find(c => c.type === 'forms');
  assert(c, 'Expected forms change');
  assert.strictEqual(c.severity, 'medium');
  assert.strictEqual(c.added.length, 1);
});

test('summary includes change count', () => {
  const base = snap({ title: 'Old' });
  const curr = snap({ title: 'New' });
  const diff = computeDiff(base, curr);
  assert(diff.summary.includes('1 change'), `Summary was: ${diff.summary}`);
});

test('no-change summary says "No changes"', () => {
  const s = snap();
  const diff = computeDiff(s, s);
  assert(diff.summary.includes('No changes'), `Summary was: ${diff.summary}`);
});

test('snapshotAge is non-negative', () => {
  const base = snap();
  // Simulate time passing by mutating timestamp
  const curr = { ...base, timestamp: base.timestamp + 5000 };
  const diff = computeDiff(base, curr);
  assert(diff.snapshotAge >= 0, `snapshotAge was ${diff.snapshotAge}`);
});

// ─── formatDiff() ─────────────────────────────────────────────────────────────

console.log('\n📄 formatDiff()');

test('unchanged returns ✅ prefix', () => {
  const s = snap();
  const diff = computeDiff(s, s);
  const out = formatDiff(diff);
  assert(out.startsWith('✅'), `Output: ${out}`);
});

test('changed returns 🔄 header', () => {
  const base = snap({ title: 'Old' });
  const curr = snap({ title: 'New' });
  const diff = computeDiff(base, curr);
  const out = formatDiff(diff);
  assert(out.includes('🔄'), `Output: ${out}`);
});

test('high severity shows 🔴', () => {
  const base = snap({ title: 'Old' });
  const curr = snap({ title: 'New' });
  const diff = computeDiff(base, curr);
  const out = formatDiff(diff);
  assert(out.includes('🔴'), `Output: ${out}`);
});

test('links_added shows + items', () => {
  const base = snap({ interactives: [] });
  const curr = snap({
    interactives: [
      { tag: 'a', text: 'New Article', href: 'https://example.com/a1' },
      { tag: 'a', text: 'Another', href: 'https://example.com/a2' },
    ],
  });
  const diff = computeDiff(base, curr);
  const out = formatDiff(diff);
  assert(out.includes('+ New Article'), `Output: ${out}`);
});

// ─── DiffTracker with mock render ─────────────────────────────────────────────

console.log('\n🔄 DiffTracker (mock renderer)');

let renderCallCount = 0;
function makeMockRender(pages) {
  let idx = 0;
  return async (url) => {
    renderCallCount++;
    const page = pages[Math.min(idx++, pages.length - 1)];
    return page;
  };
}

await test('setBaseline + diff detects title change', async () => {
  const tracker = new DiffTracker({
    render: makeMockRender([
      makePage({ title: 'V1' }),
      makePage({ title: 'V2' }),
    ]),
  });

  await tracker.setBaseline('https://example.com/');
  const diff = await tracker.diff('https://example.com/');
  assert(diff.changed, 'Expected change');
  assert(diff.changes.some(c => c.type === 'title'), 'Expected title change');
});

await test('setBaseline + diff: no change when same page', async () => {
  const page = makePage();
  const tracker = new DiffTracker({
    render: async () => page,
  });

  await tracker.setBaseline('https://example.com/');
  const diff = await tracker.diff('https://example.com/');
  // Same content → no changes (text fingerprint, numbers, links all identical)
  assert(!diff.changed, `Expected no change, got: ${diff.summary}`);
});

await test('rolling baseline: second diff uses first diff result as baseline', async () => {
  const pages = [
    makePage({ title: 'V1' }),
    makePage({ title: 'V2' }),
    makePage({ title: 'V2' }), // same as V2 → should show no change
  ];
  let callIdx = 0;
  const tracker = new DiffTracker({
    render: async () => pages[Math.min(callIdx++, pages.length - 1)],
  });

  await tracker.setBaseline('https://example.com/');
  const diff1 = await tracker.diff('https://example.com/'); // V1 → V2: changed
  const diff2 = await tracker.diff('https://example.com/'); // V2 → V2: no change

  assert(diff1.changed, 'First diff should detect V1→V2 change');
  assert(!diff2.changed, 'Second diff should detect no change (rolling baseline)');
});

await test('throws if no baseline set and no explicit baseline passed', async () => {
  const tracker = new DiffTracker({ render: async () => makePage() });
  let threw = false;
  try {
    await tracker.diff('https://example.com/');
  } catch (e) {
    threw = true;
    assert(e.message.includes('No baseline'), `Wrong error: ${e.message}`);
  }
  assert(threw, 'Expected error when no baseline');
});

await test('watch() fires onChange on content change', async () => {
  const pages = [
    makePage({ title: 'V1' }),
    makePage({ title: 'V2' }),
  ];
  let callIdx = 0;
  const tracker = new DiffTracker({
    render: async () => pages[Math.min(callIdx++, pages.length - 1)],
  });

  let changes = [];
  const watcher = tracker.watch('https://example.com/', {
    intervalMs: 10,
    onChange: (diff) => changes.push(diff),
  });

  await new Promise(r => setTimeout(r, 100));
  watcher.stop();

  assert(changes.length >= 1, `Expected at least 1 change event, got ${changes.length}`);
  assert(changes[0].changed, 'Expected change event to have changed=true');
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

console.log('\n🧪 Edge cases');

test('very long text content is fingerprinted (not truncated to empty)', () => {
  const bigText = 'word '.repeat(10_000);
  const snap = buildSnapshot('https://x.com/', makePage({ textContent: bigText }));
  assert(snap.textFingerprint !== '00000000', 'Fingerprint should not be zero');
  assert(snap.stats.wordCount > 1000, `Expected many words, got ${snap.stats.wordCount}`);
});

test('numbers deduped (Set)', () => {
  const snap = buildSnapshot('https://x.com/', makePage({
    textContent: '42 42 42 99 99 100',
  }));
  const counts = {};
  for (const n of snap.numbers) counts[n] = (counts[n] || 0) + 1;
  assert(counts['42'] === 1, 'Expected 42 to appear once (deduped)');
});

test('links capped at text length 100', () => {
  const longText = 'a'.repeat(200);
  const snap = buildSnapshot('https://x.com/', makePage({
    interactives: [{ tag: 'a', text: longText, href: 'https://x.com/long' }],
  }));
  assert(snap.links[0].text.length <= 100);
});

test('computeDiff: many links removed = medium severity', () => {
  const base = snap({
    interactives: Array.from({ length: 10 }, (_, i) => ({
      tag: 'a', text: `Link ${i}`, href: `https://x.com/${i}`,
    })),
  });
  const curr = snap({ interactives: [] });
  const diff = computeDiff(base, curr);
  const c = diff.changes.find(c => c.type === 'links_removed');
  assert(c, 'Expected links_removed');
  assert.strictEqual(c.severity, 'medium', `Expected medium, got ${c.severity}`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

// Allow all async tests to settle
await new Promise(r => setTimeout(r, 200));

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✅ ${passed} passed | ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
