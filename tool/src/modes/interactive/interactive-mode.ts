import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ImageContent, Message, Model } from '@mariozechner/pi-ai';
import type {
  AutocompleteItem,
  EditorComponent,
  EditorTheme,
  Keybinding,
  KeyId,
  MarkdownTheme,
  OverlayHandle,
  OverlayOptions,
  SlashCommand
} from '@mariozechner/pi-tui';
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  fuzzyFilter,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  setKeybindings,
  Text,
  TruncatedText,
  TUI,
  visibleWidth
} from '@mariozechner/pi-tui';
import { spawn, spawnSync } from 'child_process';
import { APP_NAME, getAgentDir, getAuthPath, getDebugLogPath, getShareViewerUrl, VERSION } from '../../config.js';
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from '../../core/agent-session.js';
import type { CompactionResult } from '../../core/compaction/index.js';
import type {
  ExtensionContext,
  ExtensionRunner,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions
} from '../../core/extensions/index.js';
import { FooterDataProvider, type ReadonlyFooterDataProvider } from '../../core/footer-data-provider.js';
import { type AppKeybinding, KeybindingsManager } from '../../core/keybindings.js';
import { createCompactionSummaryMessage } from '../../core/messages.js';
import { findExactModelReferenceMatch, resolveModelScope } from '../../core/model-resolver.js';
import { DefaultPackageManager } from '../../core/package-manager.js';
import type { ResourceDiagnostic } from '../../core/resource-loader.js';
import { type SessionContext, SessionManager } from '../../core/session-manager.js';
import { BUILTIN_SLASH_COMMANDS } from '../../core/slash-commands.js';
import type { TruncationResult } from '../../core/tools/truncate.js';
import { copyToClipboard } from '../../utils/clipboard.js';
import { extensionForImageMimeType, readClipboardImage } from '../../utils/clipboard-image.js';
import { ensureTool } from '../../utils/tools-manager.js';
import { ArminComponent } from './components/armin.js';
import { AssistantMessageComponent } from './components/assistant-message.js';
import { BashExecutionComponent } from './components/bash-execution.js';
import { BorderedLoader } from './components/bordered-loader.js';
import { BranchSummaryMessageComponent } from './components/branch-summary-message.js';
import { CompactionSummaryMessageComponent } from './components/compaction-summary-message.js';
import { CustomEditor } from './components/custom-editor.js';
import { CustomMessageComponent } from './components/custom-message.js';

import { DynamicBorder } from './components/dynamic-border.js';
import { FooterComponent } from './components/footer.js';
import { keyHint, keyText, rawKeyHint } from './components/keybinding-hints.js';
import { ModelSelectorComponent } from './components/model-selector.js';
import { SessionSelectorComponent } from './components/session-selector.js';
import { SettingsSelectorComponent } from './components/settings-selector.js';
import { SkillInvocationMessageComponent } from './components/skill-invocation-message.js';
import { ToolExecutionComponent } from './components/tool-execution.js';
import { TreeSelectorComponent } from './components/tree-selector.js';
import { UserMessageComponent } from './components/user-message.js';
import { UserMessageSelectorComponent } from './components/user-message-selector.js';
import {
  getAvailableThemes,
  getAvailableThemesWithPaths,
  getEditorTheme,
  getMarkdownTheme,
  getThemeByName,
  initTheme,
  onThemeChange,
  setRegisteredThemes,
  setTheme,
  setThemeInstance,
  Theme,
  type ThemeColor,
  theme
} from './theme/theme.js';

interface Expandable {
  setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
  return typeof obj === 'object' && obj !== null && 'setExpanded' in obj && typeof obj.setExpanded === 'function';
}

type CompactionQueuedMessage = {
  text: string;
  mode: 'steer' | 'followUp';
};

export interface InteractiveModeOptions {
  modelFallbackMessage?: string;

  initialMessage?: string;

  initialImages?: ImageContent[];

  initialMessages?: string[];

  verbose?: boolean;
}

export class InteractiveMode {
  private session: AgentSession;
  private ui: TUI;
  private chatContainer: Container;
  private pendingMessagesContainer: Container;
  private statusContainer: Container;
  private defaultEditor: CustomEditor;
  private editor: EditorComponent;
  private autocompleteProvider: CombinedAutocompleteProvider | undefined;
  private fdPath: string | undefined;
  private editorContainer: Container;
  private footer: FooterComponent;
  private footerDataProvider: FooterDataProvider;

  private keybindings: KeybindingsManager;
  private version: string;
  private isInitialized = false;
  private onInputCallback?: (text: string) => void;
  private loadingAnimation: Loader | undefined = undefined;
  private pendingWorkingMessage: string | undefined = undefined;
  private readonly defaultWorkingMessage = 'Thinking...';

  private lastSigintTime = 0;
  private lastEscapeTime = 0;

  private lastStatusSpacer: Spacer | undefined = undefined;
  private lastStatusText: Text | undefined = undefined;

  private streamingComponent: AssistantMessageComponent | undefined = undefined;
  private streamingMessage: AssistantMessage | undefined = undefined;

  private pendingTools = new Map<string, ToolExecutionComponent>();

  private toolOutputExpanded = false;

  private hideThinkingBlock = false;

  private skillCommands = new Map<string, string>();

  private unsubscribe?: () => void;

  private isBashMode = false;

  private bashComponent: BashExecutionComponent | undefined = undefined;

  private pendingBashComponents: BashExecutionComponent[] = [];

  private autoCompactionLoader: Loader | undefined = undefined;
  private autoCompactionEscapeHandler?: () => void;

  private retryLoader: Loader | undefined = undefined;
  private retryEscapeHandler?: () => void;

  private compactionQueuedMessages: CompactionQueuedMessage[] = [];

  private shutdownRequested = false;

  private extensionTerminalInputUnsubscribers = new Set<() => void>();

  private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
  private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
  private widgetContainerAbove!: Container;
  private widgetContainerBelow!: Container;

  private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

  private headerContainer: Container;

  private builtInHeader: Component | undefined = undefined;

  private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

  private get agent() {
    return this.session.agent;
  }
  private get sessionManager() {
    return this.session.sessionManager;
  }
  private get settingsManager() {
    return this.session.settingsManager;
  }

