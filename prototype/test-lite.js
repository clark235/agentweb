#!/usr/bin/env node
/**
 * Test the lite renderer against real URLs
 */

import { renderLite, formatSummary } from './lite-renderer.js';

const urls = [
    'https://example.com',
    'https://news.ycombinator.com',
    'https://en.wikipedia.org/wiki/Artificial_intelligence',
];

async function main() {
    const target = process.argv[2];
    const testUrls = target ? [target] : urls;

    for (const url of testUrls) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Testing: ${url}`);
        console.log('='.repeat(60));

        try {
            const start = Date.now();
            const result = await renderLite(url);
            const elapsed = Date.now() - start;

            if (process.argv.includes('--json')) {
                console.log(JSON.stringify(result, null, 2));
            } else {
                console.log(formatSummary(result));
                console.log(`\n⏱️ Rendered in ${elapsed}ms (lite mode, no browser)`);
            }
        } catch (err) {
            console.error(`❌ Failed: ${err.message}`);
        }
    }
}

main();
