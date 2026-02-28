#!/usr/bin/env node
/**
 * AgentWeb Interactive Module Tests
 *
 * Spins up a tiny local HTTP server with test HTML, runs real Playwright
 * interactions against it, and validates all new features.
 *
 * Run: node prototype/test-interactive.js
 * (requires: npm install in prototype/)
 */

import { createServer } from 'http';
import { InteractiveSession } from './interactive.js';

// ─── Test HTTP server ─────────────────────────────────────────────────────────

const TEST_PORT = 17890;

const pages = {
  '/': `<!DOCTYPE html>
<html><head><title>AgentWeb Test Page</title></head>
<body>
  <h1>Test Page</h1>
  <p id="greeting">Hello, Agent!</p>
  <a href="/form" id="form-link">Go to Form</a>
  <a href="/dynamic" id="dynamic-link">Go to Dynamic</a>
  <button id="btn-click" onclick="document.getElementById('click-result').textContent='clicked'">
    Click Me
  </button>
  <span id="click-result"></span>
  <ul id="list">
    <li class="item">Apple</li>
    <li class="item">Banana</li>
    <li class="item">Cherry</li>
  </ul>
</body></html>`,

  '/form': `<!DOCTYPE html>
<html><head><title>Form Test</title></head>
<body>
  <h1>Form Page</h1>
  <form id="test-form" action="/submit" method="POST">
    <input type="text" name="username" placeholder="Username" required>
    <input type="email" name="email" placeholder="Email">
    <input type="password" name="password" placeholder="Password">
    <textarea name="bio" placeholder="Bio"></textarea>
    <select name="role">
      <option value="">Select role</option>
      <option value="admin">Admin</option>
      <option value="user">User</option>
      <option value="guest">Guest</option>
    </select>
    <input type="checkbox" name="agree" id="agree-checkbox">
    <label for="agree-checkbox">I agree</label>
    <button type="submit" id="submit-btn">Submit</button>
  </form>
</body></html>`,

  '/submit': `<!DOCTYPE html>
<html><head><title>Submitted</title></head>
<body>
  <h1>Form Submitted!</h1>
  <p id="success">Thank you for your submission.</p>
</body></html>`,

  '/dynamic': `<!DOCTYPE html>
<html><head><title>Dynamic Page</title></head>
<body>
  <h1>Dynamic Content</h1>
  <button id="load-btn" onclick="
    setTimeout(() => {
      const el = document.createElement('div');
      el.id = 'loaded-content';
      el.textContent = 'Dynamic content loaded!';
      document.body.appendChild(el);
    }, 200)
  ">Load Content</button>
  <div id="placeholder">Waiting...</div>
</body></html>`,

  '/eval': `<!DOCTYPE html>
<html><head><title>Eval Test</title></head>
<body>
  <h1>Eval Page</h1>
  <script>window.agentData = { score: 42, name: "Clark" };</script>
  <div class="card" data-id="1">Card One</div>
  <div class="card" data-id="2">Card Two</div>
  <div class="card" data-id="3">Card Three</div>
</body></html>`,
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const page = pages[req.url] || `<html><body>404 Not Found: ${req.url}</body></html>`;
      const status = pages[req.url] ? 200 : 404;
      res.writeHead(status, { 'Content-Type': 'text/html' });
      res.end(page);
    });

    server.listen(TEST_PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

const BASE = `http://127.0.0.1:${TEST_PORT}`;

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    errors.push({ name, error: err });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n🌐 AgentWeb Interactive Tests');
  console.log('==============================\n');

  // Test 1: Basic start + snapshot
  await test('start() returns snapshot with elements', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      const snap = await sess.start(`${BASE}/`);
      assert(snap.title === 'AgentWeb Test Page', `title: "${snap.title}"`);
      assert(snap.url.includes(BASE));
      assert(snap.elementCount > 0, `elementCount=${snap.elementCount}`);
      assert(Array.isArray(snap.elements));
      assert(snap.elements.some(el => el.tag === 'a'), 'should have link elements');
      assert(snap.elements.some(el => el.tag === 'button'), 'should have button elements');
    } finally {
      await sess.close();
    }
  });

  // Test 2: snapshot() includes forms
  await test('snapshot() includes form structure', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      const snap = await sess.start(`${BASE}/form`);
      assert(Array.isArray(snap.forms), 'should have forms array');
      assert(snap.forms.length > 0, 'should have at least one form');
      const form = snap.forms[0];
      assert(form.fields.length >= 4, `expected >=4 fields, got ${form.fields.length}`);
      assert(form.fields.some(f => f.name === 'username'), 'should have username field');
      assert(form.fields.some(f => f.name === 'email'), 'should have email field');
    } finally {
      await sess.close();
    }
  });

  // Test 3: click() works
  await test('click() triggers JS event', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/`);
      // Click the "Click Me" button and wait for result
      const btnEl = (await sess.snapshot()).elements.find(el =>
        el.tag === 'button' && el.text.includes('Click Me')
      );
      assert(btnEl, 'should find Click Me button');
      const snap = await sess.click(btnEl.id);
      // Check that click-result now has content
      const result = await sess.extractText('#click-result');
      assertEqual(result, 'clicked', `click result: "${result}"`);
    } finally {
      await sess.close();
    }
  });

  // Test 4: goto() navigates
  await test('goto() navigates to a new URL', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/`);
      const snap = await sess.goto(`${BASE}/form`);
      assertEqual(snap.title, 'Form Test');
      assert(snap.url.includes('/form'));
    } finally {
      await sess.close();
    }
  });

  // Test 5: type() fills a field
  await test('type() fills input field', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      const snap = await sess.start(`${BASE}/form`);
      const userEl = snap.elements.find(el => el.placeholder === 'Username');
      assert(userEl, 'should find username input');
      await sess.type(userEl.id, 'testuser');
      const val = await sess.evaluate(() => document.querySelector('[name=username]').value);
      assertEqual(val, 'testuser');
    } finally {
      await sess.close();
    }
  });

  // Test 6: fillForm() fills multiple fields at once
  await test('fillForm() fills username, email, and bio', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/form`);
      const result = await sess.fillForm({
        username: 'clark235',
        email: 'test@example.com',
        bio: 'An AI agent.',
      });

      assert(result.filled.includes('username'), `filled: ${result.filled}`);
      assert(result.filled.includes('email'), `filled: ${result.filled}`);
      assert(result.filled.includes('bio'), `filled: ${result.filled}`);

      const vals = await sess.evaluate(() => ({
        username: document.querySelector('[name=username]').value,
        email: document.querySelector('[name=email]').value,
        bio: document.querySelector('[name=bio]').value,
      }));

      assertEqual(vals.username, 'clark235');
      assertEqual(vals.email, 'test@example.com');
      assertEqual(vals.bio, 'An AI agent.');
    } finally {
      await sess.close();
    }
  });

  // Test 7: fillForm() skips unknown fields
  await test('fillForm() reports skipped unknown fields', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/form`);
      const result = await sess.fillForm({
        username: 'alice',
        nonexistent_field_xyz: 'ignored',
      });
      assert(result.filled.includes('username'));
      assert(result.skipped.includes('nonexistent_field_xyz'),
             `skipped: ${result.skipped}`);
    } finally {
      await sess.close();
    }
  });

  // Test 8: select() chooses dropdown value
  await test('select() sets dropdown value', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      const snap = await sess.start(`${BASE}/form`);
      const selectEl = snap.elements.find(el => el.tag === 'select');
      assert(selectEl, 'should find select element');
      await sess.select(selectEl.id, 'admin');
      const val = await sess.evaluate(() => document.querySelector('[name=role]').value);
      assertEqual(val, 'admin');
    } finally {
      await sess.close();
    }
  });

  // Test 9: extractText() gets element text
  await test('extractText() gets text from selector', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/`);
      const text = await sess.extractText('#greeting');
      assertEqual(text, 'Hello, Agent!');
    } finally {
      await sess.close();
    }
  });

  // Test 10: extractText() with all=true gets multiple elements
  await test('extractText(all=true) returns array of texts', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/`);
      const items = await sess.extractText('.item', { all: true });
      assert(Array.isArray(items));
      assert(items.length === 3, `expected 3 items, got ${items.length}: ${items}`);
      assert(items.includes('Apple'));
      assert(items.includes('Banana'));
      assert(items.includes('Cherry'));
    } finally {
      await sess.close();
    }
  });

  // Test 11: extractAttribute() gets hrefs
  await test('extractAttribute() returns link hrefs', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/`);
      const hrefs = await sess.extractAttribute('a', 'href', { all: true });
      assert(Array.isArray(hrefs));
      assert(hrefs.length >= 2, `expected >=2 hrefs, got ${hrefs.length}`);
      assert(hrefs.some(h => h.includes('/form')), `hrefs: ${hrefs}`);
    } finally {
      await sess.close();
    }
  });

  // Test 12: evaluate() runs JS in page
  await test('evaluate() executes JavaScript in page context', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/eval`);
      const score = await sess.evaluate(() => window.agentData.score);
      assertEqual(score, 42, `score=${score}`);

      const name = await sess.evaluate(() => window.agentData.name);
      assertEqual(name, 'Clark');

      // With argument
      const cards = await sess.evaluate(
        (sel) => [...document.querySelectorAll(sel)].map(el => el.dataset.id),
        '.card'
      );
      assert(Array.isArray(cards));
      assertEqual(cards.length, 3);
    } finally {
      await sess.close();
    }
  });

  // Test 13: waitForText() waits for dynamic content
  await test('waitForText() waits for dynamically added content', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/dynamic`);

      // Click load button (triggers 200ms delay)
      const snap = await sess.snapshot();
      const btn = snap.elements.find(el => el.id === 0 || el.text.includes('Load Content'));
      assert(btn, 'should find Load Content button');
      await sess.click(btn.id);

      // Wait for the text to appear
      const result = await sess.waitForText('Dynamic content loaded!', { timeoutMs: 3000 });
      assert(result.textContent.includes('Dynamic content loaded!'),
             'text should be present in snapshot');
    } finally {
      await sess.close();
    }
  });

  // Test 14: waitForSelector() works
  await test('waitForSelector() detects element appearance', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/dynamic`);
      const snap = await sess.snapshot();
      const btn = snap.elements.find(el => el.text.includes('Load Content'));
      await sess.click(btn.id);
      const result = await sess.waitForSelector('#loaded-content', { timeoutMs: 3000 });
      const text = await sess.extractText('#loaded-content');
      assert(text.includes('Dynamic content loaded!'));
    } finally {
      await sess.close();
    }
  });

  // Test 15: back() and forward() navigation
  await test('back() and forward() work correctly', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/`);
      await sess.goto(`${BASE}/form`);
      assertEqual((await sess.snapshot()).title, 'Form Test');

      const backSnap = await sess.back();
      assertEqual(backSnap.title, 'AgentWeb Test Page', `back title: "${backSnap.title}"`);

      const fwdSnap = await sess.forward();
      assertEqual(fwdSnap.title, 'Form Test', `forward title: "${fwdSnap.title}"`);
    } finally {
      await sess.close();
    }
  });

  // Test 16: title() returns current page title
  await test('title() returns current page title', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/`);
      const t = await sess.title();
      assertEqual(t, 'AgentWeb Test Page');
    } finally {
      await sess.close();
    }
  });

  // Test 17: currentUrl() returns URL
  await test('currentUrl() returns current URL', async () => {
    const sess = new InteractiveSession({ headless: true });
    try {
      await sess.start(`${BASE}/`);
      const url = sess.currentUrl();
      assert(url.includes(BASE), `url: ${url}`);
    } finally {
      await sess.close();
    }
  });

  // Test 18: close() cleans up
  await test('close() cleans up session resources', async () => {
    const sess = new InteractiveSession({ headless: true });
    await sess.start(`${BASE}/`);
    await sess.close();
    assert(sess.browser === null, 'browser should be null after close');
    assert(sess.page === null, 'page should be null after close');

    try {
      await sess.snapshot();
      assert(false, 'should have thrown');
    } catch (err) {
      assert(err.message.includes('No active session'));
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let server;
try {
  server = await startServer();
  console.log(`Test server: ${BASE}`);

  await runTests();

} finally {
  if (server) server.close();
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\n❌ Some tests failed');
  if (errors.length) {
    console.log('\nFailed tests:');
    errors.forEach(({ name, error }) => console.log(`  • ${name}: ${error.message}`));
  }
  process.exit(1);
} else {
  console.log('\n✅ All tests passed');
}
