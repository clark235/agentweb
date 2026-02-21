/**
 * AgentWeb Smart Renderer
 *
 * Automatically detects if a page is a SPA (Single Page App) that requires
 * JavaScript rendering, and routes to the appropriate backend:
 *
 *   - Static pages → lite-renderer.js (fast, zero-dependency, ~50-300ms)
 *   - JS-heavy SPAs → Playwright Chromium (full rendering, ~2-8s)
 *
 * Detection heuristics (all run against raw HTML before any JS execution):
 *   1. Almost no visible text despite large HTML (JS-generated content)
 *   2. Common SPA framework signals in HTML (React, Vue, Angular, Next, Svelte)
 *   3. Skeleton/loading div patterns
 *   4. meta generator = known SPA framework
 *   5. Explicit user override via { force: 'lite' | 'playwright' }
 *
 * Usage:
 *   import { render } from './smart-renderer.js';
 *
 *   const result = await render('https://github.com/trending');
 *   // → { backend: 'playwright', data: {...}, ms: 3200 }
 *
 *   const fast = await render('https://news.ycombinator.com');
 *   // → { backend: 'lite', data: {...}, ms: 180 }
 */

import { renderLite } from './lite-renderer.js';
import { chunkPage, findRelevant, formatChunks } from './semantic-chunks.js';
import { PageCache } from './cache.js';

// ─── Module-level shared cache instance ─────────────────────────────────────
// Shared across all render() calls in the same process.
// TTL: 10 min for lite pages, 5 min for playwright (JS-heavy pages change faster)
let _cache = null;

function getCache() {
  if (!_cache) {
    _cache = new PageCache({
      ttlMs: 10 * 60 * 1000,   // default 10 min
      maxEntries: 200,
      verbose: false,
    });
    // Purge expired on startup
    _cache.purgeExpired();
  }
  return _cache;
}

/**
 * Get cache statistics (for debugging/monitoring).
 */
export function cacheStats() {
  return getCache().stats();
}

/**
 * Invalidate cached entries for a URL.
 */
export function invalidateCache(url) {
  return getCache().invalidate(url);
}

// ─── SPA Detection ──────────────────────────────────────────────────────────

/**
 * Fetch raw HTML without executing JS.
 */
