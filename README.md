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

### Phase 2: Agent Integration
- [ ] OpenClaw skill integration
- [ ] Action execution (click, type, submit)
- [ ] Session persistence
- [ ] Cookie/auth handling

### Phase 3: Agent Accessibility Standard
- [ ] Define `<agent-hint>` elements
- [ ] Propose W3C extension
- [ ] Build adoption tools

## Why Not Just Use Playwright?

Playwright gives you browser control. AgentWeb gives you **understanding**.

| Feature | Raw Playwright | AgentWeb |
|---------|---------------|----------|
| Output | Screenshots/HTML | Structured JSON |
| Token cost | High (images) | Low (text) |
| Actionable | Manual parsing | Direct references |
| Agent-optimized | No | Yes |

## Related

- Designed to run on [CarapaceOS](../carapaceos/)
- Part of the OpenClaw ecosystem
