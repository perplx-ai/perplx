import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, join, resolve, sep } from 'path';
import { CONFIG_DIR_NAME, getPromptsDir } from '../config.js';
import { parseFrontmatter } from '../utils/frontmatter.js';

export interface PromptTemplate {
  name: string;
  description: string;
  content: string;
  source: string;
  filePath: string;
}

export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === ' ' || char === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

export function substituteArgs(content: string, args: string[]): string {
  let result = content;

  result = result.replace(/\$(\d+)/g, (_, num) => {
    const index = parseInt(num, 10) - 1;
    return args[index] ?? '';
  });

  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
    let start = parseInt(startStr, 10) - 1;

    if (start < 0) start = 0;

    if (lengthStr) {
      const length = parseInt(lengthStr, 10);
      return args.slice(start, start + length).join(' ');
    }
    return args.slice(start).join(' ');
  });

  const allArgs = args.join(' ');

  result = result.replace(/\$ARGUMENTS/g, allArgs);

  result = result.replace(/\$@/g, allArgs);

  return result;
}

function loadTemplateFromFile(filePath: string, source: string, sourceLabel: string): PromptTemplate | null {
  try {
    const rawContent = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent);

    const name = basename(filePath).replace(/\.md$/, '');

    let description = frontmatter.description || '';
    if (!description) {
      const firstLine = body.split('\n').find(line => line.trim());
      if (firstLine) {
        description = firstLine.slice(0, 60);
        if (firstLine.length > 60) description += '...';
      }
    }

    description = description ? `${description} ${sourceLabel}` : sourceLabel;

    return {
      name,
      description,
      content: body,
      source,
      filePath
    };
  } catch {
    return null;
  }
}

function loadTemplatesFromDir(dir: string, source: string, sourceLabel: string): PromptTemplate[] {
  const templates: PromptTemplate[] = [];

  if (!existsSync(dir)) {
    return templates;
  }

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      if (isFile && entry.name.endsWith('.md')) {
        const template = loadTemplateFromFile(fullPath, source, sourceLabel);
        if (template) {
          templates.push(template);
        }
      }
    }
  } catch {
    return templates;
  }

  return templates;
}

export interface LoadPromptTemplatesOptions {
  cwd?: string;

  agentDir?: string;

  promptPaths?: string[];

  includeDefaults?: boolean;
}

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith('~')) return join(homedir(), trimmed.slice(1));
  return trimmed;
}

function resolvePromptPath(p: string, cwd: string): string {
  const normalized = normalizePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

function buildPathSourceLabel(p: string): string {
  const base = basename(p).replace(/\.md$/, '') || 'path';
  return `(path:${base})`;
}

export function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): PromptTemplate[] {
  const resolvedCwd = options.cwd ?? process.cwd();
  const resolvedAgentDir = options.agentDir ?? getPromptsDir();
  const promptPaths = options.promptPaths ?? [];
  const includeDefaults = options.includeDefaults ?? true;

  const templates: PromptTemplate[] = [];

  if (includeDefaults) {
    const globalPromptsDir = options.agentDir ? join(options.agentDir, 'prompts') : resolvedAgentDir;
    templates.push(...loadTemplatesFromDir(globalPromptsDir, 'user', '(user)'));

    const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, 'prompts');
    templates.push(...loadTemplatesFromDir(projectPromptsDir, 'project', '(project)'));
  }

  const userPromptsDir = options.agentDir ? join(options.agentDir, 'prompts') : resolvedAgentDir;
  const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, 'prompts');

  const isUnderPath = (target: string, root: string): boolean => {
    const normalizedRoot = resolve(root);
    if (target === normalizedRoot) {
      return true;
    }
    const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
    return target.startsWith(prefix);
  };

  const getSourceInfo = (resolvedPath: string): { source: string; label: string } => {
    if (!includeDefaults) {
      if (isUnderPath(resolvedPath, userPromptsDir)) {
        return { source: 'user', label: '(user)' };
      }
      if (isUnderPath(resolvedPath, projectPromptsDir)) {
        return { source: 'project', label: '(project)' };
      }
    }
    return { source: 'path', label: buildPathSourceLabel(resolvedPath) };
  };

  for (const rawPath of promptPaths) {
    const resolvedPath = resolvePromptPath(rawPath, resolvedCwd);
    if (!existsSync(resolvedPath)) {
      continue;
    }

    try {
      const stats = statSync(resolvedPath);
      const { source, label } = getSourceInfo(resolvedPath);
      if (stats.isDirectory()) {
        templates.push(...loadTemplatesFromDir(resolvedPath, source, label));
      } else if (stats.isFile() && resolvedPath.endsWith('.md')) {
        const template = loadTemplateFromFile(resolvedPath, source, label);
        if (template) {
          templates.push(template);
        }
      }
    } catch {}
  }

  return templates;
}

export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
  if (!text.startsWith('/')) return text;

  const spaceIndex = text.indexOf(' ');
  const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1);

  const template = templates.find(t => t.name === templateName);
  if (template) {
    const args = parseCommandArgs(argsString);
    return substituteArgs(template.content, args);
  }

  return text;
}
