# AgentWeb 🌐

*The web, rendered for agents.*

Headless web rendering that extracts structured, actionable data for AI agents — not raw HTML, not screenshots, but semantic understanding.

## The Problem

Today's agents interact with the web poorly:
1. **HTML scraping** — Brittle, misses dynamic content, breaks constantly
2. **Browser automation** — Heavy, simulates human clicks, slow

## The Solution

AgentWeb renders pages and outputs **structured representations** optimized for LLMs:

```bash
# Render a page
npx agentweb https://news.ycombinator.com --summary

# Output:
📄 Hacker News
🔗 https://news.ycombinator.com/

🎯 Interactive Elements: 226
📋 Forms: 1 (search with 1 field)

🔗 Links (top 10):
  • Claude's C Compiler vs. GCC
  • Show HN: I built a thing...
  ...
```

## Quick Start

```bash
cd prototype
npm install

# Render to JSON
node cli.js https://example.com

# Human-readable summary  
node cli.js https://example.com --summary

# With screenshot
node cli.js https://example.com --screenshot
```

## What It Extracts

- **Title & metadata** — Page title, description, keywords
- **Structure** — Heading hierarchy (h1-h6)
- **Interactive elements** — Links, buttons, inputs with bounds
- **Forms** — Fields, types, required flags
- **Main content** — Primary text (truncated)
- **Stats** — Element counts for quick assessment

## Output Format

```json
{
  "title": "Example Domain",
  "url": "https://example.com/",
  "headings": [{"level": 1, "text": "Example Domain"}],
  "interactives": [
    {"id": 0, "tag": "a", "text": "More info", "href": "..."}
  ],
  "forms": [],
  "textContent": "...",
  "stats": {"interactiveCount": 1, "formCount": 0}
}
```

## Roadmap

### Phase 1: Core Renderer ✅
- [x] Playwright-based headless rendering
- [x] Structured data extraction
- [x] CLI interface
- [x] JSON output format

### Phase 2: Agent Integration ✅
- [x] OpenClaw skill integration (20 tool functions)
- [x] Action execution (click, type, select, submit)
- [x] **Form auto-fill** — fill all fields at once with `fillForm(data)`
- [x] **Wait helpers** — `waitForText()`, `waitForSelector()`
- [x] **Content extraction** — `extractText(selector)`, `extractAttribute(selector, attr)`
- [x] **Page evaluation** — run arbitrary JS with `evaluate(fn)`
- [x] **Navigation** — back, forward, reload, goto
- [x] Session persistence (cookies/auth preserved within session)
- [x] SQLite cache (49x speedup on repeated requests)

### Phase 3: Page Change Detection ✅
- [x] **DiffTracker** — snapshot pages and detect semantic changes
- [x] **Watch mode** — poll URLs at interval, fire callback on change
- [x] Tracks: title, headings, text content, links added/removed, numeric values, forms
- [x] Severity scoring: high/medium/low per change type
- [x] `formatDiff()` — agent-readable change summary
- [x] `watchAll()` — monitor multiple URLs simultaneously

### Phase 4: Playwright DiffTracker (SPA support) ✅
- [x] **`playwright-diff.js`** — full Playwright browser backend for DiffTracker
- [x] **`PlaywrightRenderer`** — persistent browser instance, reused across renders (fast)
- [x] **`PlaywrightDiffTracker`** — drop-in DiffTracker subclass; handles browser lifecycle
- [x] **`diffPages(url)`** — one-shot helper: snapshot → wait → diff → result
- [x] **`watchPage(url, opts)`** — high-level watcher with browser lifecycle management
- [x] `storageState` support — watch authenticated pages (pass cookies/localStorage)
- [x] `waitForSelector` support — wait for SPA content to render before snapshotting
- [x] **35-test suite** (`test-playwright-diff.js`) — all tests run without a real browser (mock renderer)

### Phase 5: Agent Accessibility Standard
- [ ] Define `<agent-hint>` elements
- [ ] Propose W3C extension
- [ ] Build adoption tools

