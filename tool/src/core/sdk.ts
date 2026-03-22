import { join } from 'node:path';
import { Agent, type AgentMessage, type ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Message, Model } from '@mariozechner/pi-ai';
import { getAgentDir } from '../config.js';
import { AgentSession } from './agent-session.js';
import { AuthStorage } from './auth-storage.js';
import { DEFAULT_THINKING_LEVEL } from '../config.js';
import type { ExtensionRunner, ToolDefinition } from './extensions/index.js';
import { convertToLlm } from './messages.js';
import { ModelRegistry } from './model-registry.js';
import { findInitialModel } from './model-resolver.js';
import type { ResourceLoader } from './resource-loader.js';
import { DefaultResourceLoader } from './resource-loader.js';
import { getDefaultSessionDir, SessionManager } from './session-manager.js';
import { SettingsManager } from './settings-manager.js';
import {
  allTools,
  bashTool,
  codingTools,
  createBashTool,
  createCodingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadOnlyTools,
  createReadTool,
  createWriteTool,
  editTool,
  findTool,
  grepTool,
  lsTool,
  readOnlyTools,
  readTool,
  type Tool,
  type ToolName,
  withFileMutationQueue,
  writeTool
} from './tools/index.js';

export interface CreateAgentSessionOptions {
  cwd?: string;

  agentDir?: string;

  authStorage?: AuthStorage;

  modelRegistry?: ModelRegistry;

  model?: Model<any>;

  thinkingLevel?: ThinkingLevel;

  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

  tools?: Tool[];

  customTools?: ToolDefinition[];

  resourceLoader?: ResourceLoader;

  sessionManager?: SessionManager;

  settingsManager?: SettingsManager;
}

export interface CreateAgentSessionResult {
  session: AgentSession;

  modelFallbackMessage?: string;
}

export type {
  SlashCommandInfo,
  SlashCommandLocation,
  SlashCommandSource,
  ToolDefinition
} from './extensions/index.js';
export type { PromptTemplate } from './prompt-templates.js';
export type { Skill } from './skills.js';
export type { Tool } from './tools/index.js';

export {
  readTool,
  bashTool,
  editTool,
  writeTool,
  grepTool,
  findTool,
  lsTool,
  codingTools,
  readOnlyTools,
  allTools as allBuiltInTools,
  withFileMutationQueue,
  createCodingTools,
  createReadOnlyTools,
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool
};

function getDefaultAgentDir(): string {
  return getAgentDir();
}

export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getDefaultAgentDir();
  let resourceLoader = options.resourceLoader;

  const authPath = options.agentDir ? join(agentDir, 'auth.json') : undefined;
  const modelsPath = options.agentDir ? join(agentDir, 'models.json') : undefined;
  const authStorage = options.authStorage ?? AuthStorage.create(authPath);
  const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, modelsPath);

  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

  if (!resourceLoader) {
    resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await resourceLoader.reload();
  }

  const existingSession = sessionManager.buildSessionContext();
  const hasExistingSession = existingSession.messages.length > 0;
  const hasThinkingEntry = sessionManager.getBranch().some(entry => entry.type === 'thinking_level_change');

  let model = options.model;
  let modelFallbackMessage: string | undefined;

  if (!model && hasExistingSession && existingSession.model) {
    const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
    if (restoredModel && (await modelRegistry.getApiKey(restoredModel))) {
      model = restoredModel;
    }
  }

  if (!model) {
    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: hasExistingSession,
      defaultProvider: settingsManager.getDefaultProvider(),
      defaultModelId: settingsManager.getDefaultModel(),
      defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
      modelRegistry
    });
    model = result.model;
    if (!model) {
    } else if (modelFallbackMessage) {
      modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
    }
  }

  let thinkingLevel = options.thinkingLevel;

  if (thinkingLevel === undefined && hasExistingSession) {
    thinkingLevel = hasThinkingEntry
      ? (existingSession.thinkingLevel as ThinkingLevel)
      : (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
  }

  if (thinkingLevel === undefined) {
    thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
  }

  if (!model || !model.reasoning) {
    thinkingLevel = 'off';
  }

  const defaultActiveToolNames: ToolName[] = ['read', 'bash', 'edit', 'write'];
  const initialActiveToolNames: ToolName[] = options.tools
    ? options.tools.map(t => t.name).filter((n): n is ToolName => n in allTools)
    : defaultActiveToolNames;

  let agent: Agent;

  const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
    const converted = convertToLlm(messages);

    if (!settingsManager.getBlockImages()) {
      return converted;
    }

    return converted.map(msg => {
      if (msg.role === 'user' || msg.role === 'toolResult') {
        const content = msg.content;
        if (Array.isArray(content)) {
          const hasImages = content.some(c => c.type === 'image');
          if (hasImages) {
            const filteredContent = content
              .map(c => (c.type === 'image' ? { type: 'text' as const, text: 'Image reading is disabled.' } : c))
              .filter(
                (c, i, arr) =>
                  !(
                    c.type === 'text' &&
                    c.text === 'Image reading is disabled.' &&
                    i > 0 &&
                    arr[i - 1].type === 'text' &&
                    (arr[i - 1] as { type: 'text'; text: string }).text === 'Image reading is disabled.'
                  )
              );
            return { ...msg, content: filteredContent };
          }
        }
      }
      return msg;
    });
  };

  const extensionRunnerRef: { current?: ExtensionRunner } = {};

  agent = new Agent({
    initialState: {
      systemPrompt: '',
      model,
      thinkingLevel,
      tools: []
    },
    convertToLlm: convertToLlmWithBlockImages,
    onPayload: async (payload, _model) => {
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers('before_provider_request')) {
        return payload;
      }
      return runner.emitBeforeProviderRequest(payload);
    },
    sessionId: sessionManager.getSessionId(),
    transformContext: async messages => {
      const runner = extensionRunnerRef.current;
      if (!runner) return messages;
      return runner.emitContext(messages);
    },
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    transport: settingsManager.getTransport(),
    thinkingBudgets: settingsManager.getThinkingBudgets(),
    maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
    getApiKey: async provider => {
      const resolvedProvider = provider || agent.state.model?.provider;
      if (!resolvedProvider) {
        throw new Error('No model selected');
      }
      const key = await modelRegistry.getApiKeyForProvider(resolvedProvider);
      if (!key) {
        const model = agent.state.model;
        const isOAuth = model && modelRegistry.isUsingOAuth(model);
        if (isOAuth) {
          throw new Error(
            `Authentication failed for "${resolvedProvider}". ` +
              `Credentials may have expired or network is unavailable. ` +
              `Run '/login ${resolvedProvider}' to re-authenticate.`
          );
        }
        throw new Error(`No API key found for "${resolvedProvider}". ` + `Set an API key environment variable or run '/login ${resolvedProvider}'.`);
      }
      return key;
    }
  });

  if (hasExistingSession) {
    agent.replaceMessages(existingSession.messages);
    if (!hasThinkingEntry) {
      sessionManager.appendThinkingLevelChange(thinkingLevel);
    }
  } else {
    if (model) {
      sessionManager.appendModelChange(model.provider, model.id);
    }
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }

  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd,
    scopedModels: options.scopedModels,
    resourceLoader,
    customTools: options.customTools,
    modelRegistry,
    initialActiveToolNames,
    extensionRunnerRef
  });

  return {
    session,
    modelFallbackMessage
  };
}
