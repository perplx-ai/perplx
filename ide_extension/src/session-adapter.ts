/**
 * Adapter that wraps the shared tool runtime (createAgentSession, AuthStorage,
 * ModelRegistry, etc.) for use inside the VS Code extension host.
 *
 * Key differences from the CLI entrypoint:
 *  - No process.exit() calls – errors are thrown or returned.
 *  - cwd is passed explicitly (workspace root), not process.cwd().
 *  - No terminal-UI dependencies (ink, blessed, etc.).
 */

import { join } from 'node:path';
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  AgentSession,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  DefaultResourceLoader,
  getAgentDir,
  registerPerplexityProvider,
} from 'perplx-tool';

export interface SessionAdapterOptions {
  /** Explicit workspace root – never falls back to process.cwd() */
  cwd: string;
}

/**
 * Holds all the long-lived singletons that the extension needs.
 * Cheap to construct; the expensive work happens in `createSession`.
 */
export class SessionAdapter {
  private readonly _cwd: string;
  private readonly _agentDir: string;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly settingsManager: SettingsManager;
  private _currentSession: AgentSession | undefined;
  private _resourceLoader: DefaultResourceLoader | undefined;

  constructor(opts: SessionAdapterOptions) {
    this._cwd = opts.cwd;
    this._agentDir = getAgentDir();
    this.authStorage = AuthStorage.create();
    this.modelRegistry = new ModelRegistry(this.authStorage, join(this._agentDir, 'models.json'));

    // Register perplexity as a built-in provider
    registerPerplexityProvider(this.modelRegistry);

    this.settingsManager = SettingsManager.create(this._cwd, this._agentDir);
  }

  get cwd(): string {
    return this._cwd;
  }

  get currentSession(): AgentSession | undefined {
    return this._currentSession;
  }

  /**
   * Create (or recreate) an agent session using the shared runtime.
   * This is the extension-side equivalent of what `main()` does in the CLI.
   */
  async createSession(
    overrides?: Partial<CreateAgentSessionOptions>,
  ): Promise<CreateAgentSessionResult> {
    // Dispose previous session
    this._currentSession?.dispose();

    // Resource loader
    if (!this._resourceLoader) {
      this._resourceLoader = new DefaultResourceLoader({
        cwd: this._cwd,
        agentDir: this._agentDir,
        settingsManager: this.settingsManager,
      });
      await this._resourceLoader.reload();
    }

    const options: CreateAgentSessionOptions = {
      cwd: this._cwd,
      agentDir: this._agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      resourceLoader: this._resourceLoader,
      ...overrides,
    };

    const result = await createAgentSession(options);
    this._currentSession = result.session;
    return result;
  }

  /** Tear everything down cleanly (extension deactivate). */
  async dispose(): Promise<void> {
    if (this._currentSession) {
      await this._currentSession.abort();
      this._currentSession.dispose();
      this._currentSession = undefined;
    }
  }

  /** Get all models that have valid auth */
  async getAvailableModels() {
    return this.modelRegistry.getAvailable();
  }

  /**
   * Store an API key for a provider through the shared auth system.
   * The AuthStorage already handles encrypted file storage.
   */
  setApiKey(provider: string, apiKey: string): void {
    this.authStorage.set(provider, { type: 'api_key', key: apiKey });
  }
}
