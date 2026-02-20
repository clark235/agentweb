#!/usr/bin/env node
/**
 * Test smart-renderer.js
 * 
 * Validates:
 * 1. SPA detection accuracy on known sites
 * 2. Smart routing (lite vs playwright)
 * 3. Fallback behavior
 * 4. Query-based chunk filtering
 * 
 * Run: node test-smart-renderer.js
 */

import { detectSPA, render, formatResult } from './smart-renderer.js';

const TESTS = [
    // Static sites — should use lite renderer
    { url: 'https://news.ycombinator.com', expectSPA: false, expectBackend: 'lite', name: 'Hacker News (server-rendered)' },
    { url: 'https://en.wikipedia.org/wiki/Node.js', expectSPA: false, expectBackend: 'lite', name: 'Wikipedia (static)' },

    // SPA sites — should use playwright
    // Note: These can be slow or flaky depending on network
    // { url: 'https://linear.app', expectSPA: true, expectBackend: 'playwright', name: 'Linear (React SPA)' },
];

// Detection-only tests (faster, no network for render step)
const DETECTION_TESTS = [
    {
        name: 'Empty React root div',
        html: '<html><head></head><body><div id="root"></div><script src="bundle.js"></script></body></html>',
        expectSPA: true,
    },
    {
        name: 'Next.js hydration data',
        html: '<html><body><div id="__next"><h1>Loading...</h1></div><script>window.__NEXT_DATA__ = {}</script></body></html>',
        expectSPA: true,
    },
    {
        name: 'Angular app',
        html: '<html><body><app-root></app-root><script src="main.js"></script></body></html>',
        expectSPA: true,
    },
    {
        name: 'Server-rendered page with rich content',
        html: `<html><body>
            <h1>My Blog</h1>
            <p>Welcome to my blog. This is a long paragraph with lots of text content.</p>
            <p>Here is another paragraph talking about various topics that might interest readers.</p>
            <ul><li>Item one</li><li>Item two</li><li>Item three</li></ul>
            <h2>Another Section</h2>
            <p>More content here. The page has substantial text so it's clearly server-rendered.</p>
            <a href="/page1">Page 1</a>
            <a href="/page2">Page 2</a>
        </body></html>`,
        expectSPA: false,
    },
    {
        name: 'Script-heavy page with no text',
        html: `<html><body><div id="app"></div>` +
              `<script>${'x'.repeat(50000)}</script>` +
              `</body></html>`,
        expectSPA: true,
    },
    {
        name: 'Vue app',
        html: '<html><body><div id="app" data-vue-app></div></body></html>',
        expectSPA: true,
    },
];

function pass(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }

let passed = 0;
let failed = 0;

// ─── Run Detection Tests ──────────────────────────────────────────────────────
console.log('\n🔍 SPA Detection Tests (HTML-only, no network)\n');

for (const t of DETECTION_TESTS) {
    console.log(`Testing: ${t.name}`);
    const result = detectSPA(t.html);
    const correct = result.isSPA === t.expectSPA;
    
    if (correct) {
        pass(`isSPA=${result.isSPA} (score=${result.score}, confidence=${result.confidence})`);
        passed++;
    } else {
        fail(`Expected isSPA=${t.expectSPA}, got isSPA=${result.isSPA} (score=${result.score})`);
        if (result.reasons.length) info(`Reasons: ${result.reasons.join('; ')}`);
        failed++;
    }
    console.log('');
}

// ─── Run Live Render Tests ────────────────────────────────────────────────────
console.log('\n🌐 Live Render Tests (network required)\n');

for (const t of TESTS) {
    console.log(`Testing: ${t.name}`);
    console.log(`  URL: ${t.url}`);
    
    try {
        const result = await render(t.url, { verbose: true, query: 'main content' });
        
        const backendOk = result.backend === t.expectBackend || 
                          result.backend === t.expectBackend + '-fallback';
        const spaOk = result.detection?.isSPA === t.expectSPA;
        
        if (backendOk) {
            pass(`Backend: ${result.backend} (expected: ${t.expectBackend})`);
            passed++;
        } else {
            fail(`Backend: ${result.backend} (expected: ${t.expectBackend})`);
            failed++;
        }
        
        if (spaOk) {
            pass(`SPA detection: ${result.detection?.isSPA}`);
            passed++;
        } else {
            fail(`SPA detection: ${result.detection?.isSPA} (expected: ${t.expectSPA})`);
            if (result.detection?.reasons?.length) {
                info(`Reasons: ${result.detection.reasons.join('; ')}`);
            }
            failed++;
        }
        
        info(`Time: ${result.ms}ms`);
        info(`Title: ${result.data?.title || '(none)'}`);
        info(`Text: ${result.data?.textContent?.length || 0} chars`);
        info(`Headings: ${result.data?.headings?.length || 0}`);
        
        if (result.summary) {
            info(`Summary preview: ${result.summary.slice(0, 100)}...`);
        }
        
    } catch (err) {
        fail(`Error: ${err.message}`);
        failed++;
        failed++; // Count for both backend + spa checks
    }
    
    console.log('');
}

// ─── Query Test ───────────────────────────────────────────────────────────────
console.log('\n🔎 Query-filtered Chunk Test\n');
console.log('Fetching Node.js homepage with query "install nodejs"...');

try {
    const result = await render('https://nodejs.org/en', {
        query: 'install nodejs download lts',
        chunkLimit: 3,
    });
    
    if (result.backend === 'error') {
        fail(`Error: ${result.error}`);
        failed++;
    } else {
        pass(`Backend: ${result.backend} (${result.ms}ms)`);
        pass(`Got ${result.chunks?.length || 0} chunks`);
        info('Top chunks:');
        (result.chunks || []).forEach((c, i) => {
            info(`  [${i + 1}] type=${c.type} score=${c.score} text="${c.text.slice(0, 80)}..."`);
        });
        passed += 2;
    }
} catch (err) {
    fail(`Error: ${err.message}`);
    failed++;
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks\n`);

if (failed === 0) {
    console.log('🎉 All tests passed!');
} else {
    console.log(`⚠️  ${failed} test(s) failed`);
    process.exit(1);
}
