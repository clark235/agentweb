/**
 * AgentWeb Test Suite
 */

import { AgentWebRenderer } from './renderer.js';

const TEST_URLS = [
  'https://example.com',
  'https://httpbin.org/forms/post'
];

async function runTests() {
  console.log('=== AgentWeb Test Suite ===\n');
  
  const renderer = new AgentWebRenderer();
  let passed = 0;
  let failed = 0;

  for (const url of TEST_URLS) {
    console.log(`Testing: ${url}`);
    try {
      const result = await renderer.render(url);
      
      // Validate structure
      if (!result.title) throw new Error('Missing title');
      if (!result.url) throw new Error('Missing url');
      if (!Array.isArray(result.interactives)) throw new Error('Missing interactives');
      if (!Array.isArray(result.headings)) throw new Error('Missing headings');
      if (!result.stats) throw new Error('Missing stats');
      
      console.log(`  ✅ Title: ${result.title}`);
      console.log(`  ✅ Interactives: ${result.stats.interactiveCount}`);
      console.log(`  ✅ Forms: ${result.stats.formCount}`);
      console.log(`  ✅ Headings: ${result.stats.headingCount}`);
      passed++;
      
    } catch (err) {
      console.log(`  ❌ FAILED: ${err.message}`);
      failed++;
    }
    console.log();
  }

  await renderer.close();
  
  console.log('=== Results ===');
  console.log(`Passed: ${passed}/${TEST_URLS.length}`);
  console.log(`Failed: ${failed}/${TEST_URLS.length}`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
