import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
  type OAuthProviderInterface,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
  registerApiProvider,
  resetApiProviders,
  type SimpleStreamOptions
} from '@mariozechner/pi-ai';
import { registerOAuthProvider, resetOAuthProviders } from '@mariozechner/pi-ai/oauth';
import { type Static, Type } from '@sinclair/typebox';
import AjvModule from 'ajv';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAgentDir } from '../config.js';
import type { AuthStorage } from './auth-storage.js';
import { clearConfigValueCache, resolveConfigValue, resolveHeaders } from './resolve-config-value.js';

const Ajv = (AjvModule as any).default || AjvModule;
const ajv = new Ajv();

const OpenRouterRoutingSchema = Type.Object({
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String()))
});

const VercelGatewayRoutingSchema = Type.Object({
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String()))
});

const ReasoningEffortMapSchema = Type.Object({
  minimal: Type.Optional(Type.String()),
  low: Type.Optional(Type.String()),
  medium: Type.Optional(Type.String()),
  high: Type.Optional(Type.String()),
  xhigh: Type.Optional(Type.String())
});

const OpenAICompletionsCompatSchema = Type.Object({
  supportsStore: Type.Optional(Type.Boolean()),
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  reasoningEffortMap: Type.Optional(ReasoningEffortMapSchema),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(Type.Union([Type.Literal('max_completion_tokens'), Type.Literal('max_tokens')])),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  requiresThinkingAsText: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(
    Type.Union([Type.Literal('openai'), Type.Literal('openrouter'), Type.Literal('zai'), Type.Literal('qwen'), Type.Literal('qwen-chat-template')])
  ),
  openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
  vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
  supportsStrictMode: Type.Optional(Type.Boolean())
});

const OpenAIResponsesCompatSchema = Type.Object({});

const OpenAICompatSchema = Type.Union([OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema]);

const ModelDefinitionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image')]))),
  cost: Type.Optional(
    Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number()
    })
  ),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(OpenAICompatSchema)
});

const ModelOverrideSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image')]))),
  cost: Type.Optional(
    Type.Object({
      input: Type.Optional(Type.Number()),
      output: Type.Optional(Type.Number()),
      cacheRead: Type.Optional(Type.Number()),
      cacheWrite: Type.Optional(Type.Number())
    })
  ),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(OpenAICompatSchema)
});

type ModelOverride = Static<typeof ModelOverrideSchema>;

const ProviderConfigSchema = Type.Object({
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(OpenAICompatSchema),
  authHeader: Type.Optional(Type.Boolean()),
  models: Type.Optional(Type.Array(ModelDefinitionSchema)),
  modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema))
});

const ModelsConfigSchema = Type.Object({
  providers: Type.Record(Type.String(), ProviderConfigSchema)
});

ajv.addSchema(ModelsConfigSchema, 'ModelsConfig');

type ModelsConfig = Static<typeof ModelsConfigSchema>;

interface ProviderOverride {
  baseUrl?: string;
  headers?: Record<string, string>;
  apiKey?: string;
  compat?: Model<Api>['compat'];
}

interface CustomModelsResult {
  models: Model<Api>[];

  overrides: Map<string, ProviderOverride>;

  modelOverrides: Map<string, Map<string, ModelOverride>>;
  error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
  return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}

function mergeCompat(baseCompat: Model<Api>['compat'], overrideCompat: ModelOverride['compat']): Model<Api>['compat'] | undefined {
  if (!overrideCompat) return baseCompat;

  const base = baseCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;
  const override = overrideCompat as OpenAICompletionsCompat | OpenAIResponsesCompat;
  const merged = { ...base, ...override } as OpenAICompletionsCompat | OpenAIResponsesCompat;

  const baseCompletions = base as OpenAICompletionsCompat | undefined;
  const overrideCompletions = override as OpenAICompletionsCompat;
  const mergedCompletions = merged as OpenAICompletionsCompat;

  if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
    mergedCompletions.openRouterRouting = {
      ...baseCompletions?.openRouterRouting,
      ...overrideCompletions.openRouterRouting
    };
  }

  if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
    mergedCompletions.vercelGatewayRouting = {
      ...baseCompletions?.vercelGatewayRouting,
      ...overrideCompletions.vercelGatewayRouting
    };
  }

  return merged as Model<Api>['compat'];
}

