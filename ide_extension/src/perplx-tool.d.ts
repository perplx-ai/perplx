/**
 * Ambient type declarations for the 'perplx-tool' module.
 *
 * At build time, esbuild resolves 'perplx-tool' → ../tool/src/index.ts
 * and bundles everything. This file only exists so that `tsc --noEmit`
 * can type-check the extension source without traversing the tool tree.
 */
declare module 'perplx-tool' {
  // ---- Config ----
  export function getAgentDir(): string;
  export const VERSION: string;
  export const DEFAULT_THINKING_LEVEL: string;
  export const DEFAULT_PERPLEXITY_MODEL: string;

  // ---- Providers ----
  export function registerPerplexityProvider(registry: ModelRegistry): void;
  export function createWebSearchTool(registry: ModelRegistry): ToolDefinition;

  // ---- Auth ----
  export class AuthStorage {
    static create(authPath?: string): AuthStorage;
    set(provider: string, credential: { type: 'api_key'; key: string }): void;
    get(provider: string): any;
    getApiKey(provider: string): Promise<string | undefined>;
    hasAuth(provider: string): boolean;
    setFallbackResolver(resolver: (provider: string) => string | undefined): void;
  }

  // ---- Model Registry ----
  export class ModelRegistry {
    constructor(authStorage: AuthStorage, modelsJsonPath?: string);
    getAll(): any[];
    getAvailable(): any[];
    find(provider: string, modelId: string): any | undefined;
    getApiKey(model: any): Promise<string | undefined>;
    getApiKeyForProvider(provider: string): Promise<string | undefined>;
    isUsingOAuth(model: any): boolean;
    registerProvider(name: string, config: any): void;
    unregisterProvider(name: string): void;
    refresh(): void;
  }

  // ---- Settings ----
  export class SettingsManager {
    static create(cwd: string, agentDir: string): SettingsManager;
    getDefaultProvider(): string | undefined;
    getDefaultModel(): string | undefined;
    getDefaultThinkingLevel(): string | undefined;
    getImageAutoResize(): boolean;
    getTheme(): string | undefined;
    reload(): void;
    [key: string]: any;
  }

  // ---- Session Manager ----
  export interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    name?: string;
    parentSessionPath?: string;
    created: Date;
    modified: Date;
    messageCount: number;
    firstMessage: string;
    allMessagesText: string;
  }

  export class SessionManager {
    static create(cwd: string, sessionDir: string): SessionManager;
    static continueRecent(cwd: string): SessionManager | undefined;
    static open(sessionPath: string): SessionManager;
    static list(cwd: string, sessionDir?: string, onProgress?: any): Promise<SessionInfo[]>;
    static listAll(onProgress?: any): Promise<SessionInfo[]>;
    getSessionFile(): string | undefined;
    getSessionId(): string;
    getSessionName(): string | undefined;
    buildSessionContext(): any;
    getBranch(): any[];
    getEntries(): any[];
    getEntry(id: string): any;
    newSession(options?: any): void;
    [key: string]: any;
  }

  // ---- Resource Loader ----
  export class DefaultResourceLoader {
    constructor(options: {
      cwd: string;
      agentDir: string;
      settingsManager: SettingsManager;
      additionalSkillPaths?: string[];
      additionalPromptTemplatePaths?: string[];
      additionalThemePaths?: string[];
      noSkills?: boolean;
      noPromptTemplates?: boolean;
      noThemes?: boolean;
    });
    reload(): Promise<void>;
    [key: string]: any;
  }

  // ---- Agent Session ----
  export type AgentSessionEvent = {
    type: string;
    [key: string]: any;
  };

  export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

  export class AgentSession {
    get model(): { provider: string; id: string; name?: string; contextWindow?: number; [key: string]: any } | undefined;
    get thinkingLevel(): string;
    get isStreaming(): boolean;
    get sessionId(): string;
    get sessionFile(): string | undefined;
    get sessionName(): string | undefined;
    get messages(): any[];

    prompt(text: string, options?: any): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
    newSession(options?: any): Promise<boolean>;
    switchSession(sessionPath: string): Promise<boolean>;
    setModel(model: any): Promise<void>;
    cycleModel(direction?: 'forward' | 'backward'): Promise<{ model: any; thinkingLevel: string; isScoped: boolean } | undefined>;
    setThinkingLevel(level: string): void;
    compact(customInstructions?: string): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown }>;
    subscribe(listener: AgentSessionEventListener): () => void;
    bindExtensions(bindings: any): Promise<void>;
    [key: string]: any;
  }

  // ---- SDK ----
  export interface CreateAgentSessionOptions {
    cwd?: string;
    agentDir?: string;
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    model?: any;
    thinkingLevel?: string;
    scopedModels?: any[];
    tools?: any[];
    customTools?: ToolDefinition[];
    resourceLoader?: any;
    sessionManager?: SessionManager;
    settingsManager?: SettingsManager;
  }

  export interface CreateAgentSessionResult {
    session: AgentSession;
    modelFallbackMessage?: string;
  }

  export function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;

  // ---- Tools ----
  export interface ToolDefinition {
    name: string;
    description: string;
    parameters?: any;
    promptSnippet?: string;
    promptGuidelines?: string[];
    [key: string]: any;
  }
}
