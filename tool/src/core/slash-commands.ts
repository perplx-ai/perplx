export type SlashCommandSource = 'extension' | 'prompt' | 'skill';
export type SlashCommandLocation = 'user' | 'project' | 'path';

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: SlashCommandSource;
  location?: SlashCommandLocation;
  path?: string;
}

export interface BuiltinSlashCommand {
  name: string;
  description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model (opens selector UI)' },
  { name: 'share', description: 'Share session publicly via share.perplx.net' },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'fork', description: 'Create a new fork from a previous message' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'logout', description: 'Log out of Perplexity' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload keybindings, prompts, and themes' },
  { name: 'quit', description: 'Quit perplx' }
];