function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
  const result = { ...model };

  if (override.name !== undefined) result.name = override.name;
  if (override.reasoning !== undefined) result.reasoning = override.reasoning;
  if (override.input !== undefined) result.input = override.input as ('text' | 'image')[];
  if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
  if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

  if (override.cost) {
    result.cost = {
      input: override.cost.input ?? model.cost.input,
      output: override.cost.output ?? model.cost.output,
      cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
      cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite
    };
  }

  if (override.headers) {
    const resolvedHeaders = resolveHeaders(override.headers);
    result.headers = resolvedHeaders ? { ...model.headers, ...resolvedHeaders } : model.headers;
  }

  result.compat = mergeCompat(model.compat, override.compat);

  return result;
}

export class ModelRegistry {
  private models: Model<Api>[] = [];
  private customProviderApiKeys: Map<string, string> = new Map();
  private registeredProviders: Map<string, ProviderConfigInput> = new Map();
  private loadError: string | undefined = undefined;

  constructor(
    readonly authStorage: AuthStorage,
    private modelsJsonPath: string | undefined = join(getAgentDir(), 'models.json')
  ) {
    this.authStorage.setFallbackResolver(provider => {
      const keyConfig = this.customProviderApiKeys.get(provider);
      if (keyConfig) {
        return resolveConfigValue(keyConfig);
      }
      return undefined;
    });

    this.loadModels();
  }

  refresh(): void {
    this.customProviderApiKeys.clear();
    this.loadError = undefined;

    resetApiProviders();
    resetOAuthProviders();

    this.loadModels();

    for (const [providerName, config] of this.registeredProviders.entries()) {
      this.applyProviderConfig(providerName, config);
    }
  }

  getError(): string | undefined {
    return this.loadError;
  }

  private loadModels(): void {
    const {
      models: customModels,
      overrides,
      modelOverrides,
      error
    } = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();

    if (error) {
      this.loadError = error;
    }

    const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
    let combined = this.mergeCustomModels(builtInModels, customModels);

    for (const oauthProvider of this.authStorage.getOAuthProviders()) {
      const cred = this.authStorage.get(oauthProvider.id);
      if (cred?.type === 'oauth' && oauthProvider.modifyModels) {
        combined = oauthProvider.modifyModels(combined, cred);
      }
    }

    this.models = combined;
  }

  private loadBuiltInModels(overrides: Map<string, ProviderOverride>, modelOverrides: Map<string, Map<string, ModelOverride>>): Model<Api>[] {
    return getProviders().flatMap(provider => {
      const models = getModels(provider as KnownProvider) as Model<Api>[];
      const providerOverride = overrides.get(provider);
      const perModelOverrides = modelOverrides.get(provider);

      return models.map(m => {
        let model = m;

        if (providerOverride) {
          const resolvedHeaders = resolveHeaders(providerOverride.headers);
          model = {
            ...model,
            baseUrl: providerOverride.baseUrl ?? model.baseUrl,
            headers: resolvedHeaders ? { ...model.headers, ...resolvedHeaders } : model.headers,
            compat: mergeCompat(model.compat, providerOverride.compat)
          };
        }

        const modelOverride = perModelOverrides?.get(m.id);
        if (modelOverride) {
          model = applyModelOverride(model, modelOverride);
        }

        return model;
      });
    });
  }