## Interactive Sessions

```javascript
import { sessionOpen, sessionFillForm, sessionWaitForText, sessionExtractText } from 'agentweb/skill';

// Open a session
const { sessionId, state } = await sessionOpen('https://example.com/login');

// Fill the whole form in one call (matches by name, id, placeholder, or aria-label)
const { filled, skipped } = await sessionFillForm(sessionId, {
  username: 'alice',
  password: 'secret123',
}, { submitSelector: '#login-btn' });

// Wait for the success message
await sessionWaitForText(sessionId, 'Welcome back', { timeoutMs: 5000 });

// Extract specific content
const userName = await sessionExtractText(sessionId, '.user-display-name');
console.log('Logged in as:', userName);

// Run arbitrary JS
const token = await sessionEvaluate(sessionId, 'return localStorage.getItem("auth_token")');
```

## Why Not Just Use Playwright?

Playwright gives you browser control. AgentWeb gives you **understanding**.

| Feature | Raw Playwright | AgentWeb |
|---------|---------------|----------|
| Output | Screenshots/HTML | Structured JSON |
| Token cost | High (images) | Low (text) |
| Actionable | Manual parsing | Direct references |
| Agent-optimized | No | Yes |

## Page Change Detection

Watch pages for updates — agents can subscribe to changes without scraping raw HTML:

```javascript
import { DiffTracker, formatDiff } from 'agentweb';
import { render } from 'agentweb';

const tracker = new DiffTracker({ render });

// One-shot: compare two snapshots
const snap1 = await tracker.snapshot('https://news.ycombinator.com');
// ... wait ...
const diff = await tracker.diff('https://news.ycombinator.com', snap1);
console.log(formatDiff(diff));
// 🔄 Changes detected at https://news.ycombinator.com
//    Age: 300s | Changes: 2
// 🔴 Main content changed (~35% word count delta, 420 words)
// 🟡 12 new link(s) appeared
//      + Claude's C Compiler vs. GCC
//      + Show HN: I built a thing...
//      ... and 10 more

// Watch mode: poll every 5 minutes
const watcher = tracker.watch('https://example.com/prices', {
  intervalMs: 5 * 60_000,
  onChange: (diff) => {
    if (diff.changes.some(c => c.type === 'numbers')) {
      console.log('Prices changed!', diff.summary);
    }
  },
});

// Stop watching
watcher.stop();
```

### What Gets Tracked

| Change Type | Severity | Description |
|-------------|----------|-------------|
| `title` | 🔴 high | Page title changed |
| `text_content` | 🔴/🟡/🔵 | Main content hash changed |
| `numbers` | 🟡 medium | Prices/counts changed |
| `headings` | 🟡 medium | Section headings added/removed |
| `links_added` | 🔵/🟡 low/medium | New links appeared |
| `links_removed` | 🔵/🟡 low/medium | Links disappeared |
| `forms` | 🟡 medium | Forms added/removed |

## Playwright DiffTracker (SPA Support)

The standard `DiffTracker` accepts any render function. For React/Vue/Angular SPAs that
render content via JavaScript, use `PlaywrightDiffTracker` — backed by a real Chromium
browser that stays open across renders (fast).

```javascript
import { PlaywrightDiffTracker, watchPage, diffPages, formatDiff } from 'agentweb/playwright-diff';

// ── One-shot diff (snapshot → 5s wait → snapshot → compare) ──────────────────
const { diff, close } = await diffPages('https://news.ycombinator.com', {
  delayMs: 10_000,
});
console.log(formatDiff(diff));
await close(); // shuts down Chromium

// ── Watch a page for changes ──────────────────────────────────────────────────
const { stop } = watchPage('https://example.com/prices', {
  intervalMs: 5 * 60_000,
  onChange: (diff) => {
    if (diff.changes.some(c => c.type === 'numbers')) {
      console.log('Prices changed!', diff.summary);
    }
    console.log(formatDiff(diff));
  },
});

// Stop and close browser after 1 hour
setTimeout(stop, 60 * 60_000);

// ── Watch an authenticated page (pass cookies) ────────────────────────────────
const tracker = new PlaywrightDiffTracker({
  rendererOptions: {
    storageState: {
      cookies: [{ name: 'auth', value: 'token123', domain: 'example.com', path: '/' }],
    },
  },
});

await tracker.setBaseline('https://example.com/dashboard');
// ... later ...
const diff = await tracker.diff('https://example.com/dashboard');
console.log(formatDiff(diff));
await tracker.close(); // always close when done
```