  constructor(
    session: AgentSession,
    private options: InteractiveModeOptions = {}
  ) {
    this.session = session;
    this.version = VERSION;
    this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
    this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
    this.headerContainer = new Container();
    this.chatContainer = new Container();
    this.pendingMessagesContainer = new Container();
    this.statusContainer = new Container();
    this.widgetContainerAbove = new Container();
    this.widgetContainerBelow = new Container();
    this.keybindings = KeybindingsManager.create();
    setKeybindings(this.keybindings);
    const editorPaddingX = this.settingsManager.getEditorPaddingX();
    const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
    this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
      paddingX: editorPaddingX,
      autocompleteMaxVisible
    });
    this.editor = this.defaultEditor;
    this.editorContainer = new Container();
    this.editorContainer.addChild(this.editor as Component);
    this.footerDataProvider = new FooterDataProvider();
    this.footer = new FooterComponent(session, this.footerDataProvider);
    this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);

    this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

    setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
    initTheme(this.settingsManager.getTheme(), true);
  }

  private setupAutocomplete(fdPath: string | undefined): void {
    const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map(command => ({
      name: command.name,
      description: command.description
    }));

    const modelCommand = slashCommands.find(command => command.name === 'model');
    if (modelCommand) {
      modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
        const models = this.session.scopedModels.length > 0 ? this.session.scopedModels.map(s => s.model) : this.session.modelRegistry.getAvailable();

        if (models.length === 0) return null;

        const items = models.map(m => ({
          id: m.id,
          provider: m.provider,
          label: `${m.provider}/${m.id}`
        }));

        const filtered = fuzzyFilter(items, prefix, item => `${item.id} ${item.provider}`);

        if (filtered.length === 0) return null;

        return filtered.map(item => ({
          value: item.label,
          label: item.id,
          description: item.provider
        }));
      };
    }

    const templateCommands: SlashCommand[] = this.session.promptTemplates.map(cmd => ({
      name: cmd.name,
      description: cmd.description
    }));

    const builtinCommandNames = new Set(slashCommands.map(c => c.name));
    const extensionCommands: SlashCommand[] = (this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []).map(cmd => ({
      name: cmd.name,
      description: cmd.description ?? '(extension command)',
      getArgumentCompletions: cmd.getArgumentCompletions
    }));

    this.skillCommands.clear();
    const skillCommandList: SlashCommand[] = [];
    if (this.settingsManager.getEnableSkillCommands()) {
      for (const skill of this.session.resourceLoader.getSkills().skills) {
        const commandName = `skill:${skill.name}`;
        this.skillCommands.set(commandName, skill.filePath);
        skillCommandList.push({ name: commandName, description: skill.description });
      }
    }

    this.autocompleteProvider = new CombinedAutocompleteProvider(
      [...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
      process.cwd(),
      fdPath
    );
    this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
    if (this.editor !== this.defaultEditor) {
      this.editor.setAutocompleteProvider?.(this.autocompleteProvider);
    }
  }

  async init(): Promise<void> {
    if (this.isInitialized) return;

    const [fdPath] = await Promise.all([ensureTool('fd'), ensureTool('rg')]);
    this.fdPath = fdPath;

    this.ui.addChild(this.headerContainer);

    if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
      const username = os.userInfo().username;
      const welcome = theme.bold(`Welcome back ${username}!`);
      const logo = theme.bold('🐙 ' + theme.fg('accent', APP_NAME)) + theme.fg('dim', ` v${this.version}`);
      const help = rawKeyHint('ctrl+h', 'for help');

      this.builtInHeader = new Text(`${welcome}\n\n${logo}\n${help}`, 1, 0);

      this.headerContainer.addChild(new Spacer(1));
      this.headerContainer.addChild(this.builtInHeader);
    } else {
      this.builtInHeader = new Text('', 0, 0);
      this.headerContainer.addChild(this.builtInHeader);
    }

    this.ui.addChild(this.chatContainer);
    this.ui.addChild(this.pendingMessagesContainer);
    this.renderWidgets();
    this.ui.addChild(this.widgetContainerAbove);
    this.ui.addChild(this.editorContainer);
    this.ui.addChild(this.widgetContainerBelow);
    this.ui.addChild(this.footer);
    this.ui.addChild(this.statusContainer);
    this.ui.setFocus(this.editor);

    this.setupKeyHandlers();
    this.setupEditorSubmitHandler();

    this.ui.start();
    this.isInitialized = true;

    await this.initExtensions();

    this.renderInitialMessages();

    this.updateTerminalTitle();

    this.subscribeToAgent();

    onThemeChange(() => {
      this.ui.invalidate();
      this.updateEditorBorderColor();
      this.ui.requestRender();
    });

    this.footerDataProvider.onBranchChange(() => {
      this.ui.requestRender();
    });

    await this.updateAvailableProviderCount();
  }

  private updateTerminalTitle(): void {
    const cwdBasename = path.basename(process.cwd());
    const sessionName = this.sessionManager.getSessionName();
    if (sessionName) {
      this.ui.terminal.setTitle(`π - ${sessionName} - ${cwdBasename}`);
    } else {
      this.ui.terminal.setTitle(`π - ${cwdBasename}`);
    }
  }

  async run(): Promise<void> {
    await this.init();

    this.checkTmuxKeyboardSetup().then(warning => {
      if (warning) {
        this.showWarning(warning);
      }
    });

    const { modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

    const modelsJsonError = this.session.modelRegistry.getError();
    if (modelsJsonError) {
      this.showError(`models.json error: ${modelsJsonError}`);
    }

    if (!this.session.model) {
      this.showError('No model configured. Please set up API credentials.');
    } else if (modelFallbackMessage) {
      this.showWarning(modelFallbackMessage);
    }

    if (initialMessage) {
      try {
        await this.session.prompt(initialMessage, { images: initialImages });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        this.showError(errorMessage);
      }
    }

    if (initialMessages) {
      for (const message of initialMessages) {
        try {
          await this.session.prompt(message);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          this.showError(errorMessage);
        }
      }
    }

    while (true) {
      const userInput = await this.getUserInput();
      try {
        await this.session.prompt(userInput);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        this.showError(errorMessage);
      }
    }
  }

  private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
    if (!process.env.TMUX) return undefined;

    const runTmuxShow = (option: string): Promise<string | undefined> => {
      return new Promise(resolve => {
        const proc = spawn('tmux', ['show', '-gv', option], {
          stdio: ['ignore', 'pipe', 'ignore']
        });
        let stdout = '';
        const timer = setTimeout(() => {
          proc.kill();
          resolve(undefined);
        }, 2000);

        proc.stdout?.on('data', data => {
          stdout += data.toString();
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
        proc.on('close', code => {
          clearTimeout(timer);
          resolve(code === 0 ? stdout.trim() : undefined);
        });
      });
    };

    const [extendedKeys, extendedKeysFormat] = await Promise.all([runTmuxShow('extended-keys'), runTmuxShow('extended-keys-format')]);

    if (extendedKeys === undefined) return undefined;

    if (extendedKeys !== 'on' && extendedKeys !== 'always') {
      return 'tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.';
    }

    if (extendedKeysFormat === 'xterm') {
      return 'tmux extended-keys-format is xterm. perplx works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.';
    }

    return undefined;
  }

  private getMarkdownThemeWithSettings(): MarkdownTheme {
    return {
      ...getMarkdownTheme(),
      codeBlockIndent: this.settingsManager.getCodeBlockIndent()
    };
  }

  private formatDisplayPath(p: string): string {
    const home = os.homedir();
    let result = p;

    if (result.startsWith(home)) {
      result = `~${result.slice(home.length)}`;
    }

    return result;
  }

  private getShortPath(fullPath: string, source: string): string {
    const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
    if (npmMatch && source.startsWith('npm:')) {
      return npmMatch[2];
    }

    const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
    if (gitMatch && source.startsWith('git:')) {
      return gitMatch[1];
    }

    return this.formatDisplayPath(fullPath);
  }

  private getDisplaySourceInfo(source: string, scope: string): { label: string; scopeLabel?: string; color: 'accent' | 'muted' } {
    if (source === 'local') {
      if (scope === 'user') {
        return { label: 'user', color: 'muted' };
      }
      if (scope === 'project') {
        return { label: 'project', color: 'muted' };
      }
      if (scope === 'temporary') {
        return { label: 'path', scopeLabel: 'temp', color: 'muted' };
      }
      return { label: 'path', color: 'muted' };
    }

    if (source === 'cli') {
      return { label: 'path', scopeLabel: scope === 'temporary' ? 'temp' : undefined, color: 'muted' };
    }

    const scopeLabel = scope === 'user' ? 'user' : scope === 'project' ? 'project' : scope === 'temporary' ? 'temp' : undefined;
    return { label: source, scopeLabel, color: 'accent' };
  }

  private getScopeGroup(source: string, scope: string): 'user' | 'project' | 'path' {
    if (source === 'cli' || scope === 'temporary') return 'path';
    if (scope === 'user') return 'user';
    if (scope === 'project') return 'project';
    return 'path';
  }

  private isPackageSource(source: string): boolean {
    return source.startsWith('npm:') || source.startsWith('git:');
  }

  private buildScopeGroups(
    paths: string[],
    metadata: Map<string, { source: string; scope: string; origin: string }>
  ): Array<{ scope: 'user' | 'project' | 'path'; paths: string[]; packages: Map<string, string[]> }> {
    const groups: Record<'user' | 'project' | 'path', { scope: 'user' | 'project' | 'path'; paths: string[]; packages: Map<string, string[]> }> = {
      user: { scope: 'user', paths: [], packages: new Map() },
      project: { scope: 'project', paths: [], packages: new Map() },
      path: { scope: 'path', paths: [], packages: new Map() }
    };

    for (const p of paths) {
      const meta = this.findMetadata(p, metadata);
      const source = meta?.source ?? 'local';
      const scope = meta?.scope ?? 'project';
      const groupKey = this.getScopeGroup(source, scope);
      const group = groups[groupKey];

      if (this.isPackageSource(source)) {
        const list = group.packages.get(source) ?? [];
        list.push(p);
        group.packages.set(source, list);
      } else {
        group.paths.push(p);
      }
    }

    return [groups.project, groups.user, groups.path].filter(group => group.paths.length > 0 || group.packages.size > 0);
  }

  private formatScopeGroups(
    groups: Array<{ scope: 'user' | 'project' | 'path'; paths: string[]; packages: Map<string, string[]> }>,
    options: {
      formatPath: (p: string) => string;
      formatPackagePath: (p: string, source: string) => string;
    }
  ): string {
    const lines: string[] = [];

    for (const group of groups) {
      lines.push(`  ${theme.fg('accent', group.scope)}`);

      const sortedPaths = [...group.paths].sort((a, b) => a.localeCompare(b));
      for (const p of sortedPaths) {
        lines.push(theme.fg('dim', `    ${options.formatPath(p)}`));
      }

      const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
      for (const [source, paths] of sortedPackages) {
        lines.push(`    ${theme.fg('mdLink', source)}`);
        const sortedPackagePaths = [...paths].sort((a, b) => a.localeCompare(b));
        for (const p of sortedPackagePaths) {
          lines.push(theme.fg('dim', `      ${options.formatPackagePath(p, source)}`));
        }
      }
    }

    return lines.join('\n');
  }

  private findMetadata(
    p: string,
    metadata: Map<string, { source: string; scope: string; origin: string }>
  ): { source: string; scope: string; origin: string } | undefined {
    const exact = metadata.get(p);
    if (exact) return exact;

    let current = p;
    while (current.includes('/')) {
      current = current.substring(0, current.lastIndexOf('/'));
      const parent = metadata.get(current);
      if (parent) return parent;
    }

    return undefined;
  }

  private formatPathWithSource(p: string, metadata: Map<string, { source: string; scope: string; origin: string }>): string {
    const meta = this.findMetadata(p, metadata);
    if (meta) {
      const shortPath = this.getShortPath(p, meta.source);
      const { label, scopeLabel } = this.getDisplaySourceInfo(meta.source, meta.scope);
      const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
      return `${labelText} ${shortPath}`;
    }
    return this.formatDisplayPath(p);
  }

  private formatDiagnostics(
    diagnostics: readonly ResourceDiagnostic[],
    metadata: Map<string, { source: string; scope: string; origin: string }>
  ): string {
    const lines: string[] = [];

    const collisions = new Map<string, ResourceDiagnostic[]>();
    const otherDiagnostics: ResourceDiagnostic[] = [];

    for (const d of diagnostics) {
      if (d.type === 'collision' && d.collision) {
        const list = collisions.get(d.collision.name) ?? [];
        list.push(d);
        collisions.set(d.collision.name, list);
      } else {
        otherDiagnostics.push(d);
      }
    }

    for (const [name, collisionList] of collisions) {
      const first = collisionList[0]?.collision;
      if (!first) continue;
      lines.push(theme.fg('warning', `  "${name}" collision:`));

      lines.push(theme.fg('dim', `    ${theme.fg('success', '✓')} ${this.formatPathWithSource(first.winnerPath, metadata)}`));

      for (const d of collisionList) {
        if (d.collision) {
          lines.push(theme.fg('dim', `    ${theme.fg('warning', '✗')} ${this.formatPathWithSource(d.collision.loserPath, metadata)} (skipped)`));
        }
      }
    }

    for (const d of otherDiagnostics) {
      if (d.path) {
        const sourceInfo = this.formatPathWithSource(d.path, metadata);
        lines.push(theme.fg(d.type === 'error' ? 'error' : 'warning', `  ${sourceInfo}`));
        lines.push(theme.fg(d.type === 'error' ? 'error' : 'warning', `    ${d.message}`));
      } else {
        lines.push(theme.fg(d.type === 'error' ? 'error' : 'warning', `  ${d.message}`));
      }
    }

    return lines.join('\n');
  }

  private showLoadedResources(options?: { extensionPaths?: string[]; force?: boolean; showDiagnosticsWhenQuiet?: boolean }): void {
    const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
    const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
    if (!showListing && !showDiagnostics) {
      return;
    }

    const metadata = this.session.resourceLoader.getPathMetadata();
    const sectionHeader = (name: string, color: ThemeColor = 'mdHeading') => theme.fg(color, `[${name}]`);

    const skillsResult = this.session.resourceLoader.getSkills();
    const promptsResult = this.session.resourceLoader.getPrompts();
    const themesResult = this.session.resourceLoader.getThemes();

    if (showListing) {
      const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
      if (contextFiles.length > 0) {
        this.chatContainer.addChild(new Spacer(1));
        const contextList = contextFiles.map(f => theme.fg('dim', `  ${this.formatDisplayPath(f.path)}`)).join('\n');
        this.chatContainer.addChild(new Text(`${sectionHeader('Context')}\n${contextList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }

      const skills = skillsResult.skills;
      if (skills.length > 0) {
        const skillPaths = skills.map(s => s.filePath);
        const groups = this.buildScopeGroups(skillPaths, metadata);
        const skillList = this.formatScopeGroups(groups, {
          formatPath: p => this.formatDisplayPath(p),
          formatPackagePath: (p, source) => this.getShortPath(p, source)
        });
        this.chatContainer.addChild(new Text(`${sectionHeader('Skills')}\n${skillList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }

      const templates = this.session.promptTemplates;
      if (templates.length > 0) {
        const templatePaths = templates.map(t => t.filePath);
        const groups = this.buildScopeGroups(templatePaths, metadata);
        const templateByPath = new Map(templates.map(t => [t.filePath, t]));
        const templateList = this.formatScopeGroups(groups, {
          formatPath: p => {
            const template = templateByPath.get(p);
            return template ? `/${template.name}` : this.formatDisplayPath(p);
          },
          formatPackagePath: p => {
            const template = templateByPath.get(p);
            return template ? `/${template.name}` : this.formatDisplayPath(p);
          }
        });
        this.chatContainer.addChild(new Text(`${sectionHeader('Prompts')}\n${templateList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }

      const extensionPaths = options?.extensionPaths ?? [];
      if (extensionPaths.length > 0) {
        const groups = this.buildScopeGroups(extensionPaths, metadata);
        const extList = this.formatScopeGroups(groups, {
          formatPath: p => this.formatDisplayPath(p),
          formatPackagePath: (p, source) => this.getShortPath(p, source)
        });
        this.chatContainer.addChild(new Text(`${sectionHeader('Extensions', 'mdHeading')}\n${extList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }

      const loadedThemes = themesResult.themes;
      const customThemes = loadedThemes.filter(t => t.sourcePath);
      if (customThemes.length > 0) {
        const themePaths = customThemes.map(t => t.sourcePath!);
        const groups = this.buildScopeGroups(themePaths, metadata);
        const themeList = this.formatScopeGroups(groups, {
          formatPath: p => this.formatDisplayPath(p),
          formatPackagePath: (p, source) => this.getShortPath(p, source)
        });
        this.chatContainer.addChild(new Text(`${sectionHeader('Themes')}\n${themeList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }
    }

    if (showDiagnostics) {
      const skillDiagnostics = skillsResult.diagnostics;
      if (skillDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(skillDiagnostics, metadata);
        this.chatContainer.addChild(new Text(`${theme.fg('warning', '[Skill conflicts]')}\n${warningLines}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }

      const promptDiagnostics = promptsResult.diagnostics;
      if (promptDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(promptDiagnostics, metadata);
        this.chatContainer.addChild(new Text(`${theme.fg('warning', '[Prompt conflicts]')}\n${warningLines}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }

      const extensionDiagnostics: ResourceDiagnostic[] = [];
      const extensionErrors = this.session.resourceLoader.getExtensions().errors;
      if (extensionErrors.length > 0) {
        for (const error of extensionErrors) {
          extensionDiagnostics.push({ type: 'error', message: error.error, path: error.path });
        }
      }

      const commandDiagnostics = this.session.extensionRunner?.getCommandDiagnostics() ?? [];
      extensionDiagnostics.push(...commandDiagnostics);

      const shortcutDiagnostics = this.session.extensionRunner?.getShortcutDiagnostics() ?? [];
      extensionDiagnostics.push(...shortcutDiagnostics);

      if (extensionDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(extensionDiagnostics, metadata);
        this.chatContainer.addChild(new Text(`${theme.fg('warning', '[Extension issues]')}\n${warningLines}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }

      const themeDiagnostics = themesResult.diagnostics;
      if (themeDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(themeDiagnostics, metadata);
        this.chatContainer.addChild(new Text(`${theme.fg('warning', '[Theme conflicts]')}\n${warningLines}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }
    }
  }

  private async initExtensions(): Promise<void> {
    const uiContext = this.createExtensionUIContext();
    await this.session.bindExtensions({
      uiContext,
      commandContextActions: {
        waitForIdle: () => this.session.agent.waitForIdle(),
        newSession: async options => {
          if (this.loadingAnimation) {
            this.loadingAnimation.stop();
            this.loadingAnimation = undefined;
          }
          this.statusContainer.clear();

          const success = await this.session.newSession(options);
          if (!success) {
            return { cancelled: true };
          }

          this.chatContainer.clear();
          this.pendingMessagesContainer.clear();
          this.compactionQueuedMessages = [];
          this.streamingComponent = undefined;
          this.streamingMessage = undefined;
          this.pendingTools.clear();

          this.renderInitialMessages();
          this.ui.requestRender();

          return { cancelled: false };
        },
        fork: async entryId => {
          const result = await this.session.fork(entryId);
          if (result.cancelled) {
            return { cancelled: true };
          }

          this.chatContainer.clear();
          this.renderInitialMessages();
          this.editor.setText(result.selectedText);
          this.showStatus('Forked to new session');

          return { cancelled: false };
        },
        navigateTree: async (targetId, options) => {
          const result = await this.session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label
          });
          if (result.cancelled) {
            return { cancelled: true };
          }

          this.chatContainer.clear();
          this.renderInitialMessages();
          if (result.editorText && !this.editor.getText().trim()) {
            this.editor.setText(result.editorText);
          }
          this.showStatus('Navigated to selected point');

          return { cancelled: false };
        },
        switchSession: async sessionPath => {
          await this.handleResumeSession(sessionPath);
          return { cancelled: false };
        },
        reload: async () => {
          await this.handleReloadCommand();
        }
      },
      shutdownHandler: () => {
        this.shutdownRequested = true;
        if (!this.session.isStreaming) {
          void this.shutdown();
        }
      },
      onError: error => {
        this.showExtensionError(error.extensionPath, error.error, error.stack);
      }
    });

    setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
    this.setupAutocomplete(this.fdPath);

    const extensionRunner = this.session.extensionRunner;
    if (!extensionRunner) {
      this.showLoadedResources({ extensionPaths: [], force: false });
      return;
    }

    this.setupExtensionShortcuts(extensionRunner);
    this.showLoadedResources({ extensionPaths: extensionRunner.getExtensionPaths(), force: false });
  }

  private getRegisteredToolDefinition(toolName: string) {
    const tools = this.session.extensionRunner?.getAllRegisteredTools() ?? [];
    const registeredTool = tools.find(t => t.definition.name === toolName);
    if (registeredTool) return registeredTool.definition;
    return this.session.customTools.find(t => t.name === toolName);
  }

  private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
    const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
    if (shortcuts.size === 0) return;

    const createContext = (): ExtensionContext => ({
      ui: this.createExtensionUIContext(),
      hasUI: true,
      cwd: process.cwd(),
      sessionManager: this.sessionManager,
      modelRegistry: this.session.modelRegistry,
      model: this.session.model,
      isIdle: () => !this.session.isStreaming,
      abort: () => this.session.abort(),
      hasPendingMessages: () => this.session.pendingMessageCount > 0,
      shutdown: () => {
        this.shutdownRequested = true;
      },
      getContextUsage: () => this.session.getContextUsage(),
      compact: options => {
        void (async () => {
          try {
            const result = await this.executeCompaction(options?.customInstructions, false);
            if (result) {
              options?.onComplete?.(result);
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            options?.onError?.(err);
          }
        })();
      },
      getSystemPrompt: () => this.session.systemPrompt
    });

    this.defaultEditor.onExtensionShortcut = (data: string) => {
      for (const [shortcutStr, shortcut] of shortcuts) {
        if (matchesKey(data, shortcutStr as KeyId)) {
          Promise.resolve(shortcut.handler(createContext())).catch(err => {
            this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
          });
          return true;
        }
      }
      return false;
    };
  }

  private setExtensionStatus(key: string, text: string | undefined): void {
    this.footerDataProvider.setExtensionStatus(key, text);
    this.ui.requestRender();
  }

  private setExtensionWidget(
    key: string,
    content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
    options?: ExtensionWidgetOptions
  ): void {
    const placement = options?.placement ?? 'aboveEditor';
    const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
      const existing = map.get(key);
      if (existing?.dispose) existing.dispose();
      map.delete(key);
    };

    removeExisting(this.extensionWidgetsAbove);
    removeExisting(this.extensionWidgetsBelow);

    if (content === undefined) {
      this.renderWidgets();
      return;
    }

    let component: Component & { dispose?(): void };

    if (Array.isArray(content)) {
      const container = new Container();
      for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
        container.addChild(new Text(line, 1, 0));
      }
      if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
        container.addChild(new Text(theme.fg('muted', '... (widget truncated)'), 1, 0));
      }
      component = container;
    } else {
      component = content(this.ui, theme);
    }

    const targetMap = placement === 'belowEditor' ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
    targetMap.set(key, component);
    this.renderWidgets();
  }

  private clearExtensionWidgets(): void {
    for (const widget of this.extensionWidgetsAbove.values()) {
      widget.dispose?.();
    }
    for (const widget of this.extensionWidgetsBelow.values()) {
      widget.dispose?.();
    }
    this.extensionWidgetsAbove.clear();
    this.extensionWidgetsBelow.clear();
    this.renderWidgets();
  }

  private resetExtensionUI(): void {
    this.ui.hideOverlay();
    this.clearExtensionTerminalInputListeners();
    this.setExtensionFooter(undefined);
    this.setExtensionHeader(undefined);
    this.clearExtensionWidgets();
    this.footerDataProvider.clearExtensionStatuses();
    this.footer.invalidate();
    this.setCustomEditorComponent(undefined);
    this.defaultEditor.onExtensionShortcut = undefined;
    this.updateTerminalTitle();
    if (this.loadingAnimation) {
      this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyText('app.interrupt')} to interrupt)`);
    }
  }

  private static readonly MAX_WIDGET_LINES = 10;

  private renderWidgets(): void {
    if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
    this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
    this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
    this.ui.requestRender();
  }

  private renderWidgetContainer(
    container: Container,
    widgets: Map<string, Component & { dispose?(): void }>,
    spacerWhenEmpty: boolean,
    leadingSpacer: boolean
  ): void {
    container.clear();

    if (widgets.size === 0) {
      if (spacerWhenEmpty) {
        container.addChild(new Spacer(1));
      }
      return;
    }

    if (leadingSpacer) {
      container.addChild(new Spacer(1));
    }
    for (const component of widgets.values()) {
      container.addChild(component);
    }
  }

  private setExtensionFooter(
    factory: ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void }) | undefined
  ): void {
    if (this.customFooter?.dispose) {
      this.customFooter.dispose();
    }

    if (this.customFooter) {
      this.ui.removeChild(this.customFooter);
    } else {
      this.ui.removeChild(this.footer);
    }

    if (factory) {
      this.customFooter = factory(this.ui, theme, this.footerDataProvider);
      this.ui.addChild(this.customFooter);
    } else {
      this.customFooter = undefined;
      this.ui.addChild(this.footer);
    }

    this.ui.requestRender();
  }

  private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
    if (!this.builtInHeader) {
      return;
    }

    if (this.customHeader?.dispose) {
      this.customHeader.dispose();
    }

    const currentHeader = this.customHeader || this.builtInHeader;
    const index = this.headerContainer.children.indexOf(currentHeader);

    if (factory) {
      this.customHeader = factory(this.ui, theme);
      if (index !== -1) {
        this.headerContainer.children[index] = this.customHeader;
      } else {
        this.headerContainer.children.unshift(this.customHeader);
      }
    } else {
      this.customHeader = undefined;
      if (index !== -1) {
        this.headerContainer.children[index] = this.builtInHeader;
      }
    }

    this.ui.requestRender();
  }

  private addExtensionTerminalInputListener(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void {
    const unsubscribe = this.ui.addInputListener(handler);
    this.extensionTerminalInputUnsubscribers.add(unsubscribe);
    return () => {
      unsubscribe();
      this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
    };
  }

  private clearExtensionTerminalInputListeners(): void {
    for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
      unsubscribe();
    }
    this.extensionTerminalInputUnsubscribers.clear();
  }

  private createExtensionUIContext(): ExtensionUIContext {
    return {
      select: (_title, _options, _opts) => Promise.resolve(undefined),
      confirm: (_title, _message, _opts) => Promise.resolve(false),
      input: (_title, _placeholder, _opts) => Promise.resolve(undefined),
      notify: (message, type) => this.showExtensionNotify(message, type),
      onTerminalInput: handler => this.addExtensionTerminalInputListener(handler),
      setStatus: (key, text) => this.setExtensionStatus(key, text),
      setWorkingMessage: message => {
        if (this.loadingAnimation) {
          if (message) {
            this.loadingAnimation.setMessage(message);
          } else {
            this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyText('app.interrupt')} to interrupt)`);
          }
        } else {
          this.pendingWorkingMessage = message;
        }
      },
      setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
      setFooter: factory => this.setExtensionFooter(factory),
      setHeader: factory => this.setExtensionHeader(factory),
      setTitle: title => this.ui.terminal.setTitle(title),
      custom: (factory, options) => this.showExtensionCustom(factory, options),
      pasteToEditor: text => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
      setEditorText: text => this.editor.setText(text),
      getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
      editor: (_title, _prefill) => Promise.resolve(undefined),
      setEditorComponent: factory => this.setCustomEditorComponent(factory),
      get theme() {
        return theme;
      },
      getAllThemes: () => getAvailableThemesWithPaths(),
      getTheme: name => getThemeByName(name),
      setTheme: themeOrName => {
        if (themeOrName instanceof Theme) {
          setThemeInstance(themeOrName);
          this.ui.requestRender();
          return { success: true };
        }
        const result = setTheme(themeOrName, true);
        if (result.success) {
          if (this.settingsManager.getTheme() !== themeOrName) {
            this.settingsManager.setTheme(themeOrName);
          }
          this.ui.requestRender();
        }
        return result;
      },
      getToolsExpanded: () => this.toolOutputExpanded,
      setToolsExpanded: expanded => this.setToolsExpanded(expanded)
    };
  }

  private setCustomEditorComponent(factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined): void {
    const currentText = this.editor.getText();

    this.editorContainer.clear();

    if (factory) {
      const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

      newEditor.onSubmit = this.defaultEditor.onSubmit;
      newEditor.onChange = this.defaultEditor.onChange;

      newEditor.setText(currentText);

      if (newEditor.borderColor !== undefined) {
        newEditor.borderColor = this.defaultEditor.borderColor;
      }
      if (newEditor.setPaddingX !== undefined) {
        newEditor.setPaddingX(this.defaultEditor.getPaddingX());
      }

      if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
        newEditor.setAutocompleteProvider(this.autocompleteProvider);
      }

      const customEditor = newEditor as unknown as Record<string, unknown>;
      if ('actionHandlers' in customEditor && customEditor.actionHandlers instanceof Map) {
        if (!customEditor.onEscape) {
          customEditor.onEscape = () => this.defaultEditor.onEscape?.();
        }
        if (!customEditor.onCtrlD) {
          customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
        }
        if (!customEditor.onPasteImage) {
          customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
        }
        if (!customEditor.onExtensionShortcut) {
          customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
        }

        for (const [action, handler] of this.defaultEditor.actionHandlers) {
          (customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
        }
      }

      this.editor = newEditor;
    } else {
      this.defaultEditor.setText(currentText);
      this.editor = this.defaultEditor;
    }

    this.editorContainer.addChild(this.editor as Component);
    this.ui.setFocus(this.editor as Component);
    this.ui.requestRender();
  }

  private showExtensionNotify(message: string, type?: 'info' | 'warning' | 'error'): void {
    if (type === 'error') {
      this.showError(message);
    } else if (type === 'warning') {
      this.showWarning(message);
    } else {
      this.showStatus(message);
    }
  }

  private async showExtensionCustom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void
    ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      onHandle?: (handle: OverlayHandle) => void;
    }
  ): Promise<T> {
    const savedText = this.editor.getText();
    const isOverlay = options?.overlay ?? false;

    const restoreEditor = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.editor.setText(savedText);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };

    return new Promise((resolve, reject) => {
      let component: Component & { dispose?(): void };
      let closed = false;

      const close = (result: T) => {
        if (closed) return;
        closed = true;
        if (isOverlay) this.ui.hideOverlay();
        else restoreEditor();

        resolve(result);
        try {
          component?.dispose?.();
        } catch {}
      };

      Promise.resolve(factory(this.ui, theme, this.keybindings, close))
        .then(c => {
          if (closed) return;
          component = c;
          if (isOverlay) {
            const resolveOptions = (): OverlayOptions | undefined => {
              if (options?.overlayOptions) {
                const opts = typeof options.overlayOptions === 'function' ? options.overlayOptions() : options.overlayOptions;
                return opts;
              }

              const w = (component as { width?: number }).width;
              return w ? { width: w } : undefined;
            };
            const handle = this.ui.showOverlay(component, resolveOptions());

            options?.onHandle?.(handle);
          } else {
            this.editorContainer.clear();
            this.editorContainer.addChild(component);
            this.ui.setFocus(component);
            this.ui.requestRender();
          }
        })
        .catch(err => {
          if (closed) return;
          if (!isOverlay) restoreEditor();
          reject(err);
        });
    });
  }

  private showExtensionError(extensionPath: string, error: string, stack?: string): void {
    const errorMsg = `Extension "${extensionPath}" error: ${error}`;
    const errorText = new Text(theme.fg('error', errorMsg), 1, 0);
    this.chatContainer.addChild(errorText);
    if (stack) {
      const stackLines = stack
        .split('\n')
        .slice(1)
        .map(line => theme.fg('dim', `  ${line.trim()}`))
        .join('\n');
      if (stackLines) {
        this.chatContainer.addChild(new Text(stackLines, 1, 0));
      }
    }
    this.ui.requestRender();
  }

  private setupKeyHandlers(): void {
    this.defaultEditor.onEscape = () => {
      if (this.loadingAnimation) {
        this.restoreQueuedMessagesToEditor({ abort: true });
      } else if (this.session.isBashRunning) {
        this.session.abortBash();
      } else if (this.isBashMode) {
        this.editor.setText('');
        this.isBashMode = false;
        this.updateEditorBorderColor();
      } else if (!this.editor.getText().trim()) {
        const action = this.settingsManager.getDoubleEscapeAction();
        if (action !== 'none') {
          const now = Date.now();
          if (now - this.lastEscapeTime < 500) {
            if (action === 'tree') {
              this.showTreeSelector();
            } else {
              this.showUserMessageSelector();
            }
            this.lastEscapeTime = 0;
          } else {
            this.lastEscapeTime = now;
          }
        }
      }
    };

    this.defaultEditor.onAction('app.clear', () => this.handleCtrlC());
    this.defaultEditor.onCtrlD = () => this.handleCtrlD();
    this.defaultEditor.onAction('app.suspend', () => this.handleCtrlZ());
    this.defaultEditor.onAction('app.thinking.cycle', () => this.cycleThinkingLevel());
    this.defaultEditor.onAction('app.model.cycleForward', () => this.cycleModel('forward'));
    this.defaultEditor.onAction('app.model.cycleBackward', () => this.cycleModel('backward'));

    this.ui.onDebug = () => this.handleDebugCommand();
    this.defaultEditor.onAction('app.model.select', () => this.showModelSelector());
    this.defaultEditor.onAction('app.tools.expand', () => this.toggleToolOutputExpansion());
    this.defaultEditor.onAction('app.thinking.toggle', () => this.toggleThinkingBlockVisibility());
    this.defaultEditor.onAction('app.editor.external', () => this.openExternalEditor());
    this.defaultEditor.onAction('app.message.followUp', () => this.handleFollowUp());
    this.defaultEditor.onAction('app.message.dequeue', () => this.handleDequeue());
    this.defaultEditor.onAction('app.session.new', () => this.handleClearCommand());
    this.defaultEditor.onAction('app.session.tree', () => this.showTreeSelector());
    this.defaultEditor.onAction('app.session.fork', () => this.showUserMessageSelector());
    this.defaultEditor.onAction('app.session.resume', () => this.showSessionSelector());
    this.defaultEditor.onAction('app.help', () => this.showHelp());

    this.defaultEditor.onChange = (text: string) => {
      const wasBashMode = this.isBashMode;
      this.isBashMode = text.trimStart().startsWith('!');
      if (wasBashMode !== this.isBashMode) {
        this.updateEditorBorderColor();
      }
    };

    this.defaultEditor.onPasteImage = () => {
      this.handleClipboardImagePaste();
    };
  }

  private async handleClipboardImagePaste(): Promise<void> {
    try {
      const image = await readClipboardImage();
      if (!image) {
        return;
      }

      const tmpDir = os.tmpdir();
      const ext = extensionForImageMimeType(image.mimeType) ?? 'png';
      const fileName = `perplx-clipboard-${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(tmpDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(image.bytes));

      this.editor.insertTextAtCursor?.(filePath);
      this.ui.requestRender();
    } catch {}
  }

  private setupEditorSubmitHandler(): void {
    this.defaultEditor.onSubmit = async (text: string) => {
      text = text.trim();
      if (!text) return;

      if (text === '/settings') {
        this.showSettingsSelector();
        this.editor.setText('');
        return;
      }
      if (text === '/model' || text.startsWith('/model ')) {
        const searchTerm = text.startsWith('/model ') ? text.slice(7).trim() : undefined;
        this.editor.setText('');
        await this.handleModelCommand(searchTerm);
        return;
      }
      if (text === '/share') {
        await this.handleShareCommand();
        this.editor.setText('');
        return;
      }
      if (text === '/copy') {
        await this.handleCopyCommand();
        this.editor.setText('');
        return;
      }
      if (text === '/name' || text.startsWith('/name ')) {
        this.handleNameCommand(text);
        this.editor.setText('');
        return;
      }
      if (text === '/session') {
        this.handleSessionCommand();
        this.editor.setText('');
        return;
      }
      if (text === '/hotkeys') {
        this.handleHotkeysCommand();
        this.editor.setText('');
        return;
      }
      if (text === '/fork') {
        this.showUserMessageSelector();
        this.editor.setText('');
        return;
      }
      if (text === '/tree') {
        this.showTreeSelector();
        this.editor.setText('');
        return;
      }
      if (text === '/new') {
        this.editor.setText('');
        await this.handleClearCommand();
        return;
      }
      if (text === '/compact' || text.startsWith('/compact ')) {
        const customInstructions = text.startsWith('/compact ') ? text.slice(9).trim() : undefined;
        this.editor.setText('');
        await this.handleCompactCommand(customInstructions);
        return;
      }
      if (text === '/reload') {
        this.editor.setText('');
        await this.handleReloadCommand();
        return;
      }
      if (text === '/debug') {
        this.handleDebugCommand();
        this.editor.setText('');
        return;
      }
      if (text === '/arminsayshi') {
        this.handleArminSaysHi();
        this.editor.setText('');
        return;
      }
      if (text === '/resume') {
        this.showSessionSelector();
        this.editor.setText('');
        return;
      }
      if (text === '/quit') {
        this.editor.setText('');
        await this.shutdown();
        return;
      }

      if (text.startsWith('!')) {
        const isExcluded = text.startsWith('!!');
        const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
        if (command) {
          if (this.session.isBashRunning) {
            this.showWarning('A bash command is already running. Press Esc to cancel it first.');
            this.editor.setText(text);
            return;
          }
          this.editor.addToHistory?.(text);
          await this.handleBashCommand(command, isExcluded);
          this.isBashMode = false;
          this.updateEditorBorderColor();
          return;
        }
      }

      if (this.session.isCompacting) {
        if (this.isExtensionCommand(text)) {
          this.editor.addToHistory?.(text);
          this.editor.setText('');
          await this.session.prompt(text);
        } else {
          this.queueCompactionMessage(text, 'steer');
        }
        return;
      }

      if (this.session.isStreaming) {
        this.editor.addToHistory?.(text);
        this.editor.setText('');
        await this.session.prompt(text, { streamingBehavior: 'steer' });
        this.updatePendingMessagesDisplay();
        this.ui.requestRender();
        return;
      }

      this.flushPendingBashComponents();

      if (this.onInputCallback) {
        this.onInputCallback(text);
      }
      this.editor.addToHistory?.(text);
    };
  }

  private subscribeToAgent(): void {
    this.unsubscribe = this.session.subscribe(async event => {
      await this.handleEvent(event);
    });
  }

  private async handleEvent(event: AgentSessionEvent): Promise<void> {
    if (!this.isInitialized) {
      await this.init();
    }

    this.footer.invalidate();

    switch (event.type) {
      case 'agent_start':
        if (this.retryEscapeHandler) {
          this.defaultEditor.onEscape = this.retryEscapeHandler;
          this.retryEscapeHandler = undefined;
        }
        if (this.retryLoader) {
          this.retryLoader.stop();
          this.retryLoader = undefined;
        }
        if (this.loadingAnimation) {
          this.loadingAnimation.stop();
        }
        this.statusContainer.clear();
        this.loadingAnimation = new Loader(
          this.ui,
          spinner => theme.fg('accent', spinner),
          text => theme.fg('muted', text),
          this.defaultWorkingMessage
        );
        this.statusContainer.addChild(this.loadingAnimation);

        if (this.pendingWorkingMessage !== undefined) {
          if (this.pendingWorkingMessage) {
            this.loadingAnimation.setMessage(this.pendingWorkingMessage);
          }
          this.pendingWorkingMessage = undefined;
        }
        this.ui.requestRender();
        break;

      case 'message_start':
        if (event.message.role === 'custom') {
          this.addMessageToChat(event.message);
          this.ui.requestRender();
        } else if (event.message.role === 'user') {
          this.addMessageToChat(event.message);
          this.updatePendingMessagesDisplay();
          this.ui.requestRender();
        } else if (event.message.role === 'assistant') {
          this.streamingComponent = new AssistantMessageComponent(undefined, this.hideThinkingBlock, this.getMarkdownThemeWithSettings());
          this.streamingMessage = event.message;
          this.chatContainer.addChild(this.streamingComponent);
          this.streamingComponent.updateContent(this.streamingMessage);
          this.ui.requestRender();
        }
        break;

      case 'message_update':
        if (this.streamingComponent && event.message.role === 'assistant') {
          this.streamingMessage = event.message;
          this.streamingComponent.updateContent(this.streamingMessage);

          for (const content of this.streamingMessage.content) {
            if (content.type === 'toolCall') {
              if (!this.pendingTools.has(content.id)) {
                const component = new ToolExecutionComponent(
                  content.name,
                  content.arguments,
                  {
                    showImages: this.settingsManager.getShowImages()
                  },
                  this.getRegisteredToolDefinition(content.name),
                  this.ui
                );
                component.setExpanded(this.toolOutputExpanded);
                this.chatContainer.addChild(component);
                this.pendingTools.set(content.id, component);
              } else {
                const component = this.pendingTools.get(content.id);
                if (component) {
                  component.updateArgs(content.arguments);
                }
              }
            }
          }
          this.footer.invalidate();
          this.ui.requestRender();
        }
        break;

      case 'message_end':
        if (event.message.role === 'user') break;
        if (this.streamingComponent && event.message.role === 'assistant') {
          this.streamingMessage = event.message;
          let errorMessage: string | undefined;
          if (this.streamingMessage.stopReason === 'aborted') {
            const retryAttempt = this.session.retryAttempt;
            errorMessage = retryAttempt > 0 ? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? 's' : ''}` : 'Operation aborted';
            this.streamingMessage.errorMessage = errorMessage;
          }
          this.streamingComponent.updateContent(this.streamingMessage);

          if (this.streamingMessage.stopReason === 'aborted' || this.streamingMessage.stopReason === 'error') {
            if (!errorMessage) {
              errorMessage = this.streamingMessage.errorMessage || 'Error';
            }
            for (const [, component] of this.pendingTools.entries()) {
              component.updateResult({
                content: [{ type: 'text', text: errorMessage }],
                isError: true
              });
            }
            this.pendingTools.clear();
          } else {
            for (const [, component] of this.pendingTools.entries()) {
              component.setArgsComplete();
            }
          }
          this.streamingComponent = undefined;
          this.streamingMessage = undefined;
          this.footer.invalidate();
        }
        this.ui.requestRender();
        break;

      case 'working_message':
        if (this.loadingAnimation) {
          this.loadingAnimation.setMessage((event as any).message);
        }
        this.ui.requestRender();
        break;

      case 'tool_execution_start': {
        let component = this.pendingTools.get(event.toolCallId);
        if (!component) {
          component = new ToolExecutionComponent(
            event.toolName,
            event.args,
            {
              showImages: this.settingsManager.getShowImages()
            },
            this.getRegisteredToolDefinition(event.toolName),
            this.ui
          );
          component.setExpanded(this.toolOutputExpanded);
          this.chatContainer.addChild(component);
          this.pendingTools.set(event.toolCallId, component);
        }
        component.markExecutionStarted();
        this.ui.requestRender();
        break;
      }

      case 'tool_execution_update': {
        const component = this.pendingTools.get(event.toolCallId);
        if (component) {
          component.updateResult({ ...event.partialResult, isError: false }, true);
          this.ui.requestRender();
        }
        break;
      }

      case 'tool_execution_end': {
        const component = this.pendingTools.get(event.toolCallId);
        if (component) {
          component.updateResult({ ...event.result, isError: event.isError });
          this.pendingTools.delete(event.toolCallId);
          this.footer.invalidate();
          this.ui.requestRender();
        }
        break;
      }

      case 'agent_end':
        if (this.loadingAnimation) {
          this.loadingAnimation.stop();
          this.loadingAnimation = undefined;
          this.statusContainer.clear();
        }
        if (this.streamingComponent) {
          this.chatContainer.removeChild(this.streamingComponent);
          this.streamingComponent = undefined;
          this.streamingMessage = undefined;
        }
        this.pendingTools.clear();

        await this.checkShutdownRequested();

        this.ui.requestRender();
        break;

      case 'auto_compaction_start': {
        this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
        this.defaultEditor.onEscape = () => {
          this.session.abortCompaction();
        };

        this.statusContainer.clear();
        const reasonText = event.reason === 'overflow' ? 'Context overflow detected, ' : '';
        this.autoCompactionLoader = new Loader(
          this.ui,
          spinner => theme.fg('accent', spinner),
          text => theme.fg('muted', text),
          `${reasonText}Auto-compacting... (${keyText('app.interrupt')} to cancel)`
        );
        this.statusContainer.addChild(this.autoCompactionLoader);
        this.ui.requestRender();
        break;
      }

      case 'auto_compaction_end': {
        if (this.autoCompactionEscapeHandler) {
          this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
          this.autoCompactionEscapeHandler = undefined;
        }

        if (this.autoCompactionLoader) {
          this.autoCompactionLoader.stop();
          this.autoCompactionLoader = undefined;
          this.statusContainer.clear();
        }

        if (event.aborted) {
          this.showStatus('Auto-compaction cancelled');
        } else if (event.result) {
          this.chatContainer.clear();
          this.rebuildChatFromMessages();

          this.addMessageToChat({
            role: 'compactionSummary',
            tokensBefore: event.result.tokensBefore,
            summary: event.result.summary,
            timestamp: Date.now()
          });
          this.footer.invalidate();
        } else if (event.errorMessage) {
          this.chatContainer.addChild(new Spacer(1));
          this.chatContainer.addChild(new Text(theme.fg('error', event.errorMessage), 1, 0));
        }
        void this.flushCompactionQueue({ willRetry: event.willRetry });
        this.ui.requestRender();
        break;
      }

      case 'auto_retry_start': {
        this.retryEscapeHandler = this.defaultEditor.onEscape;
        this.defaultEditor.onEscape = () => {
          this.session.abortRetry();
        };

        this.statusContainer.clear();
        const delaySeconds = Math.round(event.delayMs / 1000);
        this.retryLoader = new Loader(
          this.ui,
          spinner => theme.fg('warning', spinner),
          text => theme.fg('muted', text),
          `Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s... (${keyText('app.interrupt')} to cancel)`
        );
        this.statusContainer.addChild(this.retryLoader);
        this.ui.requestRender();
        break;
      }

      case 'auto_retry_end': {
        if (this.retryEscapeHandler) {
          this.defaultEditor.onEscape = this.retryEscapeHandler;
          this.retryEscapeHandler = undefined;
        }

        if (this.retryLoader) {
          this.retryLoader.stop();
          this.retryLoader = undefined;
          this.statusContainer.clear();
        }

        if (!event.success) {
          this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || 'Unknown error'}`);
        }
        this.ui.requestRender();
        break;
      }
    }
  }

  private getUserMessageText(message: Message): string {
    if (message.role !== 'user') return '';
    const textBlocks =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content.filter((c: { type: string }) => c.type === 'text');
    return textBlocks.map(c => (c as { text: string }).text).join('');
  }

  private helpOverlay: { spacer: any; text: any } | null = null;

  private showHelp(): void {
    if (this.helpOverlay) {
      this.chatContainer.removeChild(this.helpOverlay.spacer);
      this.chatContainer.removeChild(this.helpOverlay.text);
      this.helpOverlay = null;
      this.ui.requestRender();
      return;
    }

    const hint = (keybinding: AppKeybinding, desc: string) => keyHint(keybinding, desc);
    const lines = [
      theme.bold(theme.fg('accent', 'Keyboard Shortcuts')),
      '',
      hint('app.interrupt', 'to interrupt'),
      hint('app.clear', 'to clear'),
      rawKeyHint(`${keyText('app.clear')} twice`, 'to exit'),
      hint('app.exit', 'to exit (empty)'),
      hint('app.suspend', 'to suspend'),
      keyHint('tui.editor.deleteToLineEnd', 'to delete to end'),
      hint('app.thinking.cycle', 'to cycle thinking level'),
      rawKeyHint(`${keyText('app.model.cycleForward')}/${keyText('app.model.cycleBackward')}`, 'to cycle models'),
      hint('app.model.select', 'to select model'),
      hint('app.tools.expand', 'to expand tools'),
      hint('app.thinking.toggle', 'to expand thinking'),
      hint('app.editor.external', 'for external editor'),
      rawKeyHint('/', 'for commands'),
      rawKeyHint('!', 'to run bash'),
      rawKeyHint('!!', 'to run bash (no context)'),
      hint('app.message.followUp', 'to queue follow-up'),
      hint('app.message.dequeue', 'to edit all queued messages'),
      hint('app.clipboard.pasteImage', 'to paste image'),
      rawKeyHint('drop files', 'to attach')
    ];

    const spacer = new Spacer(1);
    const text = new Text(lines.join('\n'), 1, 0);
    this.chatContainer.addChild(spacer);
    this.chatContainer.addChild(text);
    this.helpOverlay = { spacer, text };
    this.ui.requestRender();
  }

  private showStatus(message: string): void {
    const children = this.chatContainer.children;
    const last = children.length > 0 ? children[children.length - 1] : undefined;
    const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

    if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
      this.lastStatusText.setText(theme.fg('dim', message));
      this.ui.requestRender();
      return;
    }

    const spacer = new Spacer(1);
    const text = new Text(theme.fg('dim', message), 1, 0);
    this.chatContainer.addChild(spacer);
    this.chatContainer.addChild(text);
    this.lastStatusSpacer = spacer;
    this.lastStatusText = text;
    this.ui.requestRender();
  }

  private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
    switch (message.role) {
      case 'bashExecution': {
        const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
        if (message.output) {
          component.appendOutput(message.output);
        }
        component.setComplete(
          message.exitCode,
          message.cancelled,
          message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
          message.fullOutputPath
        );
        this.chatContainer.addChild(component);
        break;
      }
      case 'custom': {
        if (message.display) {
          const renderer = this.session.extensionRunner?.getMessageRenderer(message.customType);
          const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
          component.setExpanded(this.toolOutputExpanded);
          this.chatContainer.addChild(component);
        }
        break;
      }
      case 'compactionSummary': {
        this.chatContainer.addChild(new Spacer(1));
        const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
        component.setExpanded(this.toolOutputExpanded);
        this.chatContainer.addChild(component);
        break;
      }
      case 'branchSummary': {
        this.chatContainer.addChild(new Spacer(1));
        const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
        component.setExpanded(this.toolOutputExpanded);
        this.chatContainer.addChild(component);
        break;
      }
      case 'user': {
        const textContent = this.getUserMessageText(message);
        if (textContent) {
          const skillBlock = parseSkillBlock(textContent);
          if (skillBlock) {
            this.chatContainer.addChild(new Spacer(1));
            const component = new SkillInvocationMessageComponent(skillBlock, this.getMarkdownThemeWithSettings());
            component.setExpanded(this.toolOutputExpanded);
            this.chatContainer.addChild(component);

            if (skillBlock.userMessage) {
              const userComponent = new UserMessageComponent(skillBlock.userMessage, this.getMarkdownThemeWithSettings());
              this.chatContainer.addChild(userComponent);
            }
          } else {
            const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
            this.chatContainer.addChild(userComponent);
          }
          if (options?.populateHistory) {
            this.editor.addToHistory?.(textContent);
          }
        }
        break;
      }
      case 'assistant': {
        const assistantComponent = new AssistantMessageComponent(message, this.hideThinkingBlock, this.getMarkdownThemeWithSettings());
        this.chatContainer.addChild(assistantComponent);
        break;
      }
      case 'toolResult': {
        break;
      }
      default: {
        const _exhaustive: never = message;
      }
    }
  }

  private renderSessionContext(sessionContext: SessionContext, options: { updateFooter?: boolean; populateHistory?: boolean } = {}): void {
    this.pendingTools.clear();

    if (options.updateFooter) {
      this.footer.invalidate();
      this.updateEditorBorderColor();
    }

    for (const message of sessionContext.messages) {
      if (message.role === 'assistant') {
        this.addMessageToChat(message);

        for (const content of message.content) {
          if (content.type === 'toolCall') {
            const component = new ToolExecutionComponent(
              content.name,
              content.arguments,
              { showImages: this.settingsManager.getShowImages() },
              this.getRegisteredToolDefinition(content.name),
              this.ui
            );
            component.setExpanded(this.toolOutputExpanded);
            this.chatContainer.addChild(component);

            if (message.stopReason === 'aborted' || message.stopReason === 'error') {
              let errorMessage: string;
              if (message.stopReason === 'aborted') {
                const retryAttempt = this.session.retryAttempt;
                errorMessage = retryAttempt > 0 ? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? 's' : ''}` : 'Operation aborted';
              } else {
                errorMessage = message.errorMessage || 'Error';
              }
              component.updateResult({ content: [{ type: 'text', text: errorMessage }], isError: true });
            } else {
              this.pendingTools.set(content.id, component);
            }
          }
        }
      } else if (message.role === 'toolResult') {
        const component = this.pendingTools.get(message.toolCallId);
        if (component) {
          component.updateResult(message);
          this.pendingTools.delete(message.toolCallId);
        }
      } else {
        this.addMessageToChat(message, options);
      }
    }

    this.pendingTools.clear();
    this.ui.requestRender();
  }

  renderInitialMessages(): void {
    const context = this.sessionManager.buildSessionContext();
    this.renderSessionContext(context, {
      updateFooter: true,
      populateHistory: true
    });

    const allEntries = this.sessionManager.getEntries();
    const compactionCount = allEntries.filter(e => e.type === 'compaction').length;
    if (compactionCount > 0) {
      const times = compactionCount === 1 ? '1 time' : `${compactionCount} times`;
      this.showStatus(`Session compacted ${times}`);
    }
  }

  async getUserInput(): Promise<string> {
    return new Promise(resolve => {
      this.onInputCallback = (text: string) => {
        this.onInputCallback = undefined;
        resolve(text);
      };
    });
  }

  private rebuildChatFromMessages(): void {
    this.chatContainer.clear();
    const context = this.sessionManager.buildSessionContext();
    this.renderSessionContext(context);
  }

  private handleCtrlC(): void {
    const now = Date.now();
    if (now - this.lastSigintTime < 500) {
      void this.shutdown();
    } else {
      this.clearEditor();
      this.lastSigintTime = now;
    }
  }

  private handleCtrlD(): void {
    void this.shutdown();
  }

  private isShuttingDown = false;

  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    const extensionRunner = this.session.extensionRunner;
    if (extensionRunner?.hasHandlers('session_shutdown')) {
      await extensionRunner.emit({
        type: 'session_shutdown'
      });
    }

    await new Promise(resolve => process.nextTick(resolve));

    await this.ui.terminal.drainInput(1000);

    this.stop();
    process.exit(0);
  }

  private async checkShutdownRequested(): Promise<void> {
    if (!this.shutdownRequested) return;
    await this.shutdown();
  }

  private handleCtrlZ(): void {
    const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

    const ignoreSigint = () => {};
    process.on('SIGINT', ignoreSigint);

    process.once('SIGCONT', () => {
      clearInterval(suspendKeepAlive);
      process.removeListener('SIGINT', ignoreSigint);
      this.ui.start();
      this.ui.requestRender(true);
    });

    try {
      this.ui.stop();

      process.kill(0, 'SIGTSTP');
    } catch (error) {
      clearInterval(suspendKeepAlive);
      process.removeListener('SIGINT', ignoreSigint);
      throw error;
    }
  }

  private async handleFollowUp(): Promise<void> {
    const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
    if (!text) return;

    if (this.session.isCompacting) {
      if (this.isExtensionCommand(text)) {
        this.editor.addToHistory?.(text);
        this.editor.setText('');
        await this.session.prompt(text);
      } else {
        this.queueCompactionMessage(text, 'followUp');
      }
      return;
    }

    if (this.session.isStreaming) {
      this.editor.addToHistory?.(text);
      this.editor.setText('');
      await this.session.prompt(text, { streamingBehavior: 'followUp' });
      this.updatePendingMessagesDisplay();
      this.ui.requestRender();
    } else if (this.editor.onSubmit) {
      this.editor.onSubmit(text);
    }
  }

  private handleDequeue(): void {
    const restored = this.restoreQueuedMessagesToEditor();
    if (restored === 0) {
      this.showStatus('No queued messages to restore');
    } else {
      this.showStatus(`Restored ${restored} queued message${restored > 1 ? 's' : ''} to editor`);
    }
  }

  private updateEditorBorderColor(): void {
    if (this.isBashMode) {
      this.editor.borderColor = theme.getBashModeBorderColor();
    } else {
      const level = this.session.thinkingLevel || 'off';
      this.editor.borderColor = theme.getThinkingBorderColor(level);
    }
    this.ui.requestRender();
  }

  private cycleThinkingLevel(): void {
    const newLevel = this.session.cycleThinkingLevel();
    if (newLevel === undefined) {
      this.showStatus('Current model does not support thinking');
    } else {
      this.footer.invalidate();
      this.updateEditorBorderColor();
      this.showStatus(`Thinking level: ${newLevel}`);
    }
  }

  private async cycleModel(direction: 'forward' | 'backward'): Promise<void> {
    try {
      const result = await this.session.cycleModel(direction);
      if (result === undefined) {
        const msg = this.session.scopedModels.length > 0 ? 'Only one model in scope' : 'Only one model available';
        this.showStatus(msg);
      } else {
        this.footer.invalidate();
        this.updateEditorBorderColor();
        const thinkingStr = result.model.reasoning && result.thinkingLevel !== 'off' ? ` (thinking: ${result.thinkingLevel})` : '';
        this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
      }
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private toggleToolOutputExpansion(): void {
    this.setToolsExpanded(!this.toolOutputExpanded);
  }

  private setToolsExpanded(expanded: boolean): void {
    this.toolOutputExpanded = expanded;
    for (const child of this.chatContainer.children) {
      if (isExpandable(child)) {
        child.setExpanded(expanded);
      }
    }
    this.ui.requestRender();
  }

  private toggleThinkingBlockVisibility(): void {
    this.hideThinkingBlock = !this.hideThinkingBlock;
    this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

    this.chatContainer.clear();
    this.rebuildChatFromMessages();

    if (this.streamingComponent && this.streamingMessage) {
      this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
      this.streamingComponent.updateContent(this.streamingMessage);
      this.chatContainer.addChild(this.streamingComponent);
    }

    this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? 'hidden' : 'visible'}`);
  }

  private openExternalEditor(): void {
    const editorCmd = process.env.VISUAL || process.env.EDITOR;
    if (!editorCmd) {
      this.showWarning('No editor configured. Set $VISUAL or $EDITOR environment variable.');
      return;
    }

    const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
    const tmpFile = path.join(os.tmpdir(), `perplx-editor-${Date.now()}.md`);

    try {
      fs.writeFileSync(tmpFile, currentText, 'utf-8');

      this.ui.stop();

      const [editor, ...editorArgs] = editorCmd.split(' ');

      const result = spawnSync(editor, [...editorArgs, tmpFile], {
        stdio: 'inherit',
        shell: process.platform === 'win32'
      });

      if (result.status === 0) {
        const newContent = fs.readFileSync(tmpFile, 'utf-8').replace(/\n$/, '');
        this.editor.setText(newContent);
      }
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}

      this.ui.start();

      this.ui.requestRender(true);
    }
  }

  clearEditor(): void {
    this.editor.setText('');
    this.ui.requestRender();
  }

  showError(errorMessage: string): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(theme.fg('error', `Error: ${errorMessage}`), 1, 0));
    this.ui.requestRender();
  }

  showWarning(warningMessage: string): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(theme.fg('warning', `Warning: ${warningMessage}`), 1, 0));
    this.ui.requestRender();
  }

  private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
    return {
      steering: [...this.session.getSteeringMessages(), ...this.compactionQueuedMessages.filter(msg => msg.mode === 'steer').map(msg => msg.text)],
      followUp: [...this.session.getFollowUpMessages(), ...this.compactionQueuedMessages.filter(msg => msg.mode === 'followUp').map(msg => msg.text)]
    };
  }

  private clearAllQueues(): { steering: string[]; followUp: string[] } {
    const { steering, followUp } = this.session.clearQueue();
    const compactionSteering = this.compactionQueuedMessages.filter(msg => msg.mode === 'steer').map(msg => msg.text);
    const compactionFollowUp = this.compactionQueuedMessages.filter(msg => msg.mode === 'followUp').map(msg => msg.text);
    this.compactionQueuedMessages = [];
    return {
      steering: [...steering, ...compactionSteering],
      followUp: [...followUp, ...compactionFollowUp]
    };
  }

  private updatePendingMessagesDisplay(): void {
    this.pendingMessagesContainer.clear();
    const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
    if (steeringMessages.length > 0 || followUpMessages.length > 0) {
      this.pendingMessagesContainer.addChild(new Spacer(1));
      for (const message of steeringMessages) {
        const text = theme.fg('dim', `Steering: ${message}`);
        this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
      }
      for (const message of followUpMessages) {
        const text = theme.fg('dim', `Follow-up: ${message}`);
        this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
      }
      const dequeueHint = this.getAppKeyDisplay('app.message.dequeue');
      const hintText = theme.fg('dim', `↳ ${dequeueHint} to edit all queued messages`);
      this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
    }
  }

  private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
    const { steering, followUp } = this.clearAllQueues();
    const allQueued = [...steering, ...followUp];
    if (allQueued.length === 0) {
      this.updatePendingMessagesDisplay();
      if (options?.abort) {
        this.agent.abort();
      }
      return 0;
    }
    const queuedText = allQueued.join('\n\n');
    const currentText = options?.currentText ?? this.editor.getText();
    const combinedText = [queuedText, currentText].filter(t => t.trim()).join('\n\n');
    this.editor.setText(combinedText);
    this.updatePendingMessagesDisplay();
    if (options?.abort) {
      this.agent.abort();
    }
    return allQueued.length;
  }

  private queueCompactionMessage(text: string, mode: 'steer' | 'followUp'): void {
    this.compactionQueuedMessages.push({ text, mode });
    this.editor.addToHistory?.(text);
    this.editor.setText('');
    this.updatePendingMessagesDisplay();
    this.showStatus('Queued message for after compaction');
  }

  private isExtensionCommand(text: string): boolean {
    if (!text.startsWith('/')) return false;

    const extensionRunner = this.session.extensionRunner;
    if (!extensionRunner) return false;

    const spaceIndex = text.indexOf(' ');
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return !!extensionRunner.getCommand(commandName);
  }

  private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
    if (this.compactionQueuedMessages.length === 0) {
      return;
    }

    const queuedMessages = [...this.compactionQueuedMessages];
    this.compactionQueuedMessages = [];
    this.updatePendingMessagesDisplay();

    const restoreQueue = (error: unknown) => {
      this.session.clearQueue();
      this.compactionQueuedMessages = queuedMessages;
      this.updatePendingMessagesDisplay();
      this.showError(
        `Failed to send queued message${queuedMessages.length > 1 ? 's' : ''}: ${error instanceof Error ? error.message : String(error)}`
      );
    };

    try {
      if (options?.willRetry) {
        for (const message of queuedMessages) {
          if (this.isExtensionCommand(message.text)) {
            await this.session.prompt(message.text);
          } else if (message.mode === 'followUp') {
            await this.session.followUp(message.text);
          } else {
            await this.session.steer(message.text);
          }
        }
        this.updatePendingMessagesDisplay();
        return;
      }

      const firstPromptIndex = queuedMessages.findIndex(message => !this.isExtensionCommand(message.text));
      if (firstPromptIndex === -1) {
        for (const message of queuedMessages) {
          await this.session.prompt(message.text);
        }
        return;
      }

      const preCommands = queuedMessages.slice(0, firstPromptIndex);
      const firstPrompt = queuedMessages[firstPromptIndex];
      const rest = queuedMessages.slice(firstPromptIndex + 1);

      for (const message of preCommands) {
        await this.session.prompt(message.text);
      }

      const promptPromise = this.session.prompt(firstPrompt.text).catch(error => {
        restoreQueue(error);
      });

      for (const message of rest) {
        if (this.isExtensionCommand(message.text)) {
          await this.session.prompt(message.text);
        } else if (message.mode === 'followUp') {
          await this.session.followUp(message.text);
        } else {
          await this.session.steer(message.text);
        }
      }
      this.updatePendingMessagesDisplay();
      void promptPromise;
    } catch (error) {
      restoreQueue(error);
    }
  }

  private flushPendingBashComponents(): void {
    for (const component of this.pendingBashComponents) {
      this.pendingMessagesContainer.removeChild(component);
      this.chatContainer.addChild(component);
    }
    this.pendingBashComponents = [];
  }

  private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
    const done = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
    };
    const { component, focus } = create(done);
    this.editorContainer.clear();
    this.editorContainer.addChild(component);
    this.ui.setFocus(focus);
    this.ui.requestRender();
  }

  private showSettingsSelector(): void {
    this.showSelector(done => {
      const selector = new SettingsSelectorComponent(
        {
          autoCompact: this.session.autoCompactionEnabled,
          showImages: this.settingsManager.getShowImages(),
          autoResizeImages: this.settingsManager.getImageAutoResize(),
          blockImages: this.settingsManager.getBlockImages(),
          enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
          steeringMode: this.session.steeringMode,
          followUpMode: this.session.followUpMode,
          transport: this.settingsManager.getTransport(),
          thinkingLevel: this.session.thinkingLevel,
          availableThinkingLevels: this.session.getAvailableThinkingLevels(),
          currentTheme: this.settingsManager.getTheme() || 'dark',
          availableThemes: getAvailableThemes(),
          hideThinkingBlock: this.hideThinkingBlock,
          doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
          treeFilterMode: this.settingsManager.getTreeFilterMode(),
          showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
          editorPaddingX: this.settingsManager.getEditorPaddingX(),
          autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
          quietStartup: this.settingsManager.getQuietStartup(),
          clearOnShrink: this.settingsManager.getClearOnShrink()
        },
        {
          onAutoCompactChange: enabled => {
            this.session.setAutoCompactionEnabled(enabled);
            this.footer.setAutoCompactEnabled(enabled);
          },
          onShowImagesChange: enabled => {
            this.settingsManager.setShowImages(enabled);
            for (const child of this.chatContainer.children) {
              if (child instanceof ToolExecutionComponent) {
                child.setShowImages(enabled);
              }
            }
          },
          onAutoResizeImagesChange: enabled => {
            this.settingsManager.setImageAutoResize(enabled);
          },
          onBlockImagesChange: blocked => {
            this.settingsManager.setBlockImages(blocked);
          },
          onEnableSkillCommandsChange: enabled => {
            this.settingsManager.setEnableSkillCommands(enabled);
            this.setupAutocomplete(this.fdPath);
          },
          onSteeringModeChange: mode => {
            this.session.setSteeringMode(mode);
          },
          onFollowUpModeChange: mode => {
            this.session.setFollowUpMode(mode);
          },
          onTransportChange: transport => {
            this.settingsManager.setTransport(transport);
            this.session.agent.setTransport(transport);
          },
          onThinkingLevelChange: level => {
            this.session.setThinkingLevel(level);
            this.footer.invalidate();
            this.updateEditorBorderColor();
          },
          onThemeChange: themeName => {
            const result = setTheme(themeName, true);
            this.settingsManager.setTheme(themeName);
            this.ui.invalidate();
            if (!result.success) {
              this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
            }
          },
          onThemePreview: themeName => {
            const result = setTheme(themeName, true);
            if (result.success) {
              this.ui.invalidate();
              this.ui.requestRender();
            }
          },
          onHideThinkingBlockChange: hidden => {
            this.hideThinkingBlock = hidden;
            this.settingsManager.setHideThinkingBlock(hidden);
            for (const child of this.chatContainer.children) {
              if (child instanceof AssistantMessageComponent) {
                child.setHideThinkingBlock(hidden);
              }
            }
            this.chatContainer.clear();
            this.rebuildChatFromMessages();
          },
          onQuietStartupChange: enabled => {
            this.settingsManager.setQuietStartup(enabled);
          },
          onDoubleEscapeActionChange: action => {
            this.settingsManager.setDoubleEscapeAction(action);
          },
          onTreeFilterModeChange: mode => {
            this.settingsManager.setTreeFilterMode(mode);
          },
          onShowHardwareCursorChange: enabled => {
            this.settingsManager.setShowHardwareCursor(enabled);
            this.ui.setShowHardwareCursor(enabled);
          },
          onEditorPaddingXChange: padding => {
            this.settingsManager.setEditorPaddingX(padding);
            this.defaultEditor.setPaddingX(padding);
            if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
              this.editor.setPaddingX(padding);
            }
          },
          onAutocompleteMaxVisibleChange: maxVisible => {
            this.settingsManager.setAutocompleteMaxVisible(maxVisible);
            this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
            if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
              this.editor.setAutocompleteMaxVisible(maxVisible);
            }
          },
          onClearOnShrinkChange: enabled => {
            this.settingsManager.setClearOnShrink(enabled);
            this.ui.setClearOnShrink(enabled);
          },
          onCancel: () => {
            done();
            this.ui.requestRender();
          }
        }
      );
      return { component: selector, focus: selector.getSettingsList() };
    });
  }

  private async handleModelCommand(searchTerm?: string): Promise<void> {
    if (!searchTerm) {
      this.showModelSelector();
      return;
    }

    const model = await this.findExactModelMatch(searchTerm);
    if (model) {
      try {
        await this.session.setModel(model);
        this.footer.invalidate();
        this.updateEditorBorderColor();
        this.showStatus(`Model: ${model.id}`);
      } catch (error) {
        this.showError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    this.showModelSelector(searchTerm);
  }

  private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
    const models = await this.getModelCandidates();
    return findExactModelReferenceMatch(searchTerm, models);
  }

  private async getModelCandidates(): Promise<Model<any>[]> {
    if (this.session.scopedModels.length > 0) {
      return this.session.scopedModels.map(scoped => scoped.model);
    }

    this.session.modelRegistry.refresh();
    try {
      return await this.session.modelRegistry.getAvailable();
    } catch {
      return [];
    }
  }

  private async updateAvailableProviderCount(): Promise<void> {
    const models = await this.getModelCandidates();
    const uniqueProviders = new Set(models.map(m => m.provider));
    this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
  }

  private showModelSelector(initialSearchInput?: string): void {
    this.showSelector(done => {
      const selector = new ModelSelectorComponent(
        this.ui,
        this.session.model,
        this.settingsManager,
        this.session.modelRegistry,
        this.session.scopedModels,
        async model => {
          try {
            await this.session.setModel(model);
            this.footer.invalidate();
            this.updateEditorBorderColor();
            done();
            this.showStatus(`Model: ${model.id}`);
          } catch (error) {
            done();
            this.showError(error instanceof Error ? error.message : String(error));
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
        initialSearchInput
      );
      return { component: selector, focus: selector };
    });
  }

  private showUserMessageSelector(): void {
    const userMessages = this.session.getUserMessagesForForking();

    if (userMessages.length === 0) {
      this.showStatus('No messages to fork from');
      return;
    }

    this.showSelector(done => {
      const selector = new UserMessageSelectorComponent(
        userMessages.map(m => ({ id: m.entryId, text: m.text })),
        async entryId => {
          const result = await this.session.fork(entryId);
          if (result.cancelled) {
            done();
            this.ui.requestRender();
            return;
          }

          this.chatContainer.clear();
          this.renderInitialMessages();
          this.editor.setText(result.selectedText);
          done();
          this.showStatus('Branched to new session');
        },
        () => {
          done();
          this.ui.requestRender();
        }
      );
      return { component: selector, focus: selector.getMessageList() };
    });
  }

  private showTreeSelector(initialSelectedId?: string): void {
    const tree = this.sessionManager.getTree();
    const realLeafId = this.sessionManager.getLeafId();
    const initialFilterMode = this.settingsManager.getTreeFilterMode();

    if (tree.length === 0) {
      this.showStatus('No entries in session');
      return;
    }

    this.showSelector(done => {
      const selector = new TreeSelectorComponent(
        tree,
        realLeafId,
        this.ui.terminal.rows,
        async entryId => {
          if (entryId === realLeafId) {
            done();
            this.showStatus('Already at this point');
            return;
          }

          done();

          const wantsSummary = false;
          const customInstructions: string | undefined = undefined;

          let summaryLoader: Loader | undefined;
          const originalOnEscape = this.defaultEditor.onEscape;

          if (wantsSummary) {
            this.defaultEditor.onEscape = () => {
              this.session.abortBranchSummary();
            };
            this.chatContainer.addChild(new Spacer(1));
            summaryLoader = new Loader(
              this.ui,
              spinner => theme.fg('accent', spinner),
              text => theme.fg('muted', text),
              `Summarizing branch... (${keyText('app.interrupt')} to cancel)`
            );
            this.statusContainer.addChild(summaryLoader);
            this.ui.requestRender();
          }

          try {
            const result = await this.session.navigateTree(entryId, {
              summarize: wantsSummary,
              customInstructions
            });

            if (result.aborted) {
              this.showStatus('Branch summarization cancelled');
              this.showTreeSelector(entryId);
              return;
            }
            if (result.cancelled) {
              this.showStatus('Navigation cancelled');
              return;
            }

            this.chatContainer.clear();
            this.renderInitialMessages();
            if (result.editorText && !this.editor.getText().trim()) {
              this.editor.setText(result.editorText);
            }
            this.showStatus('Navigated to selected point');
          } catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
          } finally {
            if (summaryLoader) {
              summaryLoader.stop();
              this.statusContainer.clear();
            }
            this.defaultEditor.onEscape = originalOnEscape;
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
        (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
          this.ui.requestRender();
        },
        initialSelectedId,
        initialFilterMode
      );
      return { component: selector, focus: selector };
    });
  }

  private showSessionSelector(): void {
    this.showSelector(done => {
      const selector = new SessionSelectorComponent(
        onProgress => SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
        SessionManager.listAll,
        async sessionPath => {
          done();
          await this.handleResumeSession(sessionPath);
        },
        () => {
          done();
          this.ui.requestRender();
        },
        () => {
          void this.shutdown();
        },
        () => this.ui.requestRender(),
        {
          renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
            const next = (nextName ?? '').trim();
            if (!next) return;
            const mgr = SessionManager.open(sessionFilePath);
            mgr.appendSessionInfo(next);
          },
          showRenameHint: true,
          keybindings: this.keybindings
        },

        this.sessionManager.getSessionFile()
      );
      return { component: selector, focus: selector };
    });
  }

  private async handleResumeSession(sessionPath: string): Promise<void> {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.statusContainer.clear();

    this.pendingMessagesContainer.clear();
    this.compactionQueuedMessages = [];
    this.streamingComponent = undefined;
    this.streamingMessage = undefined;
    this.pendingTools.clear();

    await this.session.switchSession(sessionPath);

    this.chatContainer.clear();
    this.renderInitialMessages();
    this.showStatus('Resumed session');
  }

  private async handleReloadCommand(): Promise<void> {
    if (this.session.isStreaming) {
      this.showWarning('Wait for the current response to finish before reloading.');
      return;
    }
    if (this.session.isCompacting) {
      this.showWarning('Wait for compaction to finish before reloading.');
      return;
    }

    this.resetExtensionUI();

    const loader = new BorderedLoader(this.ui, theme, 'Reloading keybindings, extensions, skills, prompts, themes...', {
      cancellable: false
    });
    const previousEditor = this.editor;
    this.editorContainer.clear();
    this.editorContainer.addChild(loader);
    this.ui.setFocus(loader);
    this.ui.requestRender();

    const dismissLoader = (editor: Component) => {
      loader.dispose();
      this.editorContainer.clear();
      this.editorContainer.addChild(editor);
      this.ui.setFocus(editor);
      this.ui.requestRender();
    };

    try {
      await this.session.reload();
      this.keybindings.reload();
      setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
      this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
      const themeName = this.settingsManager.getTheme();
      const themeResult = themeName ? setTheme(themeName, true) : { success: true };
      if (!themeResult.success) {
        this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
      }
      const editorPaddingX = this.settingsManager.getEditorPaddingX();
      const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
      this.defaultEditor.setPaddingX(editorPaddingX);
      this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
      if (this.editor !== this.defaultEditor) {
        this.editor.setPaddingX?.(editorPaddingX);
        this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
      }
      this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
      this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
      this.setupAutocomplete(this.fdPath);
      const runner = this.session.extensionRunner;
      if (runner) {
        this.setupExtensionShortcuts(runner);
      }
      this.rebuildChatFromMessages();
      dismissLoader(this.editor as Component);
      this.showLoadedResources({
        extensionPaths: runner?.getExtensionPaths() ?? [],
        force: false,
        showDiagnosticsWhenQuiet: true
      });
      const modelsJsonError = this.session.modelRegistry.getError();
      if (modelsJsonError) {
        this.showError(`models.json error: ${modelsJsonError}`);
      }
      this.showStatus('Reloaded keybindings, extensions, skills, prompts, themes');
    } catch (error) {
      dismissLoader(previousEditor as Component);
      this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleShareCommand(): Promise<void> {
    const sessionPath = this.sessionManager.getSessionFile();
    if (!sessionPath || !fs.existsSync(sessionPath)) {
      this.showError('No session file to share.');
      return;
    }

    const loader = new BorderedLoader(this.ui, theme, 'Uploading session...');
    this.editorContainer.clear();
    this.editorContainer.addChild(loader);
    this.ui.setFocus(loader);
    this.ui.requestRender();

    const restoreEditor = () => {
      loader.dispose();
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
    };

    let aborted = false;
    const controller = new AbortController();
    loader.onAbort = () => {
      aborted = true;
      controller.abort();
      restoreEditor();
      this.showStatus('Share cancelled');
    };

    try {
      const body = fs.readFileSync(sessionPath);
      const { getShareApiUrl } = await import('../../config.js');
      const res = await fetch(getShareApiUrl(), {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: controller.signal
      });

      if (aborted) return;
      restoreEditor();

      if (!res.ok) {
        const err = await res.text().catch(() => 'Unknown error');
        this.showError(`Upload failed (${res.status}): ${err}`);
        return;
      }

      const { id } = (await res.json()) as { id: string };
      const url = getShareViewerUrl(id);
      try {
        await copyToClipboard(url);
        this.showStatus(`Shared! URL copied to clipboard:\n${url}`);
      } catch {
        this.showStatus(`Shared!\n${url}`);
      }
    } catch (error: unknown) {
      if (!aborted) {
        restoreEditor();
        this.showError(`Failed to share: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  private async handleCopyCommand(): Promise<void> {
    const text = this.session.getLastAssistantText();
    if (!text) {
      this.showError('No agent messages to copy yet.');
      return;
    }

    try {
      await copyToClipboard(text);
      this.showStatus('Copied last agent message to clipboard');
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private handleNameCommand(text: string): void {
    const name = text.replace(/^\/name\s*/, '').trim();
    if (!name) {
      const currentName = this.sessionManager.getSessionName();
      if (currentName) {
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new Text(theme.fg('dim', `Session name: ${currentName}`), 1, 0));
      } else {
        this.showWarning('Usage: /name <name>');
      }
      this.ui.requestRender();
      return;
    }

    this.sessionManager.appendSessionInfo(name);
    this.updateTerminalTitle();
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(theme.fg('dim', `Session name set: ${name}`), 1, 0));
    this.ui.requestRender();
  }

  private handleSessionCommand(): void {
    const stats = this.session.getSessionStats();
    const sessionName = this.sessionManager.getSessionName();

    let info = `${theme.bold('Session Info')}\n\n`;
    if (sessionName) {
      info += `${theme.fg('dim', 'Name:')} ${sessionName}\n`;
    }
    info += `${theme.fg('dim', 'File:')} ${stats.sessionFile ?? 'In-memory'}\n`;
    info += `${theme.fg('dim', 'ID:')} ${stats.sessionId}\n\n`;
    info += `${theme.bold('Messages')}\n`;
    info += `${theme.fg('dim', 'User:')} ${stats.userMessages}\n`;
    info += `${theme.fg('dim', 'Assistant:')} ${stats.assistantMessages}\n`;
    info += `${theme.fg('dim', 'Tool Calls:')} ${stats.toolCalls}\n`;
    info += `${theme.fg('dim', 'Tool Results:')} ${stats.toolResults}\n`;
    info += `${theme.fg('dim', 'Total:')} ${stats.totalMessages}\n\n`;
    info += `${theme.bold('Tokens')}\n`;
    info += `${theme.fg('dim', 'Input:')} ${stats.tokens.input.toLocaleString()}\n`;
    info += `${theme.fg('dim', 'Output:')} ${stats.tokens.output.toLocaleString()}\n`;
    if (stats.tokens.cacheRead > 0) {
      info += `${theme.fg('dim', 'Cache Read:')} ${stats.tokens.cacheRead.toLocaleString()}\n`;
    }
    if (stats.tokens.cacheWrite > 0) {
      info += `${theme.fg('dim', 'Cache Write:')} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
    }
    info += `${theme.fg('dim', 'Total:')} ${stats.tokens.total.toLocaleString()}\n`;

    if (stats.cost > 0) {
      info += `\n${theme.bold('Cost')}\n`;
      info += `${theme.fg('dim', 'Total:')} ${stats.cost.toFixed(4)}`;
    }

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(info, 1, 0));
    this.ui.requestRender();
  }

  private capitalizeKey(key: string): string {
    return key
      .split('/')
      .map(k =>
        k
          .split('+')
          .map(part => part.charAt(0).toUpperCase() + part.slice(1))
          .join('+')
      )
      .join('/');
  }

  private getAppKeyDisplay(action: AppKeybinding): string {
    return this.capitalizeKey(keyText(action));
  }

  private getEditorKeyDisplay(action: Keybinding): string {
    return this.capitalizeKey(keyText(action));
  }

  private handleHotkeysCommand(): void {
    const cursorUp = this.getEditorKeyDisplay('tui.editor.cursorUp');
    const cursorDown = this.getEditorKeyDisplay('tui.editor.cursorDown');
    const cursorLeft = this.getEditorKeyDisplay('tui.editor.cursorLeft');
    const cursorRight = this.getEditorKeyDisplay('tui.editor.cursorRight');
    const cursorWordLeft = this.getEditorKeyDisplay('tui.editor.cursorWordLeft');
    const cursorWordRight = this.getEditorKeyDisplay('tui.editor.cursorWordRight');
    const cursorLineStart = this.getEditorKeyDisplay('tui.editor.cursorLineStart');
    const cursorLineEnd = this.getEditorKeyDisplay('tui.editor.cursorLineEnd');
    const jumpForward = this.getEditorKeyDisplay('tui.editor.jumpForward');
    const jumpBackward = this.getEditorKeyDisplay('tui.editor.jumpBackward');
    const pageUp = this.getEditorKeyDisplay('tui.editor.pageUp');
    const pageDown = this.getEditorKeyDisplay('tui.editor.pageDown');

    const submit = this.getEditorKeyDisplay('tui.input.submit');
    const newLine = this.getEditorKeyDisplay('tui.input.newLine');
    const deleteWordBackward = this.getEditorKeyDisplay('tui.editor.deleteWordBackward');
    const deleteWordForward = this.getEditorKeyDisplay('tui.editor.deleteWordForward');
    const deleteToLineStart = this.getEditorKeyDisplay('tui.editor.deleteToLineStart');
    const deleteToLineEnd = this.getEditorKeyDisplay('tui.editor.deleteToLineEnd');
    const yank = this.getEditorKeyDisplay('tui.editor.yank');
    const yankPop = this.getEditorKeyDisplay('tui.editor.yankPop');
    const undo = this.getEditorKeyDisplay('tui.editor.undo');
    const tab = this.getEditorKeyDisplay('tui.input.tab');

    const interrupt = this.getAppKeyDisplay('app.interrupt');
    const clear = this.getAppKeyDisplay('app.clear');
    const exit = this.getAppKeyDisplay('app.exit');
    const suspend = this.getAppKeyDisplay('app.suspend');
    const cycleThinkingLevel = this.getAppKeyDisplay('app.thinking.cycle');
    const cycleModelForward = this.getAppKeyDisplay('app.model.cycleForward');
    const selectModel = this.getAppKeyDisplay('app.model.select');
    const expandTools = this.getAppKeyDisplay('app.tools.expand');
    const toggleThinking = this.getAppKeyDisplay('app.thinking.toggle');
    const externalEditor = this.getAppKeyDisplay('app.editor.external');
    const cycleModelBackward = this.getAppKeyDisplay('app.model.cycleBackward');
    const followUp = this.getAppKeyDisplay('app.message.followUp');
    const dequeue = this.getAppKeyDisplay('app.message.dequeue');
    const pasteImage = this.getAppKeyDisplay('app.clipboard.pasteImage');

    let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === 'win32' ? ' (Ctrl+Enter on Windows Terminal)' : ''} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

    const extensionRunner = this.session.extensionRunner;
    if (extensionRunner) {
      const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
      if (shortcuts.size > 0) {
        hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
        for (const [key, shortcut] of shortcuts) {
          const description = shortcut.description ?? shortcut.extensionPath;
          const keyDisplay = key.replace(/\b\w/g, c => c.toUpperCase());
          hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
        }
      }
    }

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DynamicBorder());
    this.chatContainer.addChild(new Text(theme.bold(theme.fg('accent', 'Keyboard Shortcuts')), 1, 0));
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
    this.chatContainer.addChild(new DynamicBorder());
    this.ui.requestRender();
  }

  private async handleClearCommand(): Promise<void> {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.statusContainer.clear();

    await this.session.newSession();

    this.headerContainer.clear();
    this.chatContainer.clear();
    this.pendingMessagesContainer.clear();
    this.compactionQueuedMessages = [];
    this.streamingComponent = undefined;
    this.streamingMessage = undefined;
    this.pendingTools.clear();

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(`${theme.fg('accent', '✓ New session started')}`, 1, 1));
    this.ui.requestRender();
  }

  private handleDebugCommand(): void {
    const width = this.ui.terminal.columns;
    const height = this.ui.terminal.rows;
    const allLines = this.ui.render(width);

    const debugLogPath = getDebugLogPath();
    const debugData = [
      `Debug output at ${new Date().toISOString()}`,
      `Terminal: ${width}x${height}`,
      `Total lines: ${allLines.length}`,
      '',
      '=== All rendered lines with visible widths ===',
      ...allLines.map((line, idx) => {
        const vw = visibleWidth(line);
        const escaped = JSON.stringify(line);
        return `[${idx}] (w=${vw}) ${escaped}`;
      }),
      '',
      '=== Agent messages (JSONL) ===',
      ...this.session.messages.map(msg => JSON.stringify(msg)),
      ''
    ].join('\n');

    fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
    fs.writeFileSync(debugLogPath, debugData);

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(`${theme.fg('accent', '✓ Debug log written')}\n${theme.fg('muted', debugLogPath)}`, 1, 1));
    this.ui.requestRender();
  }

  private handleArminSaysHi(): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new ArminComponent(this.ui));
    this.ui.requestRender();
  }

  private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
    const extensionRunner = this.session.extensionRunner;

    const eventResult = extensionRunner
      ? await extensionRunner.emitUserBash({
          type: 'user_bash',
          command,
          excludeFromContext,
          cwd: process.cwd()
        })
      : undefined;

    if (eventResult?.result) {
      const result = eventResult.result;

      this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
      if (this.session.isStreaming) {
        this.pendingMessagesContainer.addChild(this.bashComponent);
        this.pendingBashComponents.push(this.bashComponent);
      } else {
        this.chatContainer.addChild(this.bashComponent);
      }

      if (result.output) {
        this.bashComponent.appendOutput(result.output);
      }
      this.bashComponent.setComplete(
        result.exitCode,
        result.cancelled,
        result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
        result.fullOutputPath
      );

      this.session.recordBashResult(command, result, { excludeFromContext });
      this.bashComponent = undefined;
      this.ui.requestRender();
      return;
    }

    const isDeferred = this.session.isStreaming;
    this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

    if (isDeferred) {
      this.pendingMessagesContainer.addChild(this.bashComponent);
      this.pendingBashComponents.push(this.bashComponent);
    } else {
      this.chatContainer.addChild(this.bashComponent);
    }
    this.ui.requestRender();

    try {
      const result = await this.session.executeBash(
        command,
        chunk => {
          if (this.bashComponent) {
            this.bashComponent.appendOutput(chunk);
            this.ui.requestRender();
          }
        },
        { excludeFromContext, operations: eventResult?.operations }
      );

      if (this.bashComponent) {
        this.bashComponent.setComplete(
          result.exitCode,
          result.cancelled,
          result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
          result.fullOutputPath
        );
      }
    } catch (error) {
      if (this.bashComponent) {
        this.bashComponent.setComplete(undefined, false);
      }
      this.showError(`Bash command failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    this.bashComponent = undefined;
    this.ui.requestRender();
  }

  private async handleCompactCommand(customInstructions?: string): Promise<void> {
    const entries = this.sessionManager.getEntries();
    const messageCount = entries.filter(e => e.type === 'message').length;

    if (messageCount < 2) {
      this.showWarning('Nothing to compact (no messages yet)');
      return;
    }

    await this.executeCompaction(customInstructions, false);
  }

  private async executeCompaction(customInstructions?: string, isAuto = false): Promise<CompactionResult | undefined> {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.statusContainer.clear();

    const originalOnEscape = this.defaultEditor.onEscape;
    this.defaultEditor.onEscape = () => {
      this.session.abortCompaction();
    };

    this.chatContainer.addChild(new Spacer(1));
    const cancelHint = `(${keyText('app.interrupt')} to cancel)`;
    const label = isAuto ? `Auto-compacting context... ${cancelHint}` : `Compacting context... ${cancelHint}`;
    const compactingLoader = new Loader(
      this.ui,
      spinner => theme.fg('accent', spinner),
      text => theme.fg('muted', text),
      label
    );
    this.statusContainer.addChild(compactingLoader);
    this.ui.requestRender();

    let result: CompactionResult | undefined;

    try {
      result = await this.session.compact(customInstructions);

      this.rebuildChatFromMessages();

      const msg = createCompactionSummaryMessage(result.summary, result.tokensBefore, new Date().toISOString());
      this.addMessageToChat(msg);

      this.footer.invalidate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Compaction cancelled' || (error instanceof Error && error.name === 'AbortError')) {
        this.showError('Compaction cancelled');
      } else {
        this.showError(`Compaction failed: ${message}`);
      }
    } finally {
      compactingLoader.stop();
      this.statusContainer.clear();
      this.defaultEditor.onEscape = originalOnEscape;
    }
    void this.flushCompactionQueue({ willRetry: false });
    return result;
  }

  stop(): void {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.clearExtensionTerminalInputListeners();
    this.footer.dispose();
    this.footerDataProvider.dispose();
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    if (this.isInitialized) {
      this.ui.stop();
      this.isInitialized = false;
    }
  }
}
