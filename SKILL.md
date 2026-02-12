# AgentWeb Skill

Render web pages into structured, LLM-friendly data using AgentWeb.

## Usage

```javascript
// Basic page rendering
const result = await agentWeb('https://example.com');

// With summary output
const summary = await agentWeb('https://example.com', { format: 'summary' });

// Interactive exploration
const page = await agentWebInteractive('https://github.com');
await page.click(5); // Click interactive element #5
const newData = await page.render();
```

## Installation

```bash
cd ventures/agentweb/prototype
npm install
```

## Functions

### `agentWeb(url, options?)`

Render a web page to structured data.

**Parameters:**
- `url` (string) - URL to render
- `options` (object, optional)
  - `format` - Output format: 'json' (default) or 'summary'
  - `screenshot` - Capture screenshot (boolean)

**Returns:** Structured page data or human-readable summary

### `agentWebInteractive(url)`

Create an interactive session for multi-step web operations.

**Returns:** Interactive session with methods:
- `render()` - Get current page structure
- `click(id)` - Click interactive element by ID
- `type(id, text)` - Type into form field
- `submit(formId)` - Submit form
- `navigate(url)` - Navigate to new URL
- `close()` - Close session

## Output Structure

```json
{
  "title": "Page Title",
  "url": "https://example.com/",
  "headings": [
    {"level": 1, "text": "Main Heading"}
  ],
  "interactives": [
    {"id": 0, "tag": "a", "text": "Link Text", "href": "..."}
  ],
  "forms": [
    {
      "id": 0,
      "action": "/submit",
      "fields": [{"id": 1, "type": "text", "name": "username"}]
    }
  ],
  "textContent": "Main page content...",
  "stats": {"interactiveCount": 10, "formCount": 1}
}
```

## Use Cases

- **Research**: Extract structured data from web pages
- **Form filling**: Identify and interact with web forms
- **Link analysis**: Find relevant links and navigation paths
- **Content extraction**: Get clean text content for processing
- **Site mapping**: Understand page structure and interactions

## Examples

### Basic Web Research
```javascript
// Research a topic
const page = await agentWeb('https://news.ycombinator.com');
console.log(`Found ${page.stats.interactiveCount} links`);

// Get readable summary
const summary = await agentWeb('https://news.ycombinator.com', { 
  format: 'summary' 
});
```

### Interactive Web Navigation
```javascript
// Multi-step interaction
const session = await agentWebInteractive('https://github.com/search');

// Fill search form
await session.type(0, 'OpenClaw'); // Type in first input
await session.submit(0); // Submit first form

// Navigate results
const results = await session.render();
console.log(`Found ${results.stats.interactiveCount} results`);

await session.close();
```

### Content Extraction
```javascript
// Extract article content
const article = await agentWeb('https://blog.example.com/article');
const headings = article.headings.map(h => h.text);
const content = article.textContent.substring(0, 500);
```

## Error Handling

```javascript
try {
  const result = await agentWeb('https://example.com');
} catch (error) {
  if (error.message.includes('timeout')) {
    // Handle slow pages
  } else if (error.message.includes('blocked')) {
    // Handle bot detection
  }
}
```

## Tips

- Use `format: 'summary'` for quick human-readable overviews
- Interactive sessions maintain cookies/state between operations
- Large pages may have truncated `textContent` - use headings for structure
- Element IDs in `interactives` array correspond to clickable elements
- Forms provide field metadata for automated filling

## Limitations

- Requires Playwright dependencies (GUI libraries)
- Some sites block headless browsers
- JavaScript-heavy sites may need longer timeouts
- Large pages consume more tokens in JSON format