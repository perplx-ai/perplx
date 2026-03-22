import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import { type Api, type Model, modelsAreEqual } from '@mariozechner/pi-ai';
import chalk from 'chalk';
import { minimatch } from 'minimatch';
import { isValidThinkingLevel } from '../cli/args.js';
import { DEFAULT_THINKING_LEVEL } from '../config.js';
import type { ModelRegistry } from './model-registry.js';

const defaultModelPerProvider: Record<string, string> = {
	perplexity: 'smart',
};

export interface ScopedModel {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
}

export function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const ref = modelReference.trim().toLowerCase();
  if (!ref) return undefined;

  const match = availableModels.filter(m => m.id.toLowerCase() === ref || `${m.provider}/${m.id}`.toLowerCase() === ref);
  return match.length === 1 ? match[0] : undefined;
}

function tryMatchModel(pattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const exact = findExactModelReferenceMatch(pattern, availableModels);
  if (exact) return exact;

  const matches = availableModels.filter(
    m => m.id.toLowerCase().includes(pattern.toLowerCase()) || m.name?.toLowerCase().includes(pattern.toLowerCase())
  );

  if (matches.length === 0) return undefined;

  matches.sort((a, b) => b.id.localeCompare(a.id));
  return matches[0];
}

function parseModelPattern(
  pattern: string,
  availableModels: Model<Api>[]
): { model: Model<Api> | undefined; thinkingLevel?: ThinkingLevel; warning: string | undefined } {
  const exactMatch = tryMatchModel(pattern, availableModels);
  if (exactMatch) {
    return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
  }

  const lastColonIndex = pattern.lastIndexOf(':');
  if (lastColonIndex === -1) {
    return { model: undefined, thinkingLevel: undefined, warning: undefined };
  }

  const prefix = pattern.substring(0, lastColonIndex);
  const suffix = pattern.substring(lastColonIndex + 1);

  if (isValidThinkingLevel(suffix)) {
    const result = parseModelPattern(prefix, availableModels);
    if (result.model) {
      return {
        model: result.model,
        thinkingLevel: result.warning ? undefined : suffix,
        warning: result.warning
      };
    }
    return result;
  }

  return { model: undefined, thinkingLevel: undefined, warning: undefined };
}

export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]> {
  const availableModels = await modelRegistry.getAvailable();
  const scopedModels: ScopedModel[] = [];

  for (const pattern of patterns) {
    if (pattern.includes('*') || pattern.includes('?') || pattern.includes('[')) {
      const globModels = availableModels.filter(
        m => minimatch(m.id, pattern, { nocase: true }) || minimatch(`${m.provider}/${m.id}`, pattern, { nocase: true })
      );

      for (const model of globModels) {
        if (!scopedModels.some(s => modelsAreEqual(s.model, model))) {
          scopedModels.push({ model });
        }
      }
    } else {
      const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);
      if (model && !scopedModels.some(s => modelsAreEqual(s.model, model))) {
        scopedModels.push({ model, thinkingLevel });
      }
      if (warning) {
        console.error(chalk.yellow(`Warning: ${warning}`));
      }
    }
  }

  return scopedModels;
}

export async function findInitialModel(options: {
  cliProvider?: string;
  cliModel?: string;
  scopedModels: ScopedModel[];
  isContinuing: boolean;
  defaultProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: ThinkingLevel;
  modelRegistry: ModelRegistry;
}): Promise<{ model: Model<Api> | undefined; thinkingLevel: ThinkingLevel; fallbackMessage: string | undefined }> {
  const { cliModel, scopedModels, isContinuing, defaultProvider, defaultModelId, defaultThinkingLevel, modelRegistry } = options;

  if (cliModel) {
    const availableModels = modelRegistry.getAll();
    const { model } = parseModelPattern(cliModel, availableModels);
    if (model) {
      return { model, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
    }
  }

  if (scopedModels.length > 0 && !isContinuing) {
    return {
      model: scopedModels[0].model,
      thinkingLevel: scopedModels[0].thinkingLevel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
      fallbackMessage: undefined
    };
  }

  if (defaultProvider && defaultModelId) {
    const found = modelRegistry.find(defaultProvider, defaultModelId);
    if (found && (await modelRegistry.getApiKey(found))) {
      return {
        model: found,
        thinkingLevel: defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
        fallbackMessage: undefined
      };
    }
  }

  const availableModels = await modelRegistry.getAvailable();
  if (availableModels.length > 0) {
    return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
  }

  return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}


