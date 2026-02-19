/**
 * AgentWeb Semantic Chunker
 * 
 * Takes raw extracted page content and breaks it into semantic chunks
 * optimized for agent consumption and LLM context windows.
 * 
 * Problem: raw HTML extraction gives flat text. Agents need:
 * - Context-aware sections (what's this chunk about?)
 * - Relevance scoring (what's important?)
 * - Chunk metadata (where in the page, what type of content)
 * - Summary per chunk (so agent can skip irrelevant chunks)
 * 
 * This is purely algorithmic — no LLM calls. Fast + free.
 */

/**
 * Score a text block's likely relevance/importance.
 * Heuristics based on content signals.
 */
function scoreBlock(text, context = {}) {
  let score = 0;
  const lower = text.toLowerCase();
  
  // Length sweet spot (50-500 chars = informative but not padding)
  const len = text.length;
  if (len >= 50 && len <= 500) score += 2;
  else if (len > 500 && len <= 2000) score += 1;
  else if (len < 20) score -= 2;
  
  // Contains numbers/data (tends to be factual content)
  if (/\d+/.test(text)) score += 1;
  
  // Contains code-like patterns
  if (/`[^`]+`|```|\bconst\b|\bfunction\b|\bimport\b/.test(text)) score += 2;
  
  // Nav/boilerplate signals
  if (/^(home|menu|search|login|sign in|sign up|subscribe|newsletter|cookie|privacy|terms)/i.test(lower)) score -= 3;
  if (/copyright|all rights reserved|powered by/i.test(lower)) score -= 2;
  
  // Lists of links (nav) vs content
  if (context.linkDensity > 0.7) score -= 2;
  
  // Heading context bonus
  if (context.underHeading) score += 1;
  
  // Content signals
  if (/(?:how to|step|guide|tutorial|example|note:|warning:|important:)/i.test(lower)) score += 2;
  
  return score;
}

/**
 * Detect the semantic type of a text block
 */
