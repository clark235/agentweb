#!/usr/bin/env node
/**
 * AgentWeb CLI
 * 
 * Usage:
 *   agentweb <url>                    # Render and output JSON
 *   agentweb <url> --screenshot       # Include base64 screenshot
 *   agentweb <url> --summary          # Output human-readable summary
 */

import { AgentWebRenderer } from './renderer.js';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
AgentWeb - Headless web rendering for AI agents

Usage:
  agentweb <url>                Render page and output structured JSON
  agentweb <url> --screenshot   Include base64 screenshot
  agentweb <url> --summary      Output human-readable summary

Examples:
  agentweb https://example.com
  agentweb https://github.com --summary
`);
    process.exit(0);
  }

  const url = args.find(a => !a.startsWith('--'));
  const wantScreenshot = args.includes('--screenshot');
  const wantSummary = args.includes('--summary');

  if (!url) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const renderer = new AgentWebRenderer();
  
  try {
    console.error(`Rendering ${url}...`);
    const result = await renderer.render(url, { screenshot: wantScreenshot });
    
    if (wantSummary) {
      // Human-readable output
      console.log(`\n📄 ${result.title}`);
      console.log(`🔗 ${result.url}\n`);
      
      if (result.meta.description) {
        console.log(`📝 ${result.meta.description}\n`);
      }
      
      console.log('📑 Structure:');
      result.headings.forEach(h => {
        console.log(`${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}`);
      });
      
      console.log(`\n🎯 Interactive Elements: ${result.stats.interactiveCount}`);
      console.log(`📋 Forms: ${result.stats.formCount}`);
      
      if (result.forms.length > 0) {
        console.log('\nForms:');
        result.forms.forEach((f, i) => {
          console.log(`  Form ${i + 1}: ${f.fields.length} fields`);
          f.fields.forEach(field => {
            console.log(`    - ${field.name || field.type}: ${field.tag}${field.required ? ' (required)' : ''}`);
          });
        });
      }
      
      // Top 10 links
      const links = result.interactives.filter(i => i.tag === 'a' && i.href && i.text);
      if (links.length > 0) {
        console.log(`\n🔗 Links (top ${Math.min(10, links.length)}):`);
        links.slice(0, 10).forEach(l => {
          console.log(`  • ${l.text.slice(0, 50)}`);
        });
      }
      
    } else {
      // JSON output
      console.log(JSON.stringify(result, null, 2));
    }
    
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    await renderer.close();
  }
}

main();