  private mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
    const merged = [...builtInModels];
    for (const customModel of customModels) {
      const existingIndex = merged.findIndex(m => m.provider === customModel.provider && m.id === customModel.id);
      if (existingIndex >= 0) {
        merged[existingIndex] = customModel;
      } else {
        merged.push(customModel);
      }
    }
    return merged;
  }

  private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
    if (!existsSync(modelsJsonPath)) {
      return emptyCustomModelsResult();
    }

    try {
      const content = readFileSync(modelsJsonPath, 'utf-8');
      const config: ModelsConfig = JSON.parse(content);

      const validate = ajv.getSchema('ModelsConfig')!;
      if (!validate(config)) {
        const errors = validate.errors?.map((e: any) => `  - ${e.instancePath || 'root'}: ${e.message}`).join('\n') || 'Unknown schema error';
        return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
      }

      this.validateConfig(config);

      const overrides = new Map<string, ProviderOverride>();
      const modelOverrides = new Map<string, Map<string, ModelOverride>>();

      for (const [providerName, providerConfig] of Object.entries(config.providers)) {
        if (providerConfig.baseUrl || providerConfig.headers || providerConfig.apiKey || providerConfig.compat) {
          overrides.set(providerName, {
            baseUrl: providerConfig.baseUrl,
            headers: providerConfig.headers,
            apiKey: providerConfig.apiKey,
            compat: providerConfig.compat
          });
        }

        if (providerConfig.apiKey) {
          this.customProviderApiKeys.set(providerName, providerConfig.apiKey);
        }

        if (providerConfig.modelOverrides) {
          modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
        }
      }

      return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
      }
      return emptyCustomModelsResult(`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`);
    }
  }

  private validateConfig(config: ModelsConfig): void {
    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const hasProviderApi = !!providerConfig.api;
      const models = providerConfig.models ?? [];
      const hasModelOverrides = providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;

      if (models.length === 0) {
        if (!providerConfig.baseUrl && !providerConfig.compat && !hasModelOverrides) {
          throw new Error(`Provider ${providerName}: must specify "baseUrl", "compat", "modelOverrides", or "models".`);
        }
      } else {
        if (!providerConfig.baseUrl) {
          throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
        }
        if (!providerConfig.apiKey) {
          throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
        }
      }

      for (const modelDef of models) {
        const hasModelApi = !!modelDef.api;

        if (!hasProviderApi && !hasModelApi) {
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`);
        }

        if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);

        if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0)
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
        if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0)
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
      }
    }
  }

  private parseModels(config: ModelsConfig): Model<Api>[] {
    const models: Model<Api>[] = [];

    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const modelDefs = providerConfig.models ?? [];
      if (modelDefs.length === 0) continue;

      if (providerConfig.apiKey) {
        this.customProviderApiKeys.set(providerName, providerConfig.apiKey);
      }

      for (const modelDef of modelDefs) {
        const api = modelDef.api || providerConfig.api;
        if (!api) continue;

        const providerHeaders = resolveHeaders(providerConfig.headers);
        const modelHeaders = resolveHeaders(modelDef.headers);
        const compat = mergeCompat(providerConfig.compat, modelDef.compat);
        let headers = providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : undefined;

        if (providerConfig.authHeader && providerConfig.apiKey) {
          const resolvedKey = resolveConfigValue(providerConfig.apiKey);
          if (resolvedKey) {
            headers = { ...headers, Authorization: `Bearer ${resolvedKey}` };
          }
        }

        const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        models.push({
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api: api as Api,
          provider: providerName,
          baseUrl: modelDef.baseUrl ?? providerConfig.baseUrl!,
          reasoning: modelDef.reasoning ?? false,
          input: (modelDef.input ?? ['text']) as ('text' | 'image')[],
          cost: modelDef.cost ?? defaultCost,
          contextWindow: modelDef.contextWindow ?? 128000,
          maxTokens: modelDef.maxTokens ?? 16384,
          headers,
          compat
        } as Model<Api>);
      }
    }

    return models;
  }

  getAll(): Model<Api>[] {
    return this.models;
  }

  getAvailable(): Model<Api>[] {
    return this.models.filter(m => this.authStorage.hasAuth(m.provider));
  }

  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.models.find(m => m.provider === provider && m.id === modelId);
  }

  async getApiKey(model: Model<Api>): Promise<string | undefined> {
    return this.authStorage.getApiKey(model.provider);
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    return this.authStorage.getApiKey(provider);
  }

  isUsingOAuth(model: Model<Api>): boolean {
    const cred = this.authStorage.get(model.provider);
    return cred?.type === 'oauth';
  }

  registerProvider(providerName: string, config: ProviderConfigInput): void {
    this.validateProviderConfig(providerName, config);
    this.applyProviderConfig(providerName, config);
    this.registeredProviders.set(providerName, config);
  }

  unregisterProvider(providerName: string): void {
    if (!this.registeredProviders.has(providerName)) return;
    this.registeredProviders.delete(providerName);
    this.customProviderApiKeys.delete(providerName);
    this.refresh();
  }

  private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.streamSimple && !config.api) {
      throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
    }

    if (!config.models || config.models.length === 0) {
      return;
    }

    if (!config.baseUrl) {
      throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
    }
    if (!config.apiKey && !config.oauth) {
      throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
    }

    for (const modelDef of config.models) {
      const api = modelDef.api || config.api;
      if (!api) {
        throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
      }
    }
  }

  private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.oauth) {
      const oauthProvider: OAuthProviderInterface = {
        ...config.oauth,
        id: providerName
      };
      registerOAuthProvider(oauthProvider);
    }

    if (config.streamSimple) {
      const streamSimple = config.streamSimple;
      registerApiProvider(
        {
          api: config.api!,
          stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
          streamSimple
        },
        `provider:${providerName}`
      );
    }

    if (config.apiKey) {
      this.customProviderApiKeys.set(providerName, config.apiKey);
    }

    if (config.models && config.models.length > 0) {
      this.models = this.models.filter(m => m.provider !== providerName);

      for (const modelDef of config.models) {
        const api = modelDef.api || config.api;

        const providerHeaders = resolveHeaders(config.headers);
        const modelHeaders = resolveHeaders(modelDef.headers);
        let headers = providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : undefined;

        if (config.authHeader && config.apiKey) {
          const resolvedKey = resolveConfigValue(config.apiKey);
          if (resolvedKey) {
            headers = { ...headers, Authorization: `Bearer ${resolvedKey}` };
          }
        }

        this.models.push({
          id: modelDef.id,
          name: modelDef.name,
          api: api as Api,
          provider: providerName,
          baseUrl: config.baseUrl!,
          reasoning: modelDef.reasoning,
          input: modelDef.input as ('text' | 'image')[],
          cost: modelDef.cost,
          contextWindow: modelDef.contextWindow,
          maxTokens: modelDef.maxTokens,
          headers,
          compat: modelDef.compat
        } as Model<Api>);
      }

      if (config.oauth?.modifyModels) {
        const cred = this.authStorage.get(providerName);
        if (cred?.type === 'oauth') {
          this.models = config.oauth.modifyModels(this.models, cred);
        }
      }
    } else if (config.baseUrl) {
      const resolvedHeaders = resolveHeaders(config.headers);
      this.models = this.models.map(m => {
        if (m.provider !== providerName) return m;
        return {
          ...m,
          baseUrl: config.baseUrl ?? m.baseUrl,
          headers: resolvedHeaders ? { ...m.headers, ...resolvedHeaders } : m.headers
        };
      });
    }
  }
}

export interface ProviderConfigInput {
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
  headers?: Record<string, string>;
  authHeader?: boolean;

  oauth?: Omit<OAuthProviderInterface, 'id'>;
  models?: Array<{
    id: string;
    name: string;
    api?: Api;
    baseUrl?: string;
    reasoning: boolean;
    input: ('text' | 'image')[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: Model<Api>['compat'];
  }>;
}