function detectType(text, meta = {}) {
  const lower = text.toLowerCase().trim();
  
  if (meta.isCode || /^(```|~~~|\$\s|\>\s)/.test(text)) return 'code';
  if (meta.tag && /^h[1-6]$/.test(meta.tag)) return 'heading';
  if (meta.tag === 'li' || (lower.startsWith('•') || lower.startsWith('-') || lower.startsWith('*'))) return 'list-item';
  if (/^(note|warning|tip|important|caution|info):/i.test(lower)) return 'callout';
  if (meta.tag === 'td' || meta.tag === 'th') return 'table-cell';
  if (text.length < 50 && meta.standalone) return 'label';
  if (/\b(http|https):\/\//.test(text) && text.split(' ').length < 5) return 'link';
  return 'paragraph';
}

/**
 * Split text into sentences (rough but fast)
 */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

/**
 * Main chunking function.
 * Takes a parsed page result (from lite-renderer or playwright) and returns chunks.
 * 
 * @param {object} page - Parsed page with { title, headings, textContent, links, forms }
 * @param {object} opts - Options { maxChunkSize, minChunkSize, includeNav }
 * @returns {Array<Chunk>} Sorted by relevance
 */
export function chunkPage(page, opts = {}) {
  const maxSize = opts.maxChunkSize || 800;
  const minScore = opts.minScore !== undefined ? opts.minScore : -1;
  const includeNav = opts.includeNav || false;
  
  const chunks = [];
  let chunkId = 0;
  
  // === Chunk 0: Page summary ===
  chunks.push({
    id: chunkId++,
    type: 'summary',
    section: null,
    text: [
      page.title ? `Title: ${page.title}` : null,
      page.meta?.description ? `Description: ${page.meta.description}` : null,
      page.url ? `URL: ${page.url}` : null,
      page.stats ? `Stats: ${JSON.stringify(page.stats)}` : null,
    ].filter(Boolean).join('\n'),
    score: 10,
    meta: { isSummary: true },
  });
  
  // === Chunk headings as anchors ===
  if (page.headings?.length) {
    chunks.push({
      id: chunkId++,
      type: 'toc',
      section: null,
      text: 'Page structure:\n' + page.headings
        .map(h => `${'  '.repeat(h.level - 1)}${h.level === 1 ? '' : '→ '}${h.text}`)
        .join('\n'),
      score: 5,
      meta: { isNav: true },
    });
  }
  
  // === Chunk main text content ===
  const text = page.textContent || '';
  
  if (text) {
    // Split by double newlines (paragraph boundaries)
    const paragraphs = text
      .split(/\n{2,}/)
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    let currentSection = null;
    let headingIdx = 0;
    
    // Track which heading we're under (best effort positional match)
    const headingTexts = (page.headings || []).map(h => h.text.toLowerCase().trim());
    
    for (const para of paragraphs) {
      // Check if this paragraph IS a heading
      const paraLower = para.toLowerCase().trim();
      const headingMatch = headingTexts.findIndex(h => paraLower === h || paraLower.startsWith(h));
      if (headingMatch >= 0) {
        currentSection = page.headings[headingMatch].text;
        continue; // headings are in TOC chunk already
      }
      
      // Detect link density (nav indicator)
      const wordCount = para.split(/\s+/).length;
      const linkMatches = (para.match(/https?:\/\//g) || []).length;
      const linkDensity = wordCount > 0 ? linkMatches / wordCount : 0;
      
      const score = scoreBlock(para, {
        linkDensity,
        underHeading: !!currentSection,
      });
      
      if (!includeNav && linkDensity > 0.5) continue;
      
      // Split large paragraphs into chunks
      if (para.length > maxSize) {
        const sentences = splitSentences(para);
        let current = '';
        let sentIdx = 0;
        
        for (const sentence of sentences) {
          if ((current + ' ' + sentence).length > maxSize && current) {
            if (score >= minScore) {
              chunks.push({
                id: chunkId++,
                type: detectType(current),
                section: currentSection,
                text: current.trim(),
                score,
                meta: { partial: true, part: sentIdx },
              });
            }
            current = sentence;
            sentIdx++;
          } else {
            current = current ? current + ' ' + sentence : sentence;
          }
        }
        if (current.trim() && score >= minScore) {
          chunks.push({
            id: chunkId++,
            type: detectType(current),
            section: currentSection,
            text: current.trim(),
            score,
            meta: { partial: true, part: sentIdx },
          });
        }
      } else {
        if (score >= minScore) {
          chunks.push({
            id: chunkId++,
            type: detectType(para),
            section: currentSection,
            text: para,
            score,
            meta: {},
          });
        }
      }
    }
  }
  
  // === Chunk forms ===
  if (page.forms?.length) {
    for (const form of page.forms) {
      const fieldDescs = form.fields
        .map(f => `${f.tag}[${f.type || f.tag}] name="${f.name || ''}" ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} ${f.required ? '(required)' : ''}`)
        .join('\n  ');
      
      chunks.push({
        id: chunkId++,
        type: 'form',
        section: null,
        text: `Form: ${form.method} ${form.action || '(self)'}\n  ${fieldDescs}`,
        score: 7, // Forms are always important for agent tasks
        meta: { form },
      });
    }
  }
  
  // === Top links (non-nav) ===
  if (page.links?.length) {
    const importantLinks = page.links
      .filter(l => l.text && l.text.length > 3 && l.text.length < 80)
      .filter(l => !/^(home|menu|back|next|prev|more|see all)/i.test(l.text))
      .slice(0, 20);
    
    if (importantLinks.length) {
      chunks.push({
        id: chunkId++,
        type: 'links',
        section: null,
        text: 'Notable links:\n' + importantLinks.map(l => `• ${l.text} → ${l.href}`).join('\n'),
        score: 3,
        meta: { linkCount: importantLinks.length },
      });
    }
  }
  
  // Sort by score descending (most relevant first)
  return chunks.sort((a, b) => b.score - a.score);
}

/**
 * Format chunks for agent consumption.
 * Returns a string that's compact but informative.
 */
export function formatChunks(chunks, opts = {}) {
  const limit = opts.limit || 10;
  const minScore = opts.minScore !== undefined ? opts.minScore : 0;
  
  const filtered = chunks
    .filter(c => c.score >= minScore)
    .slice(0, limit);
  
  return filtered.map(chunk => {
    const header = [
      `[chunk:${chunk.id}]`,
      `type=${chunk.type}`,
      chunk.section ? `section="${chunk.section}"` : null,
      `score=${chunk.score}`,
    ].filter(Boolean).join(' ');
    
    return `${header}\n${chunk.text}`;
  }).join('\n\n---\n\n');
}

/**
 * Find chunks relevant to a query (keyword matching).
 * Simple but fast — no embeddings needed for most tasks.
 */
export function findRelevant(chunks, query, limit = 5) {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  const scored = chunks.map(chunk => {
    const textLower = chunk.text.toLowerCase();
    let relevance = chunk.score;
    
    for (const word of queryWords) {
      const matches = (textLower.match(new RegExp(word, 'g')) || []).length;
      relevance += matches * 2;
    }
    
    return { ...chunk, relevance };
  });
  
  return scored
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}
