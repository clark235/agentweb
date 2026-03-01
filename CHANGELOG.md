# Changelog

All notable changes to `agentweb` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.0] — 2026-03-01

### Added

- **`PlaywrightWatchServer`** (`prototype/playwright-watch-server.js`) — HTTP watch server backed by real Playwright/Chromium browser
  - Same REST API as `WatchServer` (lite renderer) but uses headless Chromium under the hood
  - Runs on port `7377` by default (lite server runs on `7376`) — run both side-by-side
  - Supports all existing endpoints: `POST /watches`, `GET /watches/:id/diff`, `GET /events` (SSE), etc.
  - Extra endpoints: `GET /browser` (browser status: connected, version, contexts) and `POST /browser/restart`
  - Per-watch `waitForSelector` and `waitMs` options for SPA stabilization
  - `onError` SSE events: agents receive error notifications in real time
  - Pre-warms the Playwright browser at startup (not on first request)
  - Graceful shutdown: stops all watchers, closes browser, waits for server drain

- **`prototype/test-playwright-watch-server.js`** — 17-test suite, all green
  - Tests all HTTP endpoints using a mock DiffTracker (no Playwright install required)
  - Covers: create/list/get/delete watches, baseline, diff, metrics, SSE, 404, validation

- **`"./playwright-watch-server"` export** in package.json exports map

- **`playwright-watch-server` npm script** — start with `npm run playwright-watch-server`

- **`test:playwright-watch-server` npm script** — run with `npm run test:playwright-watch-server`

### Changed

- Version bumped to `0.3.0`
- `test:all` now includes `test:playwright-watch-server`

---

## [0.2.1] — 2026-02-28

### Added

- **Playwright-backed DiffTracker** (`prototype/playwright-diff.js`) — `PlaywrightDiffTracker` class
  - `PlaywrightRenderer` — persistent Chromium browser, reused across calls
  - Supports `storageState`, `waitForSelector`, `waitMs` per-render options
  - `diffPages(url, opts)` — one-shot baseline → wait → diff
  - `watchPage(url, opts)` — watcher with auto browser lifecycle
  - Re-exports `buildSnapshot`, `computeDiff`, `formatDiff` from `diff-tracker.js`

- **`prototype/test-playwright-diff.js`** — 35 tests, all green
  - Tests `buildSnapshot()`, `computeDiff()`, `formatDiff()`, `DiffTracker` mock, edge cases

- **`"./playwright-diff"` export** in package.json exports map

- **`test:playwright-diff` npm script**

---

## [0.2.0] — 2026-02-26

### Added

- **WatchServer** (`prototype/watch-server.js`) — HTTP REST server + SSE change events
  - Full watch lifecycle API (create/list/get/delete/snapshot/baseline/diff)
  - SSE global stream (`/events`) and per-watch stream (`/watches/:id/events`)
  - Prometheus-format `/metrics`
  - Default port: `7376`

- **DiffTracker** (`prototype/diff-tracker.js`)
  - `buildSnapshot(url, raw)` — create structured snapshot from renderer output
  - `computeDiff(baseline, current)` — diff two snapshots (titles, headings, links, numbers, text)
  - `formatDiff(diff)` — human-readable diff string
  - `DiffTracker` class — stateful watcher with `setBaseline`, `diff`, `watch`, `watchAll`

---

## [0.1.0] — 2026-02-24

### Added

- Initial release: headless HTML renderer (lite + Playwright), cache, CLI, smart renderer, interactive sessions