### Renderer Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `headless` | boolean | `true` | Show browser window |
| `timeout` | number | `30000` | Navigation timeout (ms) |
| `waitUntil` | string | `'networkidle'` | Playwright wait strategy |
| `waitMs` | number | — | Extra wait after load (for slow SPAs) |
| `waitForSelector` | string | — | Wait for CSS selector before snapshot |
| `storageState` | object | — | Cookies/localStorage for auth |
| `userAgent` | string | AgentWeb UA | Custom user agent |

### Lite vs Playwright Backend

| | `DiffTracker` (lite) | `PlaywrightDiffTracker` |
|---|---|---|
| SPA support | ❌ | ✅ |
| Speed | ⚡ fast (HTTP) | 🐌 slower (browser) |
| Auth (cookies) | ❌ | ✅ |
| CI friendly | ✅ | Needs Playwright installed |
| Dependencies | none | `playwright` + Chromium |

Use the lite backend for static sites and news aggregators; use Playwright for SPAs and
pages that require login or client-side rendering.

## HTTP API (WatchServer)

Start the server: `npm run watch-server` (port 7376) or `npm run playwright-watch-server` (port 7377).

### One-shot Endpoints

```bash
# Render a single page (no state, no watch)
curl -X POST http://localhost:7376/render \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}'
# → { url, title, headings, links, textContent, stats, renderedAt }

# Render multiple pages in parallel (up to 20)
curl -X POST http://localhost:7376/render/batch \
  -H 'Content-Type: application/json' \
  -d '{"urls": ["https://a.com", "https://b.com"], "maxChars": 3000}'
# → { results: [...], summary: { total, succeeded, failed, timingMs } }

# Extract + chunk with relevance scoring
curl -X POST http://localhost:7376/extract \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "query": "pricing", "maxChunks": 5}'
# → { url, title, chunks: [{ type, text, section, relevanceScore }], totalChunks }
```

### Watch Endpoints

```bash
# Create a watch (poll every 60s)
curl -X POST http://localhost:7376/watches \
  -d '{"url": "https://example.com/prices", "intervalMs": 60000}'

# Get diff since baseline
curl http://localhost:7376/watches/{id}/diff

# Ask a question about the page
curl -X POST http://localhost:7376/watches/{id}/query \
  -d '{"question": "what is the current price?"}'

# SSE change stream
curl http://localhost:7376/events
```

### All Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server status + metrics |
| GET | `/metrics` | Prometheus-format counters |
| POST | `/render` | One-shot render (no state) |
| POST | `/render/batch` | Render up to 20 URLs in parallel |
| POST | `/extract` | Render + semantic chunking |
| POST | `/watches` | Create a page watch |
| GET | `/watches` | List all watches |
| GET | `/watches/:id` | Watch details |
| DELETE | `/watches/:id` | Stop a watch |
| GET | `/watches/:id/diff` | Current diff vs baseline |
| POST | `/watches/:id/snapshot` | Take immediate snapshot |
| POST | `/watches/:id/baseline` | Reset baseline |
| POST | `/watches/:id/query` | Ask question about page |
| GET | `/watches/:id/query-history` | Past queries + answers |
| GET | `/events` | SSE stream (all changes) |
| GET | `/watches/:id/events` | SSE stream (per watch) |

## Related

- Designed to run on [CarapaceOS](../carapaceos/)
- Part of the OpenClaw ecosystem
