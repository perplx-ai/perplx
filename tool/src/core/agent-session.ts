import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Agent, AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from '@mariozechner/pi-ai';
import { isContextOverflow, modelsAreEqual, resetApiProviders, supportsXhigh } from '@mariozechner/pi-ai';
import { theme } from '../modes/interactive/theme/theme.js';
import { stripFrontmatter } from '../utils/frontmatter.js';
import { sleep } from '../utils/sleep.js';
import { type BashResult, executeBash as executeBashCommand, executeBashWithOperations } from './bash-executor.js';
import {
  type CompactionResult,
  calculateContextTokens,
  collectEntriesForBranchSummary,
  compact,
  estimateContextTokens,
  generateBranchSummary,
  prepareCompaction,
  shouldCompact
} from './compaction/index.js';
import { DEFAULT_THINKING_LEVEL } from '../config.js';
import {
  type ContextUsage,
  type ExtensionCommandContextActions,
  type ExtensionErrorListener,
  ExtensionRunner,
  type ExtensionUIContext,
  type InputSource,
  type MessageEndEvent,
  type MessageStartEvent,
  type MessageUpdateEvent,
  type SessionBeforeCompactResult,
  type SessionBeforeForkResult,
  type SessionBeforeSwitchResult,
  type SessionBeforeTreeResult,
  type ShutdownHandler,
  type ToolDefinition,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolExecutionUpdateEvent,
  type ToolInfo,
  type TreePreparation,
  type TurnEndEvent,
  type TurnStartEvent,
  wrapRegisteredTools
} from './extensions/index.js';
import type { BashExecutionMessage, CustomMessage } from './messages.js';
import type { ModelRegistry } from './model-registry.js';
import { expandPromptTemplate, type PromptTemplate } from './prompt-templates.js';
import type { ResourceExtensionPaths, ResourceLoader } from './resource-loader.js';
import type { BranchSummaryEntry, CompactionEntry, SessionManager } from './session-manager.js';
import { getLatestCompactionEntry } from './session-manager.js';
import type { SettingsManager } from './settings-manager.js';
import { BUILTIN_SLASH_COMMANDS, type SlashCommandInfo, type SlashCommandLocation } from './slash-commands.js';
import { buildSystemPrompt } from '../prompt.js';
import type { BashOperations } from './tools/bash.js';
import { createAllTools } from './tools/index.js';

export interface ParsedSkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage: string | undefined;
}

export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() || undefined
  };
}

