import { type ImageContent, modelsAreEqual } from '@mariozechner/pi-ai';
import chalk from 'chalk';
import { type Args, parseArgs, printHelp } from './cli/args.js';
import { processFileArguments } from './cli/file-processor.js';
import { buildInitialMessage } from './cli/initial-message.js';
import { selectSession } from './cli/session-picker.js';
import { getAgentDir, getModelsPath, VERSION } from './config.js';
import { AuthStorage } from './core/auth-storage.js';
import { migrateKeybindingsConfigFile } from './core/keybindings.js';
import { ModelRegistry } from './core/model-registry.js';
import { resolveModelScope, type ScopedModel } from './core/model-resolver.js';
import { DefaultResourceLoader } from './core/resource-loader.js';
import { type CreateAgentSessionOptions, createAgentSession } from './core/sdk.js';
import { SessionManager } from './core/session-manager.js';
import { SettingsManager } from './core/settings-manager.js';
import { InteractiveMode, runPrintMode } from './modes/index.js';
import { initTheme, stopThemeWatcher } from './modes/interactive/theme/theme.js';
import { registerPerplexityProvider, createWebSearchTool } from './providers/index.js';

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data.trim() || undefined);
    });
    process.stdin.resume();
  });
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
  const errors = settingsManager.drainErrors();
  for (const { scope, error } of errors) {
    console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
    if (error.stack) {
      console.error(chalk.dim(error.stack));
    }
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

async function prepareInitialMessage(
  parsed: Args,
  autoResizeImages: boolean,
  stdinContent?: string
): Promise<{
  initialMessage?: string;
  initialImages?: ImageContent[];
}> {
  if (parsed.fileArgs.length === 0) {
    return buildInitialMessage({ parsed, stdinContent });
  }

  const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
  return buildInitialMessage({
    parsed,
    fileText: text,
    fileImages: images,
    stdinContent
  });
}

function createSessionManager(parsed: Args, cwd: string): SessionManager | undefined {
  if (parsed.continue) {
    return SessionManager.continueRecent(cwd);
  }

  return undefined;
}

function buildSessionOptions(
  parsed: Args,
  scopedModels: ScopedModel[],
  sessionManager: SessionManager | undefined,
  modelRegistry: ModelRegistry,
  settingsManager: SettingsManager
): { options: CreateAgentSessionOptions } {
  const options: CreateAgentSessionOptions = {};

  if (sessionManager) {
    options.sessionManager = sessionManager;
  }

  if (scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
    const savedProvider = settingsManager.getDefaultProvider();
    const savedModelId = settingsManager.getDefaultModel();
    const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
    const savedInScope = savedModel ? scopedModels.find(sm => modelsAreEqual(sm.model, savedModel)) : undefined;

    if (savedInScope) {
      options.model = savedInScope.model;
      if (savedInScope.thinkingLevel) {
        options.thinkingLevel = savedInScope.thinkingLevel;
      }
    } else {
      options.model = scopedModels[0].model;
      if (scopedModels[0].thinkingLevel) {
        options.thinkingLevel = scopedModels[0].thinkingLevel;
      }
    }
  }

  if (scopedModels.length > 0) {
    options.scopedModels = scopedModels.map(sm => ({
      model: sm.model,
      thinkingLevel: sm.thinkingLevel
    }));
  }

  return { options };
}

export async function main(args: string[]) {
  const firstPass = parseArgs(args);

  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  reportSettingsErrors(settingsManager, 'startup');
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage, getModelsPath());

  registerPerplexityProvider(modelRegistry);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: firstPass.skills,
    additionalPromptTemplatePaths: firstPass.promptTemplates,
    additionalThemePaths: firstPass.themes,
    noSkills: firstPass.noSkills,
    noPromptTemplates: firstPass.noPromptTemplates,
    noThemes: firstPass.noThemes
  });
  await resourceLoader.reload();

  const parsed = parseArgs(args);

  if (parsed.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  let stdinContent: string | undefined;
  stdinContent = await readPipedStdin();
  if (stdinContent !== undefined) {
    parsed.print = true;
  }

  migrateKeybindingsConfigFile(agentDir);

  const { initialMessage, initialImages } = await prepareInitialMessage(parsed, settingsManager.getImageAutoResize(), stdinContent);
  const isInteractive = !parsed.print && parsed.mode === undefined;
  const mode = parsed.mode || 'text';
  initTheme(settingsManager.getTheme(), isInteractive);

  let scopedModels: ScopedModel[] = [];
  const modelPatterns = settingsManager.getEnabledModels();
  if (modelPatterns && modelPatterns.length > 0) {
    scopedModels = await resolveModelScope(modelPatterns, modelRegistry);
  }

  let sessionManager = createSessionManager(parsed, cwd);

  if (parsed.resume) {
    const selectedPath = await selectSession(onProgress => SessionManager.list(cwd, undefined, onProgress), SessionManager.listAll);
    if (!selectedPath) {
      console.log(chalk.dim('No session selected'));
      stopThemeWatcher();
      process.exit(0);
    }
    sessionManager = SessionManager.open(selectedPath);
  }

  const { options: sessionOptions } = buildSessionOptions(parsed, scopedModels, sessionManager, modelRegistry, settingsManager);
  sessionOptions.authStorage = authStorage;
  sessionOptions.modelRegistry = modelRegistry;
  sessionOptions.resourceLoader = resourceLoader;
  sessionOptions.customTools = [createWebSearchTool(modelRegistry)];

  const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);

  if (!isInteractive && !session.model) {
    console.error(chalk.red('No models available.'));
    console.error(chalk.yellow('\nSet an API key environment variable:'));
    console.error('  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.');
    console.error(chalk.yellow(`\nOr create ${getModelsPath()}`));
    process.exit(1);
  }

  if (isInteractive) {
    if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
      const modelList = scopedModels
        .map(sm => {
          const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : '';
          return `${sm.model.id}${thinkingStr}`;
        })
        .join(', ');
      console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray('(Ctrl+P to cycle)')}`));
    }

    const mode = new InteractiveMode(session, {
      modelFallbackMessage,
      initialMessage,
      initialImages,
      initialMessages: parsed.messages,
      verbose: parsed.verbose
    });
    await mode.run();
  } else {
    await runPrintMode(session, {
      mode,
      messages: parsed.messages,
      initialMessage,
      initialImages
    });
    stopThemeWatcher();
    if (process.stdout.writableLength > 0) {
      await new Promise<void>(resolve => process.stdout.once('drain', resolve));
    }
    process.exit(0);
  }
}
