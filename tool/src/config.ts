import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const isBunBinary = import.meta.url.includes('$bunfs') || import.meta.url.includes('~BUN') || import.meta.url.includes('%7EBUN');

export function getThemesDir(): string {
  return join(dirname(process.execPath), 'theme');
}

export const APP_NAME: string = 'perplx code';
export const CLI_NAME: string = 'perplx';

export const CONFIG_DIR_NAME: string = '.perplx';
export const VERSION: string = '0.0.46';

export function getShareViewerUrl(sessionId: string): string {
  return `https://share.perplx.net/${sessionId}`;
}

export function getShareApiUrl(): string {
  return 'https://share.perplx.net/api/upload';
}

export function getAgentDir(): string {
  return join(homedir(), CONFIG_DIR_NAME, 'agent');
}

export function getCustomThemesDir(): string {
  return join(getAgentDir(), 'themes');
}

export function getModelsPath(): string {
  return join(getAgentDir(), 'models.json');
}

export function getAuthPath(): string {
  return join(getAgentDir(), 'auth.json');
}

export function getSettingsPath(): string {
  return join(getAgentDir(), 'settings.json');
}

export function getBinDir(): string {
  return join(getAgentDir(), 'bin');
}

export function getPromptsDir(): string {
  return join(getAgentDir(), 'prompts');
}

export function getSessionsDir(): string {
  return join(getAgentDir(), 'sessions');
}

export function getDebugLogPath(): string {
  return join(getAgentDir(), `${APP_NAME}-debug.log`);
}

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
export const DEFAULT_PERPLEXITY_MODEL = 'smart';
