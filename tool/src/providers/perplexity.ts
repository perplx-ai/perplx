import type { Context, Model, Api, SimpleStreamOptions, OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from '@mariozechner/pi-ai';
import { AssistantMessageEventStream } from '@mariozechner/pi-ai';
import { streamSimpleOpenAIResponses } from '@mariozechner/pi-ai/openai-responses';
import { registerOAuthProvider } from '@mariozechner/pi-ai/oauth';
import type { ModelRegistry } from '../core/model-registry.js';

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai/v1';

const MODEL_MAP: Record<string, string> = {
  rush: 'anthropic/claude-haiku-4-5',
  fast: 'anthropic/claude-sonnet-4-6',
  smart: 'anthropic/claude-opus-4-6'
};

export interface PerplexityModel {
  id: string;
  name: string;
  apiModel: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const PERPLEXITY_MODELS: PerplexityModel[] = [
  {
    id: 'rush',
    name: 'Perplexity Rush',
    apiModel: 'anthropic/claude-haiku-4-5',
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 }
  },
  {
    id: 'fast',
    name: 'Perplexity Fast',
    apiModel: 'anthropic/claude-sonnet-4-6',
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }
  },
  {
    id: 'smart',
    name: 'Perplexity Smart',
    apiModel: 'anthropic/claude-opus-4-6',
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 32_768,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 }
  }
];

function perplexityStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const realModelId = MODEL_MAP[model.id] ?? model.id;

  const patchedOptions: SimpleStreamOptions = {
    ...options,
    onPayload: async (payload: any, _m: any) => {
      const next = options?.onPayload ? await options.onPayload(payload, _m) : payload;
      const p = next ?? payload;
      p.model = realModelId;
      return p;
    }
  };

  const stream = streamSimpleOpenAIResponses(model, context, patchedOptions);

  const origPush = stream.push.bind(stream);
  stream.push = (event: any) => {
    if (event.type === 'toolcall_start' && event.partial?.content) {
      const block = event.partial.content[event.contentIndex];
      if (block?.type === 'toolCall' && block.partialJson) {
        try {
          block.arguments = JSON.parse(block.partialJson);
        } catch {}
      }
    }

    return origPush(event);
  };

  return stream;
}

const PERPLEXITY_CONSOLE_URL = 'https://console.perplexity.ai';

const perplexityOAuthProvider: OAuthProviderInterface = {
  id: 'perplexity',
  name: 'Perplexity',

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    callbacks.onAuth({
      url: PERPLEXITY_CONSOLE_URL,
      instructions: 'Go to the API Keys tab and generate a new key.'
    });

    const apiKey = await callbacks.onPrompt({
      message: 'Paste your Perplexity API key:',
      placeholder: 'pplx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    });

    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Login cancelled');
    }

    return {
      access: apiKey.trim(),
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER
    };
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return credentials;
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  }
};

export function registerPerplexityProvider(registry: ModelRegistry): void {
  registerOAuthProvider(perplexityOAuthProvider);

  registry.registerProvider('perplexity', {
    baseUrl: PERPLEXITY_BASE_URL,
    api: 'openai-responses' as any,
    streamSimple: perplexityStream,
    oauth: perplexityOAuthProvider,
    models: PERPLEXITY_MODELS.map(m => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: ['text', 'image'] as ('text' | 'image')[],
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens
    }))
  });
}