async function fetchRaw(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'AgentWeb/0.2 (ai-agent-browser)',
                'Accept': 'text/html,application/xhtml+xml',
            },
            redirect: 'follow',
        });
        const html = await res.text();
        return { html, status: res.status, contentType: res.headers.get('content-type') || '' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Detect if a page needs JS rendering.
 * Returns { isSPA: bool, reasons: string[], confidence: 'low'|'medium'|'high' }
 */
export function detectSPA(html) {
    const reasons = [];
    let score = 0;

    // 1. Known SPA framework signals in HTML
    const spaSignals = [
        { pattern: /<div\s+id=["']root["']\s*><\/div>/i, reason: 'React root div (empty)', weight: 4 },
        { pattern: /<div\s+id=["']app["']\s*><\/div>/i, reason: 'Vue/React app div (empty)', weight: 4 },
        { pattern: /<div\s+id=["']__next["']/i, reason: 'Next.js root', weight: 3 },
        { pattern: /<app-root>/i, reason: 'Angular app-root', weight: 4 },
        { pattern: /data-reactroot/i, reason: 'React data attribute', weight: 3 },
        { pattern: /data-vue-app/i, reason: 'Vue 3 attribute', weight: 4 },
        { pattern: /ng-version=/i, reason: 'Angular version attribute', weight: 3 },
        { pattern: /__nuxt/i, reason: 'Nuxt.js signal', weight: 2 },
        { pattern: /window\.__NEXT_DATA__/i, reason: 'Next.js data hydration', weight: 3 },
        { pattern: /window\.__INITIAL_STATE__/i, reason: 'Redux initial state', weight: 2 },
        { pattern: /svelte-/i, reason: 'Svelte component', weight: 2 },
        { pattern: /ember-application/i, reason: 'Ember.js', weight: 3 },
    ];

    for (const { pattern, reason, weight } of spaSignals) {
        if (pattern.test(html)) {
            reasons.push(reason);
            score += weight;
        }
    }

    // 2. Low text-to-HTML ratio (JS generates the content, raw HTML is mostly scripts)
    const htmlSize = html.length;
    const scriptBlocks = [...html.matchAll(/<script[\s\S]*?<\/script>/gi)];
    const scriptSize = scriptBlocks.reduce((sum, m) => sum + m[0].length, 0);
    const textContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const textRatio = textContent.length / Math.max(htmlSize, 1);
    const scriptRatio = scriptSize / Math.max(htmlSize, 1);

    if (textRatio < 0.05 && htmlSize > 5000) {
        reasons.push(`Very low text ratio (${(textRatio * 100).toFixed(1)}% text in ${(htmlSize / 1024).toFixed(0)}KB HTML)`);
        score += 4;
    } else if (textRatio < 0.10 && htmlSize > 10000) {
        reasons.push(`Low text ratio (${(textRatio * 100).toFixed(1)}%)`);
        score += 2;
    }

    if (scriptRatio > 0.50) {
        reasons.push(`Script-heavy (${(scriptRatio * 100).toFixed(0)}% of page is JS)`);
        score += 2;
    }

    // 3. Loading/skeleton patterns
    const skeletonPatterns = [
        /class=["'][^"']*loading[^"']*["']/i,
        /class=["'][^"']*skeleton[^"']*["']/i,
        /class=["'][^"']*spinner[^"']*["']/i,
        /aria-label=["']loading["']/i,
    ];
    const skeletonHits = skeletonPatterns.filter(p => p.test(html)).length;
    if (skeletonHits >= 2) {
        reasons.push('Loading skeleton patterns detected');
        score += 2;
    }

    // 4. Almost no meaningful headings or paragraphs
    const headings = [...html.matchAll(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi)];
    const paragraphs = [...html.matchAll(/<p[^>]*>[^<]{20,}<\/p>/gi)];
    if (headings.length === 0 && paragraphs.length < 3 && htmlSize > 20000) {
        reasons.push('Large HTML with almost no semantic content');
        score += 3;
    }

    // 5. Meta generator or title signals
    if (/content=["']React/i.test(html) || /content=["']Next\.js/i.test(html)) {
        reasons.push('Meta generator = React/Next.js');
        score += 2;
    }

    // 6. JSON-heavy content (SSR data dumps) — actually NOT a SPA signal, subtract
    if (/application\/ld\+json/i.test(html) && textRatio > 0.15) {
        score -= 2; // Structured data + good text = probably SSR/static
    }

    const isSPA = score >= 4;
    const confidence = score >= 8 ? 'high' : score >= 4 ? 'medium' : 'low';

    return { isSPA, score, confidence, reasons };
}

// ─── Playwright Renderer ─────────────────────────────────────────────────────

/**
 * Full Playwright-based rendering for SPAs.
 * Returns same structure as lite renderer.
 */
async function renderWithPlaywright(url, options = {}) {
    // Lazy import — only load playwright if actually needed
    let chromium;
    try {
        const pw = await import('playwright');
        chromium = pw.chromium;
    } catch (e) {
        throw new Error(
            'Playwright not installed. Run: npm install playwright && npx playwright install chromium\n' +
            `Original error: ${e.message}`
        );
    }

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'AgentWeb/0.2 (ai-agent-browser)',
    });

    const page = await context.newPage();

    try {
        // Block heavy resources we don't need (images, media, fonts)
        if (options.blockMedia !== false) {
            await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,mp4,mp3,avi}', r => r.abort());
        }

        await page.goto(url, {
            waitUntil: options.waitUntil || 'networkidle',
            timeout: options.timeout || 30000,
        });

        // Wait for common SPA content signals
        try {
            await page.waitForFunction(
                () => document.body.innerText.length > 200,
                { timeout: 5000 }
            );
        } catch {
            // Fine — some pages are just very minimal
        }

        // Extract structured content from the rendered DOM
        const data = await page.evaluate((pageUrl) => {
            function stripTags(s) {
                return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }

            const title = document.title || '';
            const text = document.body.innerText || '';

            // Headings
            const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => ({
                level: parseInt(h.tagName[1]),
                text: h.innerText.trim().slice(0, 200),
            })).filter(h => h.text);

            // Links
            const links = [...document.querySelectorAll('a[href]')]
                .map(a => ({
                    text: a.innerText.trim().slice(0, 120),
                    href: a.href,
                }))
                .filter(l => l.text && l.href && !l.href.startsWith('javascript:'))
                .slice(0, 100);

            // Forms
            const forms = [...document.querySelectorAll('form')].map(f => {
                const fields = [...f.querySelectorAll('input:not([type=hidden]),textarea,select')].map(el => ({
                    tag: el.tagName.toLowerCase(),
                    type: el.type || null,
                    name: el.name || null,
                    placeholder: el.placeholder || null,
                }));
                return {
                    action: f.action || null,
                    method: f.method || 'get',
                    fields,
                };
            });

            // Meta
            const meta = {};
            document.querySelectorAll('meta[name][content],meta[property][content]').forEach(m => {
                const key = m.getAttribute('name') || m.getAttribute('property');
                if (key) meta[key] = m.getAttribute('content');
            });

            return {
                url: pageUrl,
                title,
                meta,
                headings,
                links,
                forms,
                textContent: text.slice(0, 50000),
                stats: {
                    headingCount: headings.length,
                    linkCount: links.length,
                    formCount: forms.length,
                    textLength: text.length,
                },
            };
        }, url);

        return data;

    } finally {
        await browser.close();
    }
}

// ─── Smart Render ─────────────────────────────────────────────────────────────

/**
 * Main entry point: smart-render a URL.
 *
 * @param {string} url
 * @param {object} options
 *   - force: 'lite' | 'playwright'  — override auto-detection
 *   - query: string                  — optional search query for chunk ranking
 *   - chunkLimit: number             — max chunks to return (default 8)
 *   - timeout: number                — ms timeout (default 15000)
 *   - verbose: boolean               — log detection info
 *
 * @returns {object} {
 *   url, backend, detection, data, chunks, summary, ms
 * }
 */
export async function render(url, options = {}) {
    const t0 = Date.now();
    const {
        force,
        query,
        chunkLimit = 8,
        timeout = 15000,
        verbose = false,
        noCache = false,
        cacheTtlMs,
    } = options;

    // ── Cache lookup ────────────────────────────────────────────────────────
    const cache = getCache();
    const cacheKey = query ?? '';

    if (!noCache && !force) {
        const cached = cache.get(url, cacheKey);
        if (cached) {
            if (verbose) console.error(`[smart-renderer] CACHE HIT ${url} q="${cacheKey}"`);
            return { ...cached, cached: true, ms: Date.now() - t0 };
        }
    }

    // Step 1: Fetch raw HTML (always needed — for detection and/or lite renderer)
    let rawHtml, fetchStatus, contentType;
    try {
        const fetched = await fetchRaw(url, timeout);
        rawHtml = fetched.html;
        fetchStatus = fetched.status;
        contentType = fetched.contentType;
    } catch (err) {
        return {
            url,
            backend: 'error',
            error: `Fetch failed: ${err.message}`,
            ms: Date.now() - t0,
        };
    }

    // Step 2: SPA detection
    const detection = detectSPA(rawHtml);
    const useLite = force === 'lite' || (!force && !detection.isSPA);
    const backend = useLite ? 'lite' : 'playwright';

    if (verbose) {
        console.error(`[smart-renderer] ${url}`);
        console.error(`  SPA: ${detection.isSPA} (score=${detection.score}, confidence=${detection.confidence})`);
        if (detection.reasons.length) {
            console.error('  Reasons:', detection.reasons.join('; '));
        }
        console.error(`  Backend: ${backend}`);
    }

    // Step 3: Render
    let data;
    try {
        if (useLite) {
            data = await renderLite(url, { _rawHtml: rawHtml });
        } else {
            data = await renderWithPlaywright(url, { timeout });
        }
    } catch (err) {
        // If playwright fails, fall back to lite
        if (backend === 'playwright') {
            if (verbose) console.error(`[smart-renderer] Playwright failed, falling back to lite: ${err.message}`);
            try {
                data = await renderLite(url, { _rawHtml: rawHtml });
                return buildResult(url, 'lite-fallback', detection, data, query, chunkLimit, t0);
            } catch (e2) {
                return { url, backend: 'error', error: e2.message, ms: Date.now() - t0 };
            }
        }
        return { url, backend: 'error', error: err.message, ms: Date.now() - t0 };
    }

    const result = buildResult(url, backend, detection, data, query, chunkLimit, t0);

    // ── Cache store ─────────────────────────────────────────────────────────
    if (!noCache && result.backend !== 'error') {
        // Playwright pages are more dynamic — use shorter TTL
        const ttl = cacheTtlMs ?? (backend === 'playwright' ? 5 * 60 * 1000 : 10 * 60 * 1000);
        cache.set(url, cacheKey, result, ttl);
    }

    return result;
}

function buildResult(url, backend, detection, data, query, chunkLimit, t0) {
    // Generate chunks + summary
    let chunks = null;
    let summary = null;
    try {
        const rawText = data.textContent || '';
        const allChunks = chunkPage(data);
        const relevant = query
            ? findRelevant(allChunks, query, chunkLimit)
            : allChunks.slice(0, chunkLimit);
        chunks = relevant;
        summary = formatChunks(relevant);
    } catch (e) {
        // Chunking failed — no big deal
        summary = (data.textContent || '').slice(0, 2000);
    }

    return {
        url,
        backend,
        detection: {
            isSPA: detection.isSPA,
            score: detection.score,
            confidence: detection.confidence,
            reasons: detection.reasons,
        },
        data,
        chunks,
        summary,
        ms: Date.now() - t0,
    };
}

// ─── Format helpers ──────────────────────────────────────────────────────────

/**
 * Format a render result as a concise agent-readable string.
 */
export function formatResult(result) {
    if (result.backend === 'error') {
        return `ERROR: ${result.error} (${result.ms}ms)`;
    }

    const lines = [
        `URL: ${result.url}`,
        `Title: ${result.data?.title || '(none)'}`,
        `Backend: ${result.backend} | SPA: ${result.detection?.isSPA ? 'yes' : 'no'} | ${result.ms}ms`,
        '',
    ];

    if (result.data?.headings?.length) {
        lines.push(`Headings (${result.data.headings.length}):`);
        result.data.headings.slice(0, 6).forEach(h => {
            lines.push(`  ${'#'.repeat(h.level)} ${h.text}`);
        });
        lines.push('');
    }

    if (result.summary) {
        lines.push('Content:');
        lines.push(result.summary);
    }

    if (result.data?.links?.length) {
        lines.push('');
        lines.push(`Links (${result.data.links.length} total, showing top 10):`);
        result.data.links.slice(0, 10).forEach(l => {
            lines.push(`  [${l.text}] ${l.href}`);
        });
    }

    return lines.join('\n');
}