export type AgentSessionEvent =
  | AgentEvent
  | { type: 'auto_compaction_start'; reason: 'threshold' | 'overflow' }
  | {
      type: 'auto_compaction_end';
      result: CompactionResult | undefined;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export interface AgentSessionConfig {
  agent: Agent;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  cwd: string;

  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

  resourceLoader: ResourceLoader;

  customTools?: ToolDefinition[];

  modelRegistry: ModelRegistry;

  initialActiveToolNames?: string[];

  baseToolsOverride?: Record<string, AgentTool>;

  extensionRunnerRef?: { current?: ExtensionRunner };
}

export interface ExtensionBindings {
  uiContext?: ExtensionUIContext;
  commandContextActions?: ExtensionCommandContextActions;
  shutdownHandler?: ShutdownHandler;
  onError?: ExtensionErrorListener;
}

export interface PromptOptions {
  expandPromptTemplates?: boolean;

  images?: ImageContent[];

  streamingBehavior?: 'steer' | 'followUp';

  source?: InputSource;
}

export interface ModelCycleResult {
  model: Model<any>;
  thinkingLevel: ThinkingLevel;

  isScoped: boolean;
}

export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

const THINKING_LEVELS_WITH_XHIGH: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export class AgentSession {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;

  private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

  private _unsubscribeAgent?: () => void;
  private _eventListeners: AgentSessionEventListener[] = [];
  private _agentEventQueue: Promise<void> = Promise.resolve();

  private _steeringMessages: string[] = [];

  private _followUpMessages: string[] = [];

  private _pendingNextTurnMessages: CustomMessage[] = [];

  private _compactionAbortController: AbortController | undefined = undefined;
  private _autoCompactionAbortController: AbortController | undefined = undefined;
  private _overflowRecoveryAttempted = false;

  private _branchSummaryAbortController: AbortController | undefined = undefined;

  private _retryAbortController: AbortController | undefined = undefined;
  private _retryAttempt = 0;
  private _retryPromise: Promise<void> | undefined = undefined;
  private _retryResolve: (() => void) | undefined = undefined;

  private _bashAbortController: AbortController | undefined = undefined;
  private _pendingBashMessages: BashExecutionMessage[] = [];

  private _extensionRunner: ExtensionRunner | undefined = undefined;
  private _turnIndex = 0;

  private _resourceLoader: ResourceLoader;
  private _customTools: ToolDefinition[];
  private _baseToolRegistry: Map<string, AgentTool> = new Map();
  private _cwd: string;
  private _extensionRunnerRef?: { current?: ExtensionRunner };
  private _initialActiveToolNames?: string[];
  private _baseToolsOverride?: Record<string, AgentTool>;
  private _extensionUIContext?: ExtensionUIContext;
  private _extensionCommandContextActions?: ExtensionCommandContextActions;
  private _extensionShutdownHandler?: ShutdownHandler;
  private _extensionErrorListener?: ExtensionErrorListener;
  private _extensionErrorUnsubscriber?: () => void;

  private _modelRegistry: ModelRegistry;

  private _toolRegistry: Map<string, AgentTool> = new Map();
  private _toolPromptSnippets: Map<string, string> = new Map();
  private _toolPromptGuidelines: Map<string, string[]> = new Map();

  private _baseSystemPrompt = '';

  constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this.settingsManager = config.settingsManager;
    this._scopedModels = config.scopedModels ?? [];
    this._resourceLoader = config.resourceLoader;
    this._customTools = config.customTools ?? [];
    this._cwd = config.cwd;
    this._modelRegistry = config.modelRegistry;
    this._extensionRunnerRef = config.extensionRunnerRef;
    this._initialActiveToolNames = config.initialActiveToolNames;
    this._baseToolsOverride = config.baseToolsOverride;

    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
    this._installAgentToolHooks();

    this._buildRuntime({
      activeToolNames: this._initialActiveToolNames,
      includeAllExtensionTools: true
    });
  }

  get modelRegistry(): ModelRegistry {
    return this._modelRegistry;
  }

  private _installAgentToolHooks(): void {
    this.agent.setBeforeToolCall(async ({ toolCall, args }) => {
      const runner = this._extensionRunner;
      if (!runner?.hasHandlers('tool_call')) {
        return undefined;
      }

      await this._agentEventQueue;

      try {
        return await runner.emitToolCall({
          type: 'tool_call',
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          input: args as Record<string, unknown>
        });
      } catch (err) {
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(`Extension failed, blocking execution: ${String(err)}`);
      }
    });

    this.agent.setAfterToolCall(async ({ toolCall, args, result, isError }) => {
      const runner = this._extensionRunner;
      if (!runner?.hasHandlers('tool_result')) {
        return undefined;
      }

      const hookResult = await runner.emitToolResult({
        type: 'tool_result',
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        input: args as Record<string, unknown>,
        content: result.content,
        details: isError ? undefined : result.details,
        isError
      });

      if (!hookResult || isError) {
        return undefined;
      }

      return {
        content: hookResult.content,
        details: hookResult.details
      };
    });
  }

  private _emit(event: AgentSessionEvent): void {
    for (const l of this._eventListeners) {
      l(event);
    }
  }

  private _lastAssistantMessage: AssistantMessage | undefined = undefined;

  private _handleAgentEvent = (event: AgentEvent): void => {
    this._createRetryPromiseForAgentEnd(event);

    this._agentEventQueue = this._agentEventQueue.then(
      () => this._processAgentEvent(event),
      () => this._processAgentEvent(event)
    );

    this._agentEventQueue.catch(() => {});
  };

  private _createRetryPromiseForAgentEnd(event: AgentEvent): void {
    if (event.type !== 'agent_end' || this._retryPromise) {
      return;
    }

    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled) {
      return;
    }

    const lastAssistant = this._findLastAssistantInMessages(event.messages);
    if (!lastAssistant || !this._isRetryableError(lastAssistant)) {
      return;
    }

    this._retryPromise = new Promise(resolve => {
      this._retryResolve = resolve;
    });
  }

  private _findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === 'assistant') {
        return message as AssistantMessage;
      }
    }
    return undefined;
  }

  private async _processAgentEvent(event: AgentEvent): Promise<void> {
    if (event.type === 'message_start' && event.message.role === 'user') {
      this._overflowRecoveryAttempted = false;
      const messageText = this._getUserMessageText(event.message);
      if (messageText) {
        const steeringIndex = this._steeringMessages.indexOf(messageText);
        if (steeringIndex !== -1) {
          this._steeringMessages.splice(steeringIndex, 1);
        } else {
          const followUpIndex = this._followUpMessages.indexOf(messageText);
          if (followUpIndex !== -1) {
            this._followUpMessages.splice(followUpIndex, 1);
          }
        }
      }
    }

    await this._emitExtensionEvent(event);

    this._emit(event);

    if (event.type === 'message_end') {
      if (event.message.role === 'custom') {
        this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);
      } else if (event.message.role === 'user' || event.message.role === 'assistant' || event.message.role === 'toolResult') {
        this.sessionManager.appendMessage(event.message);
      }

      if (event.message.role === 'assistant') {
        this._lastAssistantMessage = event.message;

        const assistantMsg = event.message as AssistantMessage;
        if (assistantMsg.stopReason !== 'error') {
          this._overflowRecoveryAttempted = false;
        }

        if (assistantMsg.stopReason !== 'error' && this._retryAttempt > 0) {
          this._emit({
            type: 'auto_retry_end',
            success: true,
            attempt: this._retryAttempt
          });
          this._retryAttempt = 0;
        }
      }
    }

    if (event.type === 'agent_end' && this._lastAssistantMessage) {
      const msg = this._lastAssistantMessage;
      this._lastAssistantMessage = undefined;

      if (this._isRetryableError(msg)) {
        const didRetry = await this._handleRetryableError(msg);
        if (didRetry) return;
      }

      this._resolveRetry();
      await this._checkCompaction(msg);
    }
  }

  private _resolveRetry(): void {
    if (this._retryResolve) {
      this._retryResolve();
      this._retryResolve = undefined;
      this._retryPromise = undefined;
    }
  }

  private _getUserMessageText(message: Message): string {
    if (message.role !== 'user') return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    const textBlocks = content.filter(c => c.type === 'text');
    return textBlocks.map(c => (c as TextContent).text).join('');
  }

  private _findLastAssistantMessage(): AssistantMessage | undefined {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant') {
        return msg as AssistantMessage;
      }
    }
    return undefined;
  }

  private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
    if (!this._extensionRunner) return;

    if (event.type === 'agent_start') {
      this._turnIndex = 0;
      await this._extensionRunner.emit({ type: 'agent_start' });
    } else if (event.type === 'agent_end') {
      await this._extensionRunner.emit({ type: 'agent_end', messages: event.messages });
    } else if (event.type === 'turn_start') {
      const extensionEvent: TurnStartEvent = {
        type: 'turn_start',
        turnIndex: this._turnIndex,
        timestamp: Date.now()
      };
      await this._extensionRunner.emit(extensionEvent);
    } else if (event.type === 'turn_end') {
      const extensionEvent: TurnEndEvent = {
        type: 'turn_end',
        turnIndex: this._turnIndex,
        message: event.message,
        toolResults: event.toolResults
      };
      await this._extensionRunner.emit(extensionEvent);
      this._turnIndex++;
    } else if (event.type === 'message_start') {
      const extensionEvent: MessageStartEvent = {
        type: 'message_start',
        message: event.message
      };
      await this._extensionRunner.emit(extensionEvent);
    } else if (event.type === 'message_update') {
      const extensionEvent: MessageUpdateEvent = {
        type: 'message_update',
        message: event.message,
        assistantMessageEvent: event.assistantMessageEvent
      };
      await this._extensionRunner.emit(extensionEvent);
    } else if (event.type === 'message_end') {
      const extensionEvent: MessageEndEvent = {
        type: 'message_end',
        message: event.message
      };
      await this._extensionRunner.emit(extensionEvent);
    } else if (event.type === 'tool_execution_start') {
      const extensionEvent: ToolExecutionStartEvent = {
        type: 'tool_execution_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args
      };
      await this._extensionRunner.emit(extensionEvent);
    } else if (event.type === 'tool_execution_update') {
      const extensionEvent: ToolExecutionUpdateEvent = {
        type: 'tool_execution_update',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult
      };
      await this._extensionRunner.emit(extensionEvent);
    } else if (event.type === 'tool_execution_end') {
      const extensionEvent: ToolExecutionEndEvent = {
        type: 'tool_execution_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError
      };
      await this._extensionRunner.emit(extensionEvent);
    }
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this._eventListeners.push(listener);

    return () => {
      const index = this._eventListeners.indexOf(listener);
      if (index !== -1) {
        this._eventListeners.splice(index, 1);
      }
    };
  }

  private _disconnectFromAgent(): void {
    if (this._unsubscribeAgent) {
      this._unsubscribeAgent();
      this._unsubscribeAgent = undefined;
    }
  }

  private _reconnectToAgent(): void {
    if (this._unsubscribeAgent) return;
    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
  }

  dispose(): void {
    this._disconnectFromAgent();
    this._eventListeners = [];
  }

  get state(): AgentState {
    return this.agent.state;
  }

  get customTools(): readonly ToolDefinition[] {
    return this._customTools;
  }

  get model(): Model<any> | undefined {
    return this.agent.state.model;
  }

  get thinkingLevel(): ThinkingLevel {
    return this.agent.state.thinkingLevel;
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  get systemPrompt(): string {
    return this.agent.state.systemPrompt;
  }

  get retryAttempt(): number {
    return this._retryAttempt;
  }

  getActiveToolNames(): string[] {
    return this.agent.state.tools.map(t => t.name);
  }

  getAllTools(): ToolInfo[] {
    return Array.from(this._toolRegistry.values()).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
  }

  setActiveToolsByName(toolNames: string[]): void {
    const tools: AgentTool[] = [];
    const validToolNames: string[] = [];
    for (const name of toolNames) {
      const tool = this._toolRegistry.get(name);
      if (tool) {
        tools.push(tool);
        validToolNames.push(name);
      }
    }
    this.agent.setTools(tools);

    this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
    this.agent.setSystemPrompt(this._baseSystemPrompt);
  }

  get isCompacting(): boolean {
    return (
      this._autoCompactionAbortController !== undefined ||
      this._compactionAbortController !== undefined ||
      this._branchSummaryAbortController !== undefined
    );
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  get steeringMode(): 'all' | 'one-at-a-time' {
    return this.agent.getSteeringMode();
  }

  get followUpMode(): 'all' | 'one-at-a-time' {
    return this.agent.getFollowUpMode();
  }

  get sessionFile(): string | undefined {
    return this.sessionManager.getSessionFile();
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get sessionName(): string | undefined {
    return this.sessionManager.getSessionName();
  }

  get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
    return this._scopedModels;
  }

  get promptTemplates(): ReadonlyArray<PromptTemplate> {
    return this._resourceLoader.getPrompts().prompts;
  }

  private _normalizePromptSnippet(text: string | undefined): string | undefined {
    if (!text) return undefined;
    const oneLine = text
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return oneLine.length > 0 ? oneLine : undefined;
  }

  private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
    if (!guidelines || guidelines.length === 0) {
      return [];
    }

    const unique = new Set<string>();
    for (const guideline of guidelines) {
      const normalized = guideline.trim();
      if (normalized.length > 0) {
        unique.add(normalized);
      }
    }
    return Array.from(unique);
  }

  private _rebuildSystemPrompt(toolNames: string[]): string {
    const validToolNames = toolNames.filter(name => this._toolRegistry.has(name));
    const toolSnippets: Record<string, string> = {};
    const promptGuidelines: string[] = [];
    for (const name of validToolNames) {
      const snippet = this._toolPromptSnippets.get(name);
      if (snippet) {
        toolSnippets[name] = snippet;
      }

      const toolGuidelines = this._toolPromptGuidelines.get(name);
      if (toolGuidelines) {
        promptGuidelines.push(...toolGuidelines);
      }
    }

    const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
    const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
    const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join('\n\n') : undefined;
    const loadedSkills = this._resourceLoader.getSkills().skills;
    const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

    return buildSystemPrompt({
      cwd: this._cwd,
      skills: loadedSkills,
      contextFiles: loadedContextFiles,
      customPrompt: loaderSystemPrompt,
      appendSystemPrompt,
      selectedTools: validToolNames,
      toolSnippets,
      promptGuidelines
    });
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;

    if (expandPromptTemplates && text.startsWith('/')) {
      const handled = await this._tryExecuteExtensionCommand(text);
      if (handled) {
        return;
      }
    }

    let currentText = text;
    let currentImages = options?.images;
    if (this._extensionRunner?.hasHandlers('input')) {
      const inputResult = await this._extensionRunner.emitInput(currentText, currentImages, options?.source ?? 'interactive');
      if (inputResult.action === 'handled') {
        return;
      }
      if (inputResult.action === 'transform') {
        currentText = inputResult.text;
        currentImages = inputResult.images ?? currentImages;
      }
    }

    let expandedText = currentText;
    if (expandPromptTemplates) {
      expandedText = this._expandSkillCommand(expandedText);
      expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
    }

    if (this.isStreaming) {
      if (!options?.streamingBehavior) {
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      }
      if (options.streamingBehavior === 'followUp') {
        await this._queueFollowUp(expandedText, currentImages);
      } else {
        await this._queueSteer(expandedText, currentImages);
      }
      return;
    }

    this._flushPendingBashMessages();

    if (!this.model) {
      throw new Error('No model selected.\n\n' + `Set an API key environment variable.\n\n` + 'Then use /model to select a model.');
    }

    const apiKey = await this._modelRegistry.getApiKey(this.model);
    if (!apiKey) {
      const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
      if (isOAuth) {
        throw new Error(
          `Authentication failed for "${this.model.provider}". ` +
            `Credentials may have expired or network is unavailable. ` +
            `Run '/login ${this.model.provider}' to re-authenticate.`
        );
      }
      throw new Error(`No API key found for ${this.model.provider}.\n\n` + `Set an API key environment variable.`);
    }

    const lastAssistant = this._findLastAssistantMessage();
    if (lastAssistant) {
      await this._checkCompaction(lastAssistant, false);
    }

    const messages: AgentMessage[] = [];

    const userContent: (TextContent | ImageContent)[] = [{ type: 'text', text: expandedText }];
    if (currentImages) {
      userContent.push(...currentImages);
    }
    messages.push({
      role: 'user',
      content: userContent,
      timestamp: Date.now()
    });

    for (const msg of this._pendingNextTurnMessages) {
      messages.push(msg);
    }
    this._pendingNextTurnMessages = [];

    if (this._extensionRunner) {
      const result = await this._extensionRunner.emitBeforeAgentStart(expandedText, currentImages, this._baseSystemPrompt);

      if (result?.messages) {
        for (const msg of result.messages) {
          messages.push({
            role: 'custom',
            customType: msg.customType,
            content: msg.content,
            display: msg.display,
            details: msg.details,
            timestamp: Date.now()
          });
        }
      }

      if (result?.systemPrompt) {
        this.agent.setSystemPrompt(result.systemPrompt);
      } else {
        this.agent.setSystemPrompt(this._baseSystemPrompt);
      }
    }

    await this.agent.prompt(messages);
    await this.waitForRetry();
  }

  private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
    if (!this._extensionRunner) return false;

    const spaceIndex = text.indexOf(' ');
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1);

    const command = this._extensionRunner.getCommand(commandName);
    if (!command) return false;

    const ctx = this._extensionRunner.createCommandContext();

    try {
      await command.handler(args, ctx);
      return true;
    } catch (err) {
      this._extensionRunner.emitError({
        extensionPath: `command:${commandName}`,
        event: 'command',
        error: err instanceof Error ? err.message : String(err)
      });
      return true;
    }
  }

  private _expandSkillCommand(text: string): string {
    if (!text.startsWith('/skill:')) return text;

    const spaceIndex = text.indexOf(' ');
    const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
    const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();

    const skill = this.resourceLoader.getSkills().skills.find(s => s.name === skillName);
    if (!skill) return text;

    try {
      const content = readFileSync(skill.filePath, 'utf-8');
      const body = stripFrontmatter(content).trim();
      const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      return args ? `${skillBlock}\n\n${args}` : skillBlock;
    } catch (err) {
      this._extensionRunner?.emitError({
        extensionPath: skill.filePath,
        event: 'skill_expansion',
        error: err instanceof Error ? err.message : String(err)
      });
      return text;
    }
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    if (text.startsWith('/')) {
      this._throwIfExtensionCommand(text);
    }

    let expandedText = this._expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

    await this._queueSteer(expandedText, images);
  }

  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    if (text.startsWith('/')) {
      this._throwIfExtensionCommand(text);
    }

    let expandedText = this._expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

    await this._queueFollowUp(expandedText, images);
  }

  private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
    this._steeringMessages.push(text);
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text }];
    if (images) {
      content.push(...images);
    }
    this.agent.steer({
      role: 'user',
      content,
      timestamp: Date.now()
    });
  }

  private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
    this._followUpMessages.push(text);
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text }];
    if (images) {
      content.push(...images);
    }
    this.agent.followUp({
      role: 'user',
      content,
      timestamp: Date.now()
    });
  }

  private _throwIfExtensionCommand(text: string): void {
    if (!this._extensionRunner) return;

    const spaceIndex = text.indexOf(' ');
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const command = this._extensionRunner.getCommand(commandName);

    if (command) {
      throw new Error(`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`);
    }
  }

  async sendCustomMessage<T = unknown>(
    message: Pick<CustomMessage<T>, 'customType' | 'content' | 'display' | 'details'>,
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }
  ): Promise<void> {
    const appMessage = {
      role: 'custom' as const,
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      timestamp: Date.now()
    } satisfies CustomMessage<T>;
    if (options?.deliverAs === 'nextTurn') {
      this._pendingNextTurnMessages.push(appMessage);
    } else if (this.isStreaming) {
      if (options?.deliverAs === 'followUp') {
        this.agent.followUp(appMessage);
      } else {
        this.agent.steer(appMessage);
      }
    } else if (options?.triggerTurn) {
      await this.agent.prompt(appMessage);
    } else {
      this.agent.appendMessage(appMessage);
      this.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      this._emit({ type: 'message_start', message: appMessage });
      this._emit({ type: 'message_end', message: appMessage });
    }
  }

  async sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { deliverAs?: 'steer' | 'followUp' }): Promise<void> {
    let text: string;
    let images: ImageContent[] | undefined;

    if (typeof content === 'string') {
      text = content;
    } else {
      const textParts: string[] = [];
      images = [];
      for (const part of content) {
        if (part.type === 'text') {
          textParts.push(part.text);
        } else {
          images.push(part);
        }
      }
      text = textParts.join('\n');
      if (images.length === 0) images = undefined;
    }

    await this.prompt(text, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      images,
      source: 'extension'
    });
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = [...this._steeringMessages];
    const followUp = [...this._followUpMessages];
    this._steeringMessages = [];
    this._followUpMessages = [];
    this.agent.clearAllQueues();
    return { steering, followUp };
  }

  get pendingMessageCount(): number {
    return this._steeringMessages.length + this._followUpMessages.length;
  }

  getSteeringMessages(): readonly string[] {
    return this._steeringMessages;
  }

  getFollowUpMessages(): readonly string[] {
    return this._followUpMessages;
  }

  get resourceLoader(): ResourceLoader {
    return this._resourceLoader;
  }

  async abort(): Promise<void> {
    this.abortRetry();
    this.agent.abort();
    await this.agent.waitForIdle();
  }

  async newSession(options?: { parentSession?: string; setup?: (sessionManager: SessionManager) => Promise<void> }): Promise<boolean> {
    const previousSessionFile = this.sessionFile;

    if (this._extensionRunner?.hasHandlers('session_before_switch')) {
      const result = (await this._extensionRunner.emit({
        type: 'session_before_switch',
        reason: 'new'
      })) as SessionBeforeSwitchResult | undefined;

      if (result?.cancel) {
        return false;
      }
    }

    this._disconnectFromAgent();
    await this.abort();
    this.agent.reset();
    this.sessionManager.newSession({ parentSession: options?.parentSession });
    this.agent.sessionId = this.sessionManager.getSessionId();
    this._steeringMessages = [];
    this._followUpMessages = [];
    this._pendingNextTurnMessages = [];

    this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);

    if (options?.setup) {
      await options.setup(this.sessionManager);

      const sessionContext = this.sessionManager.buildSessionContext();
      this.agent.replaceMessages(sessionContext.messages);
    }

    this._reconnectToAgent();

    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        type: 'session_switch',
        reason: 'new',
        previousSessionFile
      });
    }

    return true;
  }

  private async _emitModelSelect(nextModel: Model<any>, previousModel: Model<any> | undefined, source: 'set' | 'cycle' | 'restore'): Promise<void> {
    if (!this._extensionRunner) return;
    if (modelsAreEqual(previousModel, nextModel)) return;
    await this._extensionRunner.emit({
      type: 'model_select',
      model: nextModel,
      previousModel,
      source
    });
  }

  async setModel(model: Model<any>): Promise<void> {
    const apiKey = await this._modelRegistry.getApiKey(model);
    if (!apiKey) {
      throw new Error(`No API key for ${model.provider}/${model.id}`);
    }

    const previousModel = this.model;
    const thinkingLevel = this._getThinkingLevelForModelSwitch();
    this.agent.setModel(model);
    this.sessionManager.appendModelChange(model.provider, model.id);
    this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

    this.setThinkingLevel(thinkingLevel);

    await this._emitModelSelect(model, previousModel, 'set');
  }

  async cycleModel(direction: 'forward' | 'backward' = 'forward'): Promise<ModelCycleResult | undefined> {
    if (this._scopedModels.length > 0) {
      return this._cycleScopedModel(direction);
    }
    return this._cycleAvailableModel(direction);
  }

  private async _getScopedModelsWithApiKey(): Promise<Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>> {
    const apiKeysByProvider = new Map<string, string | undefined>();
    const result: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> = [];

    for (const scoped of this._scopedModels) {
      const provider = scoped.model.provider;
      let apiKey: string | undefined;
      if (apiKeysByProvider.has(provider)) {
        apiKey = apiKeysByProvider.get(provider);
      } else {
        apiKey = await this._modelRegistry.getApiKeyForProvider(provider);
        apiKeysByProvider.set(provider, apiKey);
      }

      if (apiKey) {
        result.push(scoped);
      }
    }

    return result;
  }

  private async _cycleScopedModel(direction: 'forward' | 'backward'): Promise<ModelCycleResult | undefined> {
    const scopedModels = await this._getScopedModelsWithApiKey();
    if (scopedModels.length <= 1) return undefined;

    const currentModel = this.model;
    let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

    if (currentIndex === -1) currentIndex = 0;
    const len = scopedModels.length;
    const nextIndex = direction === 'forward' ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
    const next = scopedModels[nextIndex];
    const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

    this.agent.setModel(next.model);
    this.sessionManager.appendModelChange(next.model.provider, next.model.id);
    this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

    this.setThinkingLevel(thinkingLevel);

    await this._emitModelSelect(next.model, currentModel, 'cycle');

    return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
  }

  private async _cycleAvailableModel(direction: 'forward' | 'backward'): Promise<ModelCycleResult | undefined> {
    const availableModels = await this._modelRegistry.getAvailable();
    if (availableModels.length <= 1) return undefined;

    const currentModel = this.model;
    let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

    if (currentIndex === -1) currentIndex = 0;
    const len = availableModels.length;
    const nextIndex = direction === 'forward' ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
    const nextModel = availableModels[nextIndex];

    const apiKey = await this._modelRegistry.getApiKey(nextModel);
    if (!apiKey) {
      throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
    }

    const thinkingLevel = this._getThinkingLevelForModelSwitch();
    this.agent.setModel(nextModel);
    this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
    this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

    this.setThinkingLevel(thinkingLevel);

    await this._emitModelSelect(nextModel, currentModel, 'cycle');

    return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
  }

  setThinkingLevel(level: ThinkingLevel): void {
    const availableLevels = this.getAvailableThinkingLevels();
    const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

    const isChanging = effectiveLevel !== this.agent.state.thinkingLevel;

    this.agent.setThinkingLevel(effectiveLevel);

    if (isChanging) {
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
      if (this.supportsThinking() || effectiveLevel !== 'off') {
        this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
      }
    }
  }

  cycleThinkingLevel(): ThinkingLevel | undefined {
    if (!this.supportsThinking()) return undefined;

    const levels = this.getAvailableThinkingLevels();
    const currentIndex = levels.indexOf(this.thinkingLevel);
    const nextIndex = (currentIndex + 1) % levels.length;
    const nextLevel = levels[nextIndex];

    this.setThinkingLevel(nextLevel);
    return nextLevel;
  }

  getAvailableThinkingLevels(): ThinkingLevel[] {
    if (!this.supportsThinking()) return ['off'];
    return this.supportsXhighThinking() ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
  }

  supportsXhighThinking(): boolean {
    return this.model ? supportsXhigh(this.model) : false;
  }

  supportsThinking(): boolean {
    return !!this.model?.reasoning;
  }

  private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
    if (explicitLevel !== undefined) {
      return explicitLevel;
    }
    if (!this.supportsThinking()) {
      return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
    }
    return this.thinkingLevel;
  }

  private _clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel {
    const ordered = THINKING_LEVELS_WITH_XHIGH;
    const available = new Set(availableLevels);
    const requestedIndex = ordered.indexOf(level);
    if (requestedIndex === -1) {
      return availableLevels[0] ?? 'off';
    }
    for (let i = requestedIndex; i < ordered.length; i++) {
      const candidate = ordered[i];
      if (available.has(candidate)) return candidate;
    }
    for (let i = requestedIndex - 1; i >= 0; i--) {
      const candidate = ordered[i];
      if (available.has(candidate)) return candidate;
    }
    return availableLevels[0] ?? 'off';
  }

  setSteeringMode(mode: 'all' | 'one-at-a-time'): void {
    this.agent.setSteeringMode(mode);
    this.settingsManager.setSteeringMode(mode);
  }

  setFollowUpMode(mode: 'all' | 'one-at-a-time'): void {
    this.agent.setFollowUpMode(mode);
    this.settingsManager.setFollowUpMode(mode);
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    this._disconnectFromAgent();
    await this.abort();
    this._compactionAbortController = new AbortController();

    try {
      if (!this.model) {
        throw new Error('No model selected');
      }

      const apiKey = await this._modelRegistry.getApiKey(this.model);
      if (!apiKey) {
        throw new Error(`No API key for ${this.model.provider}`);
      }

      const pathEntries = this.sessionManager.getBranch();
      const settings = this.settingsManager.getCompactionSettings();

      const preparation = prepareCompaction(pathEntries, settings);
      if (!preparation) {
        const lastEntry = pathEntries[pathEntries.length - 1];
        if (lastEntry?.type === 'compaction') {
          throw new Error('Already compacted');
        }
        throw new Error('Nothing to compact (session too small)');
      }

      let extensionCompaction: CompactionResult | undefined;
      let fromExtension = false;

      if (this._extensionRunner?.hasHandlers('session_before_compact')) {
        const result = (await this._extensionRunner.emit({
          type: 'session_before_compact',
          preparation,
          branchEntries: pathEntries,
          customInstructions,
          signal: this._compactionAbortController.signal
        })) as SessionBeforeCompactResult | undefined;

        if (result?.cancel) {
          throw new Error('Compaction cancelled');
        }

        if (result?.compaction) {
          extensionCompaction = result.compaction;
          fromExtension = true;
        }
      }

      let summary: string;
      let firstKeptEntryId: string;
      let tokensBefore: number;
      let details: unknown;

      if (extensionCompaction) {
        summary = extensionCompaction.summary;
        firstKeptEntryId = extensionCompaction.firstKeptEntryId;
        tokensBefore = extensionCompaction.tokensBefore;
        details = extensionCompaction.details;
      } else {
        const result = await compact(preparation, this.model, apiKey, customInstructions, this._compactionAbortController.signal);
        summary = result.summary;
        firstKeptEntryId = result.firstKeptEntryId;
        tokensBefore = result.tokensBefore;
        details = result.details;
      }

      if (this._compactionAbortController.signal.aborted) {
        throw new Error('Compaction cancelled');
      }

      this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
      const newEntries = this.sessionManager.getEntries();
      const sessionContext = this.sessionManager.buildSessionContext();
      this.agent.replaceMessages(sessionContext.messages);

      const savedCompactionEntry = newEntries.find(e => e.type === 'compaction' && e.summary === summary) as CompactionEntry | undefined;

      if (this._extensionRunner && savedCompactionEntry) {
        await this._extensionRunner.emit({
          type: 'session_compact',
          compactionEntry: savedCompactionEntry,
          fromExtension
        });
      }

      return {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details
      };
    } finally {
      this._compactionAbortController = undefined;
      this._reconnectToAgent();
    }
  }

  abortCompaction(): void {
    this._compactionAbortController?.abort();
    this._autoCompactionAbortController?.abort();
  }

  abortBranchSummary(): void {
    this._branchSummaryAbortController?.abort();
  }

  private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
    const settings = this.settingsManager.getCompactionSettings();
    if (!settings.enabled) return;

    if (skipAbortedCheck && assistantMessage.stopReason === 'aborted') return;

    const contextWindow = this.model?.contextWindow ?? 0;

    const sameModel = this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

    const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
    const assistantIsFromBeforeCompaction = compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
    if (assistantIsFromBeforeCompaction) {
      return;
    }

    if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
      if (this._overflowRecoveryAttempted) {
        this._emit({
          type: 'auto_compaction_end',
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage:
            'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.'
        });
        return;
      }

      this._overflowRecoveryAttempted = true;

      const messages = this.agent.state.messages;
      if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        this.agent.replaceMessages(messages.slice(0, -1));
      }
      await this._runAutoCompaction('overflow', true);
      return;
    }

    let contextTokens: number;
    if (assistantMessage.stopReason === 'error') {
      const messages = this.agent.state.messages;
      const estimate = estimateContextTokens(messages);
      if (estimate.lastUsageIndex === null) return;

      const usageMsg = messages[estimate.lastUsageIndex];
      if (
        compactionEntry &&
        usageMsg.role === 'assistant' &&
        (usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
      ) {
        return;
      }
      contextTokens = estimate.tokens;
    } else {
      contextTokens = calculateContextTokens(assistantMessage.usage);
    }
    if (shouldCompact(contextTokens, contextWindow, settings)) {
      await this._runAutoCompaction('threshold', false);
    }
  }

  private async _runAutoCompaction(reason: 'overflow' | 'threshold', willRetry: boolean): Promise<void> {
    const settings = this.settingsManager.getCompactionSettings();

    this._emit({ type: 'auto_compaction_start', reason });
    this._autoCompactionAbortController = new AbortController();

    try {
      if (!this.model) {
        this._emit({ type: 'auto_compaction_end', result: undefined, aborted: false, willRetry: false });
        return;
      }

      const apiKey = await this._modelRegistry.getApiKey(this.model);
      if (!apiKey) {
        this._emit({ type: 'auto_compaction_end', result: undefined, aborted: false, willRetry: false });
        return;
      }

      const pathEntries = this.sessionManager.getBranch();

      const preparation = prepareCompaction(pathEntries, settings);
      if (!preparation) {
        this._emit({ type: 'auto_compaction_end', result: undefined, aborted: false, willRetry: false });
        return;
      }

      let extensionCompaction: CompactionResult | undefined;
      let fromExtension = false;

      if (this._extensionRunner?.hasHandlers('session_before_compact')) {
        const extensionResult = (await this._extensionRunner.emit({
          type: 'session_before_compact',
          preparation,
          branchEntries: pathEntries,
          customInstructions: undefined,
          signal: this._autoCompactionAbortController.signal
        })) as SessionBeforeCompactResult | undefined;

        if (extensionResult?.cancel) {
          this._emit({ type: 'auto_compaction_end', result: undefined, aborted: true, willRetry: false });
          return;
        }

        if (extensionResult?.compaction) {
          extensionCompaction = extensionResult.compaction;
          fromExtension = true;
        }
      }

      let summary: string;
      let firstKeptEntryId: string;
      let tokensBefore: number;
      let details: unknown;

      if (extensionCompaction) {
        summary = extensionCompaction.summary;
        firstKeptEntryId = extensionCompaction.firstKeptEntryId;
        tokensBefore = extensionCompaction.tokensBefore;
        details = extensionCompaction.details;
      } else {
        const compactResult = await compact(preparation, this.model, apiKey, undefined, this._autoCompactionAbortController.signal);
        summary = compactResult.summary;
        firstKeptEntryId = compactResult.firstKeptEntryId;
        tokensBefore = compactResult.tokensBefore;
        details = compactResult.details;
      }

      if (this._autoCompactionAbortController.signal.aborted) {
        this._emit({ type: 'auto_compaction_end', result: undefined, aborted: true, willRetry: false });
        return;
      }

      this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
      const newEntries = this.sessionManager.getEntries();
      const sessionContext = this.sessionManager.buildSessionContext();
      this.agent.replaceMessages(sessionContext.messages);

      const savedCompactionEntry = newEntries.find(e => e.type === 'compaction' && e.summary === summary) as CompactionEntry | undefined;

      if (this._extensionRunner && savedCompactionEntry) {
        await this._extensionRunner.emit({
          type: 'session_compact',
          compactionEntry: savedCompactionEntry,
          fromExtension
        });
      }

      const result: CompactionResult = {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details
      };
      this._emit({ type: 'auto_compaction_end', result, aborted: false, willRetry });

      if (willRetry) {
        const messages = this.agent.state.messages;
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'assistant' && (lastMsg as AssistantMessage).stopReason === 'error') {
          this.agent.replaceMessages(messages.slice(0, -1));
        }

        setTimeout(() => {
          this.agent.continue().catch(() => {});
        }, 100);
      } else if (this.agent.hasQueuedMessages()) {
        setTimeout(() => {
          this.agent.continue().catch(() => {});
        }, 100);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'compaction failed';
      this._emit({
        type: 'auto_compaction_end',
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: reason === 'overflow' ? `Context overflow recovery failed: ${errorMessage}` : `Auto-compaction failed: ${errorMessage}`
      });
    } finally {
      this._autoCompactionAbortController = undefined;
    }
  }

  setAutoCompactionEnabled(enabled: boolean): void {
    this.settingsManager.setCompactionEnabled(enabled);
  }

  get autoCompactionEnabled(): boolean {
    return this.settingsManager.getCompactionEnabled();
  }

  async bindExtensions(bindings: ExtensionBindings): Promise<void> {
    if (bindings.uiContext !== undefined) {
      this._extensionUIContext = bindings.uiContext;
    }
    if (bindings.commandContextActions !== undefined) {
      this._extensionCommandContextActions = bindings.commandContextActions;
    }
    if (bindings.shutdownHandler !== undefined) {
      this._extensionShutdownHandler = bindings.shutdownHandler;
    }
    if (bindings.onError !== undefined) {
      this._extensionErrorListener = bindings.onError;
    }

    if (this._extensionRunner) {
      this._applyExtensionBindings(this._extensionRunner);
      await this._extensionRunner.emit({ type: 'session_start' });
      await this.extendResourcesFromExtensions('startup');
    }
  }

  private async extendResourcesFromExtensions(reason: 'startup' | 'reload'): Promise<void> {
    if (!this._extensionRunner?.hasHandlers('resources_discover')) {
      return;
    }

    const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(this._cwd, reason);

    if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
      return;
    }

    const extensionPaths: ResourceExtensionPaths = {
      skillPaths: this.buildExtensionResourcePaths(skillPaths),
      promptPaths: this.buildExtensionResourcePaths(promptPaths),
      themePaths: this.buildExtensionResourcePaths(themePaths)
    };

    this._resourceLoader.extendResources(extensionPaths);
    this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
    this.agent.setSystemPrompt(this._baseSystemPrompt);
  }

  private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
    path: string;
    metadata: { source: string; scope: 'temporary'; origin: 'top-level'; baseDir?: string };
  }> {
    return entries.map(entry => {
      const source = this.getExtensionSourceLabel(entry.extensionPath);
      const baseDir = entry.extensionPath.startsWith('<') ? undefined : dirname(entry.extensionPath);
      return {
        path: entry.path,
        metadata: {
          source,
          scope: 'temporary',
          origin: 'top-level',
          baseDir
        }
      };
    });
  }

  private getExtensionSourceLabel(extensionPath: string): string {
    if (extensionPath.startsWith('<')) {
      return `extension:${extensionPath.replace(/[<>]/g, '')}`;
    }
    const base = basename(extensionPath);
    const name = base.replace(/\.(ts|js)$/, '');
    return `extension:${name}`;
  }

  private _applyExtensionBindings(runner: ExtensionRunner): void {
    runner.setUIContext(this._extensionUIContext);
    runner.bindCommandContext(this._extensionCommandContextActions);

    this._extensionErrorUnsubscriber?.();
    this._extensionErrorUnsubscriber = this._extensionErrorListener ? runner.onError(this._extensionErrorListener) : undefined;
  }

  private _refreshCurrentModelFromRegistry(): void {
    const currentModel = this.model;
    if (!currentModel) {
      return;
    }

    const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
    if (!refreshedModel || refreshedModel === currentModel) {
      return;
    }

    this.agent.setModel(refreshedModel);
  }

  private _bindExtensionCore(runner: ExtensionRunner): void {
    const normalizeLocation = (source: string): SlashCommandLocation | undefined => {
      if (source === 'user' || source === 'project' || source === 'path') {
        return source;
      }
      return undefined;
    };

    const reservedBuiltins = new Set(BUILTIN_SLASH_COMMANDS.map(command => command.name));

    const getCommands = (): SlashCommandInfo[] => {
      const extensionCommands: SlashCommandInfo[] = runner
        .getRegisteredCommandsWithPaths()
        .filter(({ command }) => !reservedBuiltins.has(command.name))
        .map(({ command, extensionPath }) => ({
          name: command.name,
          description: command.description,
          source: 'extension',
          path: extensionPath
        }));

      const templates: SlashCommandInfo[] = this.promptTemplates.map(template => ({
        name: template.name,
        description: template.description,
        source: 'prompt',
        location: normalizeLocation(template.source),
        path: template.filePath
      }));

      const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map(skill => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: 'skill',
        location: normalizeLocation(skill.source),
        path: skill.filePath
      }));

      return [...extensionCommands, ...templates, ...skills];
    };

    runner.bindCore(
      {
        sendMessage: (message, options) => {
          this.sendCustomMessage(message, options).catch(err => {
            runner.emitError({
              extensionPath: '<runtime>',
              event: 'send_message',
              error: err instanceof Error ? err.message : String(err)
            });
          });
        },
        sendUserMessage: (content, options) => {
          this.sendUserMessage(content, options).catch(err => {
            runner.emitError({
              extensionPath: '<runtime>',
              event: 'send_user_message',
              error: err instanceof Error ? err.message : String(err)
            });
          });
        },
        appendEntry: (customType, data) => {
          this.sessionManager.appendCustomEntry(customType, data);
        },
        setSessionName: name => {
          this.sessionManager.appendSessionInfo(name);
        },
        getSessionName: () => {
          return this.sessionManager.getSessionName();
        },
        setLabel: (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
        },
        getActiveTools: () => this.getActiveToolNames(),
        getAllTools: () => this.getAllTools(),
        setActiveTools: toolNames => this.setActiveToolsByName(toolNames),
        refreshTools: () => this._refreshToolRegistry(),
        getCommands,
        setModel: async model => {
          const key = await this.modelRegistry.getApiKey(model);
          if (!key) return false;
          await this.setModel(model);
          return true;
        },
        getThinkingLevel: () => this.thinkingLevel,
        setThinkingLevel: level => this.setThinkingLevel(level)
      },
      {
        getModel: () => this.model,
        isIdle: () => !this.isStreaming,
        abort: () => this.abort(),
        hasPendingMessages: () => this.pendingMessageCount > 0,
        shutdown: () => {
          this._extensionShutdownHandler?.();
        },
        getContextUsage: () => this.getContextUsage(),
        compact: options => {
          void (async () => {
            try {
              const result = await this.compact(options?.customInstructions);
              options?.onComplete?.(result);
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              options?.onError?.(err);
            }
          })();
        },
        getSystemPrompt: () => this.systemPrompt
      },
      {
        registerProvider: (name, config) => {
          this._modelRegistry.registerProvider(name, config);
          this._refreshCurrentModelFromRegistry();
        },
        unregisterProvider: name => {
          this._modelRegistry.unregisterProvider(name);
          this._refreshCurrentModelFromRegistry();
        }
      }
    );
  }

  private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
    const previousRegistryNames = new Set(this._toolRegistry.keys());
    const previousActiveToolNames = this.getActiveToolNames();

    const registeredTools = this._extensionRunner?.getAllRegisteredTools() ?? [];
    const allCustomTools = [...registeredTools, ...this._customTools.map(def => ({ definition: def, extensionPath: '<sdk>' }))];
    this._toolPromptSnippets = new Map(
      allCustomTools
        .map(registeredTool => {
          const snippet = this._normalizePromptSnippet(registeredTool.definition.promptSnippet);
          return snippet ? ([registeredTool.definition.name, snippet] as const) : undefined;
        })
        .filter((entry): entry is readonly [string, string] => entry !== undefined)
    );
    this._toolPromptGuidelines = new Map(
      allCustomTools
        .map(registeredTool => {
          const guidelines = this._normalizePromptGuidelines(registeredTool.definition.promptGuidelines);
          return guidelines.length > 0 ? ([registeredTool.definition.name, guidelines] as const) : undefined;
        })
        .filter((entry): entry is readonly [string, string[]] => entry !== undefined)
    );
    const wrappedExtensionTools = this._extensionRunner ? wrapRegisteredTools(allCustomTools, this._extensionRunner) : [];

    const toolRegistry = new Map(this._baseToolRegistry);
    for (const tool of wrappedExtensionTools as AgentTool[]) {
      toolRegistry.set(tool.name, tool);
    }
    this._toolRegistry = toolRegistry;

    const nextActiveToolNames = options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames];

    if (options?.includeAllExtensionTools) {
      for (const tool of wrappedExtensionTools) {
        nextActiveToolNames.push(tool.name);
      }
    } else if (!options?.activeToolNames) {
      for (const toolName of this._toolRegistry.keys()) {
        if (!previousRegistryNames.has(toolName)) {
          nextActiveToolNames.push(toolName);
        }
      }
    }

    this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
  }

  private _buildRuntime(options: {
    activeToolNames?: string[];
    flagValues?: Map<string, boolean | string>;
    includeAllExtensionTools?: boolean;
  }): void {
    const autoResizeImages = this.settingsManager.getImageAutoResize();
    const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
    const baseTools = this._baseToolsOverride
      ? this._baseToolsOverride
      : createAllTools(this._cwd, {
          read: { autoResizeImages },
          bash: { commandPrefix: shellCommandPrefix }
        });

    this._baseToolRegistry = new Map(Object.entries(baseTools).map(([name, tool]) => [name, tool as AgentTool]));

    const extensionsResult = this._resourceLoader.getExtensions();
    if (options.flagValues) {
      for (const [name, value] of options.flagValues) {
        extensionsResult.runtime.flagValues.set(name, value);
      }
    }

    const hasExtensions = extensionsResult.extensions.length > 0;
    const hasCustomTools = this._customTools.length > 0;
    this._extensionRunner =
      hasExtensions || hasCustomTools
        ? new ExtensionRunner(extensionsResult.extensions, extensionsResult.runtime, this._cwd, this.sessionManager, this._modelRegistry)
        : undefined;
    if (this._extensionRunnerRef) {
      this._extensionRunnerRef.current = this._extensionRunner;
    }
    if (this._extensionRunner) {
      this._bindExtensionCore(this._extensionRunner);
      this._applyExtensionBindings(this._extensionRunner);
    }

    const defaultActiveToolNames = this._baseToolsOverride ? Object.keys(this._baseToolsOverride) : ['read', 'bash', 'edit', 'write'];
    const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
    this._refreshToolRegistry({
      activeToolNames: baseActiveToolNames,
      includeAllExtensionTools: options.includeAllExtensionTools
    });
  }

  async reload(): Promise<void> {
    const previousFlagValues = this._extensionRunner?.getFlagValues();
    await this._extensionRunner?.emit({ type: 'session_shutdown' });
    this.settingsManager.reload();
    resetApiProviders();
    await this._resourceLoader.reload();
    this._buildRuntime({
      activeToolNames: this.getActiveToolNames(),
      flagValues: previousFlagValues,
      includeAllExtensionTools: true
    });

    const hasBindings =
      this._extensionUIContext || this._extensionCommandContextActions || this._extensionShutdownHandler || this._extensionErrorListener;
    if (this._extensionRunner && hasBindings) {
      await this._extensionRunner.emit({ type: 'session_start' });
      await this.extendResourcesFromExtensions('reload');
    }
  }

  private _isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== 'error' || !message.errorMessage) return false;

    const contextWindow = this.model?.contextWindow ?? 0;
    if (isContextOverflow(message, contextWindow)) return false;

    const err = message.errorMessage;

    return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay/i.test(
      err
    );
  }

  private async _handleRetryableError(message: AssistantMessage): Promise<boolean> {
    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled) {
      this._resolveRetry();
      return false;
    }

    if (!this._retryPromise) {
      this._retryPromise = new Promise(resolve => {
        this._retryResolve = resolve;
      });
    }

    this._retryAttempt++;

    if (this._retryAttempt > settings.maxRetries) {
      this._emit({
        type: 'auto_retry_end',
        success: false,
        attempt: this._retryAttempt - 1,
        finalError: message.errorMessage
      });
      this._retryAttempt = 0;
      this._resolveRetry();
      return false;
    }

    const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

    this._emit({
      type: 'auto_retry_start',
      attempt: this._retryAttempt,
      maxAttempts: settings.maxRetries,
      delayMs,
      errorMessage: message.errorMessage || 'Unknown error'
    });

    const messages = this.agent.state.messages;
    if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
      this.agent.replaceMessages(messages.slice(0, -1));
    }

    this._retryAbortController = new AbortController();
    try {
      await sleep(delayMs, this._retryAbortController.signal);
    } catch {
      const attempt = this._retryAttempt;
      this._retryAttempt = 0;
      this._retryAbortController = undefined;
      this._emit({
        type: 'auto_retry_end',
        success: false,
        attempt,
        finalError: 'Retry cancelled'
      });
      this._resolveRetry();
      return false;
    }
    this._retryAbortController = undefined;

    setTimeout(() => {
      this.agent.continue().catch(() => {});
    }, 0);

    return true;
  }

  abortRetry(): void {
    this._retryAbortController?.abort();

    this._resolveRetry();
  }

  private async waitForRetry(): Promise<void> {
    if (this._retryPromise) {
      await this._retryPromise;
    }
  }

  get isRetrying(): boolean {
    return this._retryPromise !== undefined;
  }

  get autoRetryEnabled(): boolean {
    return this.settingsManager.getRetryEnabled();
  }

  setAutoRetryEnabled(enabled: boolean): void {
    this.settingsManager.setRetryEnabled(enabled);
  }

  async executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean; operations?: BashOperations }
  ): Promise<BashResult> {
    this._bashAbortController = new AbortController();

    const prefix = this.settingsManager.getShellCommandPrefix();
    const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

    try {
      const result = options?.operations
        ? await executeBashWithOperations(resolvedCommand, process.cwd(), options.operations, {
            onChunk,
            signal: this._bashAbortController.signal
          })
        : await executeBashCommand(resolvedCommand, {
            onChunk,
            signal: this._bashAbortController.signal
          });

      this.recordBashResult(command, result, options);
      return result;
    } finally {
      this._bashAbortController = undefined;
    }
  }

  recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
    const bashMessage: BashExecutionMessage = {
      role: 'bashExecution',
      command,
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      fullOutputPath: result.fullOutputPath,
      timestamp: Date.now(),
      excludeFromContext: options?.excludeFromContext
    };

    if (this.isStreaming) {
      this._pendingBashMessages.push(bashMessage);
    } else {
      this.agent.appendMessage(bashMessage);

      this.sessionManager.appendMessage(bashMessage);
    }
  }

  abortBash(): void {
    this._bashAbortController?.abort();
  }

  get isBashRunning(): boolean {
    return this._bashAbortController !== undefined;
  }

  get hasPendingBashMessages(): boolean {
    return this._pendingBashMessages.length > 0;
  }

  private _flushPendingBashMessages(): void {
    if (this._pendingBashMessages.length === 0) return;

    for (const bashMessage of this._pendingBashMessages) {
      this.agent.appendMessage(bashMessage);

      this.sessionManager.appendMessage(bashMessage);
    }

    this._pendingBashMessages = [];
  }

  async switchSession(sessionPath: string): Promise<boolean> {
    const previousSessionFile = this.sessionManager.getSessionFile();

    if (this._extensionRunner?.hasHandlers('session_before_switch')) {
      const result = (await this._extensionRunner.emit({
        type: 'session_before_switch',
        reason: 'resume',
        targetSessionFile: sessionPath
      })) as SessionBeforeSwitchResult | undefined;

      if (result?.cancel) {
        return false;
      }
    }

    this._disconnectFromAgent();
    await this.abort();
    this._steeringMessages = [];
    this._followUpMessages = [];
    this._pendingNextTurnMessages = [];

    this.sessionManager.setSessionFile(sessionPath);
    this.agent.sessionId = this.sessionManager.getSessionId();

    const sessionContext = this.sessionManager.buildSessionContext();

    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        type: 'session_switch',
        reason: 'resume',
        previousSessionFile
      });
    }

    this.agent.replaceMessages(sessionContext.messages);

    if (sessionContext.model) {
      const previousModel = this.model;
      const availableModels = await this._modelRegistry.getAvailable();
      const match = availableModels.find(m => m.provider === sessionContext.model!.provider && m.id === sessionContext.model!.modelId);
      if (match) {
        this.agent.setModel(match);
        await this._emitModelSelect(match, previousModel, 'restore');
      }
    }

    const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === 'thinking_level_change');
    const defaultThinkingLevel = this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;

    if (hasThinkingEntry) {
      this.setThinkingLevel(sessionContext.thinkingLevel as ThinkingLevel);
    } else {
      const availableLevels = this.getAvailableThinkingLevels();
      const effectiveLevel = availableLevels.includes(defaultThinkingLevel)
        ? defaultThinkingLevel
        : this._clampThinkingLevel(defaultThinkingLevel, availableLevels);
      this.agent.setThinkingLevel(effectiveLevel);
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
    }

    this._reconnectToAgent();
    return true;
  }

  setSessionName(name: string): void {
    this.sessionManager.appendSessionInfo(name);
  }

  async fork(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
    const previousSessionFile = this.sessionFile;
    const selectedEntry = this.sessionManager.getEntry(entryId);

    if (!selectedEntry || selectedEntry.type !== 'message' || selectedEntry.message.role !== 'user') {
      throw new Error('Invalid entry ID for forking');
    }

    const selectedText = this._extractUserMessageText(selectedEntry.message.content);

    let skipConversationRestore = false;

    if (this._extensionRunner?.hasHandlers('session_before_fork')) {
      const result = (await this._extensionRunner.emit({
        type: 'session_before_fork',
        entryId
      })) as SessionBeforeForkResult | undefined;

      if (result?.cancel) {
        return { selectedText, cancelled: true };
      }
      skipConversationRestore = result?.skipConversationRestore ?? false;
    }

    this._pendingNextTurnMessages = [];

    if (!selectedEntry.parentId) {
      this.sessionManager.newSession({ parentSession: previousSessionFile });
    } else {
      this.sessionManager.createBranchedSession(selectedEntry.parentId);
    }
    this.agent.sessionId = this.sessionManager.getSessionId();

    const sessionContext = this.sessionManager.buildSessionContext();

    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        type: 'session_fork',
        previousSessionFile
      });
    }

    if (!skipConversationRestore) {
      this.agent.replaceMessages(sessionContext.messages);
    }

    return { selectedText, cancelled: false };
  }

  async navigateTree(
    targetId: string,
    options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {}
  ): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
    const oldLeafId = this.sessionManager.getLeafId();

    if (targetId === oldLeafId) {
      return { cancelled: false };
    }

    if (options.summarize && !this.model) {
      throw new Error('No model available for summarization');
    }

    const targetEntry = this.sessionManager.getEntry(targetId);
    if (!targetEntry) {
      throw new Error(`Entry ${targetId} not found`);
    }

    const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(this.sessionManager, oldLeafId, targetId);

    let customInstructions = options.customInstructions;
    let replaceInstructions = options.replaceInstructions;
    let label = options.label;

    const preparation: TreePreparation = {
      targetId,
      oldLeafId,
      commonAncestorId,
      entriesToSummarize,
      userWantsSummary: options.summarize ?? false,
      customInstructions,
      replaceInstructions,
      label
    };

    this._branchSummaryAbortController = new AbortController();
    let extensionSummary: { summary: string; details?: unknown } | undefined;
    let fromExtension = false;

    if (this._extensionRunner?.hasHandlers('session_before_tree')) {
      const result = (await this._extensionRunner.emit({
        type: 'session_before_tree',
        preparation,
        signal: this._branchSummaryAbortController.signal
      })) as SessionBeforeTreeResult | undefined;

      if (result?.cancel) {
        return { cancelled: true };
      }

      if (result?.summary && options.summarize) {
        extensionSummary = result.summary;
        fromExtension = true;
      }

      if (result?.customInstructions !== undefined) {
        customInstructions = result.customInstructions;
      }
      if (result?.replaceInstructions !== undefined) {
        replaceInstructions = result.replaceInstructions;
      }
      if (result?.label !== undefined) {
        label = result.label;
      }
    }

    let summaryText: string | undefined;
    let summaryDetails: unknown;
    if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
      const model = this.model!;
      const apiKey = await this._modelRegistry.getApiKey(model);
      if (!apiKey) {
        throw new Error(`No API key for ${model.provider}`);
      }
      const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
      const result = await generateBranchSummary(entriesToSummarize, {
        model,
        apiKey,
        signal: this._branchSummaryAbortController.signal,
        customInstructions,
        replaceInstructions,
        reserveTokens: branchSummarySettings.reserveTokens
      });
      this._branchSummaryAbortController = undefined;
      if (result.aborted) {
        return { cancelled: true, aborted: true };
      }
      if (result.error) {
        throw new Error(result.error);
      }
      summaryText = result.summary;
      summaryDetails = {
        readFiles: result.readFiles || [],
        modifiedFiles: result.modifiedFiles || []
      };
    } else if (extensionSummary) {
      summaryText = extensionSummary.summary;
      summaryDetails = extensionSummary.details;
    }

    let newLeafId: string | null;
    let editorText: string | undefined;

    if (targetEntry.type === 'message' && targetEntry.message.role === 'user') {
      newLeafId = targetEntry.parentId;
      editorText = this._extractUserMessageText(targetEntry.message.content);
    } else if (targetEntry.type === 'custom_message') {
      newLeafId = targetEntry.parentId;
      editorText =
        typeof targetEntry.content === 'string'
          ? targetEntry.content
          : targetEntry.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map(c => c.text)
              .join('');
    } else {
      newLeafId = targetId;
    }

    let summaryEntry: BranchSummaryEntry | undefined;
    if (summaryText) {
      const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
      summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

      if (label) {
        this.sessionManager.appendLabelChange(summaryId, label);
      }
    } else if (newLeafId === null) {
      this.sessionManager.resetLeaf();
    } else {
      this.sessionManager.branch(newLeafId);
    }

    if (label && !summaryText) {
      this.sessionManager.appendLabelChange(targetId, label);
    }

    const sessionContext = this.sessionManager.buildSessionContext();
    this.agent.replaceMessages(sessionContext.messages);

    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        type: 'session_tree',
        newLeafId: this.sessionManager.getLeafId(),
        oldLeafId,
        summaryEntry,
        fromExtension: summaryText ? fromExtension : undefined
      });
    }

    this._branchSummaryAbortController = undefined;
    return { editorText, cancelled: false, summaryEntry };
  }

  getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
    const entries = this.sessionManager.getEntries();
    const result: Array<{ entryId: string; text: string }> = [];

    for (const entry of entries) {
      if (entry.type !== 'message') continue;
      if (entry.message.role !== 'user') continue;

      const text = this._extractUserMessageText(entry.message.content);
      if (text) {
        result.push({ entryId: entry.id, text });
      }
    }

    return result;
  }

  private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text)
        .join('');
    }
    return '';
  }

  getSessionStats(): SessionStats {
    const state = this.state;
    const userMessages = state.messages.filter(m => m.role === 'user').length;
    const assistantMessages = state.messages.filter(m => m.role === 'assistant').length;
    const toolResults = state.messages.filter(m => m.role === 'toolResult').length;

    let toolCalls = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

    for (const message of state.messages) {
      if (message.role === 'assistant') {
        const assistantMsg = message as AssistantMessage;
        toolCalls += assistantMsg.content.filter(c => c.type === 'toolCall').length;
        totalInput += assistantMsg.usage.input;
        totalOutput += assistantMsg.usage.output;
        totalCacheRead += assistantMsg.usage.cacheRead;
        totalCacheWrite += assistantMsg.usage.cacheWrite;
        totalCost += assistantMsg.usage.cost.total;
      }
    }

    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: state.messages.length,
      tokens: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        total: totalInput + totalOutput + totalCacheRead + totalCacheWrite
      },
      cost: totalCost
    };
  }

  getContextUsage(): ContextUsage | undefined {
    const model = this.model;
    if (!model) return undefined;

    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) return undefined;

    const branchEntries = this.sessionManager.getBranch();
    const latestCompaction = getLatestCompactionEntry(branchEntries);

    if (latestCompaction) {
      const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
      let hasPostCompactionUsage = false;
      for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
        const entry = branchEntries[i];
        if (entry.type === 'message' && entry.message.role === 'assistant') {
          const assistant = entry.message;
          if (assistant.stopReason !== 'aborted' && assistant.stopReason !== 'error') {
            const contextTokens = calculateContextTokens(assistant.usage);
            if (contextTokens > 0) {
              hasPostCompactionUsage = true;
            }
            break;
          }
        }
      }

      if (!hasPostCompactionUsage) {
        return { tokens: null, contextWindow, percent: null };
      }
    }

    const estimate = estimateContextTokens(this.messages);
    const percent = (estimate.tokens / contextWindow) * 100;

    return {
      tokens: estimate.tokens,
      contextWindow,
      percent
    };
  }

  getLastAssistantText(): string | undefined {
    const lastAssistant = this.messages
      .slice()
      .reverse()
      .find(m => {
        if (m.role !== 'assistant') return false;
        const msg = m as AssistantMessage;

        if (msg.stopReason === 'aborted' && msg.content.length === 0) return false;
        return true;
      });

    if (!lastAssistant) return undefined;

    let text = '';
    for (const content of (lastAssistant as AssistantMessage).content) {
      if (content.type === 'text') {
        text += content.text;
      }
    }

    return text.trim() || undefined;
  }

  hasExtensionHandlers(eventType: string): boolean {
    return this._extensionRunner?.hasHandlers(eventType) ?? false;
  }

  get extensionRunner(): ExtensionRunner | undefined {
    return this._extensionRunner;
  }
}
