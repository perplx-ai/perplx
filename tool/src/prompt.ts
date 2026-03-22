import { formatSkillsForPrompt, type Skill } from './core/skills.js';

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: 'Read file contents',
  bash: 'Execute shell commands (ls, grep, find, git …)',
  edit: 'Surgical find-and-replace edits to existing files',
  write: 'Create new files or overwrite existing ones entirely',
  grep: 'Search file contents for regex patterns (respects .gitignore)',
  find: 'Locate files by glob pattern (respects .gitignore)',
  ls: 'List directory contents'
};

export interface SystemPromptOptions {
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd?: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: Skill[];
}



function deriveGuidelines(tools: string[], extra: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (g: string) => {
    if (seen.has(g)) return;
    seen.add(g);
    out.push(g);
  };

  const has = (t: string) => tools.includes(t);

  if (has('bash') && !has('grep') && !has('find') && !has('ls')) {
    add('Use bash for file operations like ls, rg, find');
  } else if (has('bash') && (has('grep') || has('find') || has('ls'))) {
    add('Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)');
  }

  if (has('read') && has('edit')) {
    add('Always read a file before editing it – use the read tool, never cat or sed');
  }
  if (has('edit')) add('Use edit for precise changes (old text must match exactly)');
  if (has('write')) add('Use write only for new files or complete rewrites');
  if (has('edit') || has('write')) {
    add('Summarise actions in plain text – do NOT echo file contents via bash');
    add('Make the smallest reasonable diff – do not rewrite whole files to change a few lines');
  }

  add('Never assume a library is available – check package.json, cargo.toml, etc. first');
  add('Mimic existing code style, naming conventions, and patterns in the file you are editing');
  add('Never introduce code that exposes or logs secrets and keys');
  add('Be concise and direct – skip flattery, avoid emojis, no unnecessary preamble or summaries');
  add('Reference code with file:// links when mentioning files (e.g. file:///path/to/file.ts#L32)');
  add('Show file paths clearly when working with files');

  for (const g of extra) {
    const trimmed = g.trim();
    if (trimmed) add(trimmed);
  }

  return out;
}

function formatToolsList(tools: string[], snippets?: Record<string, string>): string {
  const visible = tools.filter(t => t in TOOL_DESCRIPTIONS || snippets?.[t]);
  if (visible.length === 0) return '(none)';
  return visible.map(t => `- ${t}: ${snippets?.[t] ?? TOOL_DESCRIPTIONS[t] ?? t}`).join('\n');
}

function appendContext(prompt: string, contextFiles: Array<{ path: string; content: string }>): string {
  if (contextFiles.length === 0) return prompt;
  let section = '\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n';
  for (const { path, content } of contextFiles) {
    section += `## ${path}\n\n${content}\n\n`;
  }
  return prompt + section;
}

function appendSkills(prompt: string, skills: Skill[], hasRead: boolean): string {
  if (!hasRead || skills.length === 0) return prompt;
  return prompt + formatSkillsForPrompt(skills);
}

function appendMetadata(prompt: string, cwd: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${prompt}\nCurrent date: ${date}\nCurrent working directory: ${cwd.replace(/\\/g, '/')}`;
}

export function assembleSystemPrompt(opts: SystemPromptOptions = {}): string {
  const { customPrompt, selectedTools, toolSnippets, promptGuidelines = [], appendSystemPrompt, cwd, contextFiles = [], skills = [] } = opts;

  const resolvedCwd = cwd ?? process.cwd();
  const suffix = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : '';

  if (customPrompt) {
    let p = customPrompt + suffix;
    p = appendContext(p, contextFiles);
    const hasRead = !selectedTools || selectedTools.includes('read');
    p = appendSkills(p, skills, hasRead);
    return appendMetadata(p, resolvedCwd);
  }

  const tools = selectedTools ?? ['read', 'bash', 'edit', 'write'];
  const toolsList = formatToolsList(tools, toolSnippets);
  const guidelines = deriveGuidelines(tools, promptGuidelines)
    .map(g => `- ${g}`)
    .join('\n');

  let prompt = `You are an expert coding assistant running inside Perplexity code, an AI coding agent backed by the Perplexity Agent API.  You help users read files, execute commands, edit code, and create new files.

## Tools

${toolsList}

Additional custom tools may be available depending on the project.

## Guidelines

${guidelines}`;

  prompt += suffix;
  prompt = appendContext(prompt, contextFiles);
  prompt = appendSkills(prompt, skills, tools.includes('read'));
  return appendMetadata(prompt, resolvedCwd);
}

export const buildSystemPrompt = assembleSystemPrompt;
