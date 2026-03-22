import { Type, type Static } from '@sinclair/typebox';
import { Text } from '@mariozechner/pi-tui';
import type { ToolDefinition } from '../core/extensions/types.js';
import type { ModelRegistry } from '../core/model-registry.js';
import { theme } from '../modes/interactive/theme/theme.js';

const SEARCH_URL = 'https://api.perplexity.ai/search';

const webSearchSchema = Type.Object({
  query: Type.String({ description: 'Search query' }),
  max_results: Type.Optional(Type.Number({ description: 'Maximum number of results (1-10, default: 5)' }))
});

type WebSearchInput = Static<typeof webSearchSchema>;

export function createWebSearchTool(registry: ModelRegistry): ToolDefinition<typeof webSearchSchema> {
  return {
    name: 'web_search',
    label: 'web search',
    description: 'Search the web for current information. Use when you need up-to-date docs, APIs, news, or anything you are unsure about.',
    promptSnippet: 'web_search: Search the web for current information',
    promptGuidelines: [
      'Use web_search to look up documentation, APIs, libraries, frameworks, or any topic you are unsure about before answering',
      'Prefer searching over guessing – if a question involves docs, release notes, changelogs, or unfamiliar concepts, search first'
    ],
    parameters: webSearchSchema,

    renderCall(args) {
      const query = args?.query ?? '';
      return new Text(`${theme.fg('toolTitle', theme.bold('web_search'))} ${theme.fg('muted', query)}`, 0, 0);
    },

    renderResult(result, options) {
      const text =
        result.content
          ?.filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('') ?? '';

      if (!text) return undefined;

      if (options.isPartial) {
        return new Text(theme.fg('muted', text), 0, 0);
      }

      if (options.expanded) {
        return new Text(theme.fg('toolOutput', text), 0, 0);
      }

      const firstLine = text.split('\n')[0] ?? '';
      const hint = `${theme.fg('muted', firstLine)} ${theme.fg('dim', 'ctrl+o')} ${theme.fg('muted', 'to expand')}`;
      return new Text(hint, 0, 0);
    },

    async execute(_toolCallId, params: WebSearchInput, signal, onUpdate) {
      const apiKey = await registry.getApiKeyForProvider('perplexity');
      if (!apiKey) {
        return {
          content: [{ type: 'text', text: 'No Perplexity API key found. Run /login perplexity first.' }],
          isError: true
        };
      }

      const maxResults = Math.min(Math.max(params.max_results ?? 5, 1), 10);

      onUpdate?.({
        content: [{ type: 'text', text: 'Searching the web...' }]
      });

      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: params.query,
          max_results: maxResults,
          max_tokens_per_page: 2048
        }),
        signal: signal ?? undefined
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          content: [{ type: 'text', text: `Search API error ${res.status}: ${body}` }],
          isError: true
        };
      }

      const data = (await res.json()) as any;
      const results = data.results ?? [];

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: 'No results found.' }]
        };
      }

      const formatted = results
        .map((r: any, i: number) => {
          const parts = [`[${i + 1}] ${r.title ?? 'Untitled'}`];
          if (r.url) parts.push(`    ${r.url}`);
          if (r.date) parts.push(`    Published: ${r.date}`);
          if (r.snippet) parts.push(`    ${r.snippet}`);
          return parts.join('\n');
        })
        .join('\n\n');

      return {
        content: [{ type: 'text', text: `Found ${results.length} result${results.length !== 1 ? 's' : ''}\n\n${formatted}` }]
      };
    }
  };
}
