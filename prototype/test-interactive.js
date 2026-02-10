#!/usr/bin/env node
/**
 * Test the interactive session module
 */

import { InteractiveSession } from './interactive.js';

async function main() {
  const session = new InteractiveSession();
  
  try {
    console.log('Starting interactive session on example.com...');
    let state = await session.start('https://example.com');
    console.log(`📄 ${state.title}`);
    console.log(`🔗 ${state.url}`);
    console.log(`🎯 Found ${state.elementCount} interactive elements`);
    
    // Show elements
    console.log('\nElements:');
    state.elements.forEach(el => {
      console.log(`  [${el.id}] ${el.tag}: ${el.text || el.placeholder || el.type || '(no text)'}`);
    });
    
    // Test clicking the "More information" link if present
    const moreInfo = state.elements.find(e => e.text.toLowerCase().includes('more information'));
    if (moreInfo) {
      console.log(`\nClicking element [${moreInfo.id}]: "${moreInfo.text}"`);
      state = await session.click(moreInfo.id);
      console.log(`📄 New page: ${state.title}`);
      console.log(`🔗 ${state.url}`);
    }
    
    // Test on a page with a form
    console.log('\n--- Testing with search form ---');
    state = await session.goto('https://duckduckgo.com');
    console.log(`📄 ${state.title}`);
    console.log(`🎯 Found ${state.elementCount} interactive elements`);
    
    // Find search input
    const searchInput = state.elements.find(e => 
      e.tag === 'input' && (e.placeholder?.toLowerCase().includes('search') || e.name === 'q')
    );
    
    if (searchInput) {
      console.log(`\nTyping into search [${searchInput.id}]...`);
      state = await session.type(searchInput.id, 'hello world');
      console.log('Pressing Enter...');
      state = await session.press('Enter');
      console.log(`📄 Results page: ${state.title}`);
      console.log(`🔗 ${state.url}`);
      console.log(`🎯 Found ${state.elementCount} interactive elements`);
    }
    
    console.log('\n✅ Interactive session test passed!');
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  } finally {
    await session.close();
  }
}

main();
