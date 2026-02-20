/**
 * AgentWeb Lite Renderer
 * Zero-dependency web page parser for AI agents.
 * Uses only Node.js built-ins (fetch + regex HTML parsing).
 * No Playwright, no Chromium, no GUI libs.
 * 
 * Trade-off: Can't execute JS or render SPAs, but works everywhere
 * and is 1000x lighter than browser-based rendering.
 */

/**
 * Parse HTML into structured agent-friendly format
 */
function parseHTML(html, url) {
    const result = {
        url,
        title: extract(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
        meta: extractMeta(html),
        headings: extractHeadings(html),
        links: extractLinks(html, url),
        forms: extractForms(html),
        images: extractImages(html, url),
        textContent: extractText(html),
        tables: extractTables(html),
        stats: {}
    };

    result.stats = {
        headingCount: result.headings.length,
        linkCount: result.links.length,
        formCount: result.forms.length,
        imageCount: result.images.length,
        tableCount: result.tables.length,
        textLength: result.textContent.length,
    };

    return result;
}

function extract(html, regex) {
    const m = html.match(regex);
    return m ? decodeEntities(m[1].trim()) : null;
}

function decodeEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function extractMeta(html) {
    const meta = {};
    const re = /<meta\s+([^>]+)>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrs = parseAttrs(m[1]);
        if (attrs.name && attrs.content) {
            meta[attrs.name.toLowerCase()] = attrs.content;
        }
        if (attrs.property && attrs.content) {
            meta[attrs.property] = attrs.content;
        }
    }
    return meta;
}

function parseAttrs(str) {
    const attrs = {};
    const re = /(\w[\w-]*)=["']([^"']*?)["']/g;
    let m;
    while ((m = re.exec(str)) !== null) {
        attrs[m[1].toLowerCase()] = m[2];
    }
    return attrs;
}

function extractHeadings(html) {
    const headings = [];
    const re = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const level = parseInt(m[1][1]);
        const text = stripTags(m[2]).trim();
        if (text) headings.push({ level, text });
    }
    return headings;
}

function extractLinks(html, baseUrl) {
    const links = [];
    const seen = new Set();
    const re = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrs = parseAttrs(m[1]);
        const text = stripTags(m[2]).trim();
        const href = attrs.href;
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
        
        let resolved;
        try {
            resolved = new URL(href, baseUrl).href;
        } catch {
            continue;
        }
        
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        
        if (text) {
            links.push({ text: text.slice(0, 120), href: resolved });
        }
    }
    return links;
}

function extractForms(html) {
    const forms = [];
    const re = /<form\s+([^>]*?)>([\s\S]*?)<\/form>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrs = parseAttrs(m[1]);
        const body = m[2];
        const fields = [];
        
        // Input fields
        const inputRe = /<input\s+([^>]*?)\/?>/gi;
        let im;
        while ((im = inputRe.exec(body)) !== null) {
            const ia = parseAttrs(im[1]);
            if (ia.type === 'hidden') continue;
            fields.push({
                tag: 'input',
                type: ia.type || 'text',
                name: ia.name || null,
                placeholder: ia.placeholder || null,
                required: im[1].includes('required'),
            });
        }
        
        // Textareas
        const taRe = /<textarea\s+([^>]*?)>/gi;
        let tm;
        while ((tm = taRe.exec(body)) !== null) {
            const ta = parseAttrs(tm[1]);
            fields.push({
                tag: 'textarea',
                name: ta.name || null,
                placeholder: ta.placeholder || null,
                required: tm[1].includes('required'),
            });
        }
        
        // Selects
        const selRe = /<select\s+([^>]*?)>([\s\S]*?)<\/select>/gi;
        let sm;
        while ((sm = selRe.exec(body)) !== null) {
            const sa = parseAttrs(sm[1]);
            const options = [];
            const optRe = /<option[^>]*>([\s\S]*?)<\/option>/gi;
            let om;
            while ((om = optRe.exec(sm[2])) !== null) {
                options.push(stripTags(om[1]).trim());
            }
            fields.push({
                tag: 'select',
                name: sa.name || null,
                options: options.slice(0, 20),
            });
        }
        
        forms.push({
            action: attrs.action || null,
            method: (attrs.method || 'GET').toUpperCase(),
            fields,
        });
    }
    return forms;
}

