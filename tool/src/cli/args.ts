import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import chalk from 'chalk';
import { CLI_NAME } from '../config.js';

export type Mode = 'text' | 'json';

export interface Args {
  continue?: boolean;
  resume?: boolean;
  help?: boolean;
  version?: boolean;
  mode?: Mode;
  extensions?: string[];
  noExtensions?: boolean;
  print?: boolean;
  noSkills?: boolean;
  skills?: string[];
  promptTemplates?: string[];
  noPromptTemplates?: boolean;
  themes?: string[];
  noThemes?: boolean;
  verbose?: boolean;
  messages: string[];
  fileArgs: string[];

  unknownFlags: Map<string, boolean | string>;
}

const VALID_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
  return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(args: string[], extensionFlags?: Map<string, { type: 'boolean' | 'string' }>): Args {
  const result: Args = {
    messages: [],
    fileArgs: [],
    unknownFlags: new Map()
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.version = true;
    } else if (arg === '--mode' && i + 1 < args.length) {
      const mode = args[++i];
      if (mode === 'text' || mode === 'json') {
        result.mode = mode;
      }
    } else if (arg === '--continue' || arg === '-c') {
      result.continue = true;
    } else if (arg === '--resume' || arg === '-r') {
      result.resume = true;
    } else if (arg === '--print' || arg === '-p') {
      result.print = true;
    } else if ((arg === '--extension' || arg === '-e') && i + 1 < args.length) {
      result.extensions = result.extensions ?? [];
      result.extensions.push(args[++i]);
    } else if (arg === '--no-extensions' || arg === '-ne') {
      result.noExtensions = true;
    } else if (arg === '--skill' && i + 1 < args.length) {
      result.skills = result.skills ?? [];
      result.skills.push(args[++i]);
    } else if (arg === '--prompt-template' && i + 1 < args.length) {
      result.promptTemplates = result.promptTemplates ?? [];
      result.promptTemplates.push(args[++i]);
    } else if (arg === '--theme' && i + 1 < args.length) {
      result.themes = result.themes ?? [];
      result.themes.push(args[++i]);
    } else if (arg === '--no-skills' || arg === '-ns') {
      result.noSkills = true;
    } else if (arg === '--no-prompt-templates' || arg === '-np') {
      result.noPromptTemplates = true;
    } else if (arg === '--no-themes') {
      result.noThemes = true;
    } else if (arg === '--verbose') {
      result.verbose = true;
    } else if (arg.startsWith('@')) {
      result.fileArgs.push(arg.slice(1));
    } else if (arg.startsWith('--') && extensionFlags) {
      const flagName = arg.slice(2);
      const extFlag = extensionFlags.get(flagName);
      if (extFlag) {
        if (extFlag.type === 'boolean') {
          result.unknownFlags.set(flagName, true);
        } else if (extFlag.type === 'string' && i + 1 < args.length) {
          result.unknownFlags.set(flagName, args[++i]);
        }
      }
    } else if (!arg.startsWith('-')) {
      result.messages.push(arg);
    }
  }

  return result;
}

export function printHelp(): void {
  console.log(`${chalk.bold(CLI_NAME)} - Perplexity code: AI coding agent powered by the Perplexity Agent API

${chalk.bold('Usage:')}
  ${CLI_NAME} [options] [@files...] [messages...]

${chalk.bold('Options:')}
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --help, -h                     Show this help
  --version, -v                  Show version number
`);
}