function extractImages(html, baseUrl) {
    const images = [];
    const re = /<img\s+([^>]*?)\/?>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrs = parseAttrs(m[1]);
        if (!attrs.src) continue;
        let src;
        try {
            src = new URL(attrs.src, baseUrl).href;
        } catch {
            continue;
        }
        images.push({
            src,
            alt: attrs.alt || null,
            width: attrs.width ? parseInt(attrs.width) : null,
            height: attrs.height ? parseInt(attrs.height) : null,
        });
    }
    return images.slice(0, 50); // Cap at 50
}

function extractTables(html) {
    const tables = [];
    const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let m;
    while ((m = tableRe.exec(html)) !== null) {
        const rows = [];
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rm;
        while ((rm = rowRe.exec(m[1])) !== null) {
            const cells = [];
            const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
            let cm;
            while ((cm = cellRe.exec(rm[1])) !== null) {
                cells.push(stripTags(cm[1]).trim());
            }
            if (cells.length) rows.push(cells);
        }
        if (rows.length) tables.push(rows);
    }
    return tables.slice(0, 10); // Cap at 10
}

function stripTags(html) {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractText(html) {
    // Remove script, style, nav, footer, header
    let clean = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '');
    
    // Try to find main content
    const mainMatch = clean.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                      clean.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                      clean.match(/<div[^>]*(?:class|id)=["'][^"']*(?:content|main|article)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    
    if (mainMatch) clean = mainMatch[1];
    
    const text = stripTags(clean);
    return decodeEntities(text).slice(0, 5000);
}

/**
 * Fetch and parse a URL
 * 
 * @param {string} url
 * @param {object} options
 *   - timeoutMs: number     — fetch timeout (default 15000)
 *   - _rawHtml: string      — pre-fetched HTML (skip network fetch, avoids double-fetch)
 */
async function renderLite(url, options = {}) {
    // If caller already fetched the HTML (e.g. smart-renderer doing SPA detection),
    // skip the network fetch to avoid fetching twice.
    if (options._rawHtml) {
        const result = parseHTML(options._rawHtml, url);
        result.httpStatus = 200;
        result.contentType = 'text/html';
        result.renderer = 'lite';
        return result;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'AgentWeb/0.2 (AI Agent Renderer)',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const html = await response.text();
        const finalUrl = response.url || url;
        const result = parseHTML(html, finalUrl);
        result.httpStatus = response.status;
        result.contentType = response.headers.get('content-type');
        result.renderer = 'lite';
        return result;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Format result as human-readable summary
 */
function formatSummary(result) {
    const lines = [];
    lines.push(`📄 ${result.title || 'Untitled'}`);
    lines.push(`🔗 ${result.url}`);
    if (result.meta.description) {
        lines.push(`📝 ${result.meta.description}`);
    }
    lines.push('');

    if (result.headings.length) {
        lines.push(`📋 Structure (${result.headings.length} headings):`);
        result.headings.slice(0, 10).forEach(h => {
            lines.push(`${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}`);
        });
        lines.push('');
    }

    if (result.links.length) {
        lines.push(`🔗 Links (${result.links.length} total, showing top 15):`);
        result.links.slice(0, 15).forEach(l => {
            lines.push(`  • ${l.text} → ${l.href}`);
        });
        lines.push('');
    }

    if (result.forms.length) {
        lines.push(`📝 Forms (${result.forms.length}):`);
        result.forms.forEach((f, i) => {
            lines.push(`  Form ${i + 1}: ${f.method} ${f.action || '(self)'} — ${f.fields.length} fields`);
            f.fields.forEach(field => {
                lines.push(`    - ${field.tag}[${field.type || field.tag}] ${field.name || ''} ${field.placeholder ? `"${field.placeholder}"` : ''} ${field.required ? '(required)' : ''}`);
            });
        });
        lines.push('');
    }

    if (result.tables.length) {
        lines.push(`📊 Tables: ${result.tables.length}`);
    }

    lines.push(`📈 Stats: ${result.stats.linkCount} links, ${result.stats.formCount} forms, ${result.stats.imageCount} images, ${result.stats.textLength} chars`);

    return lines.join('\n');
}

export { renderLite, parseHTML, formatSummary };
