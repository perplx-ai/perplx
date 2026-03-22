import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Model, Usage } from '@mariozechner/pi-ai';
import { completeSimple } from '@mariozechner/pi-ai';
import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from '../messages.js';
import type { CompactionEntry, SessionEntry } from '../session-manager.js';
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  type FileOperations,
  formatFileOperations,
  SUMMARIZATION_SYSTEM_PROMPT,
  serializeConversation
} from './utils.js';

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

function extractFileOperations(messages: AgentMessage[], entries: SessionEntry[], prevCompactionIndex: number): FileOperations {
  const fileOps = createFileOps();

  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
    if (!prevCompaction.fromHook && prevCompaction.details) {
      const details = prevCompaction.details as CompactionDetails;
      if (Array.isArray(details.readFiles)) {
        for (const f of details.readFiles) fileOps.read.add(f);
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const f of details.modifiedFiles) fileOps.edited.add(f);
      }
    }
  }

  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }

  return fileOps;
}

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === 'message') {
    return entry.message;
  }
  if (entry.type === 'custom_message') {
    return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
  }
  if (entry.type === 'branch_summary') {
    return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
  }
  if (entry.type === 'compaction') {
    return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
  }
  return undefined;
}

export interface CompactionResult<T = unknown> {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;

  details?: T;
}

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000
};

export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role === 'assistant' && 'usage' in msg) {
    const assistantMsg = msg as AssistantMessage;
    if (assistantMsg.stopReason !== 'aborted' && assistantMsg.stopReason !== 'error' && assistantMsg.usage) {
      return assistantMsg.usage;
    }
  }
  return undefined;
}

export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'message') {
      const usage = getAssistantUsage(entry.message);
      if (usage) return usage;
    }
  }
  return undefined;
}

export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) return { usage, index: i };
  }
  return undefined;
}

export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);

  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null
    };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index
  };
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

export function estimateTokens(message: AgentMessage): number {
  let chars = 0;

  switch (message.role) {
    case 'user': {
      const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
      if (typeof content === 'string') {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            chars += block.text.length;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case 'assistant': {
      const assistant = message as AssistantMessage;
      for (const block of assistant.content) {
        if (block.type === 'text') {
          chars += block.text.length;
        } else if (block.type === 'thinking') {
          chars += block.thinking.length;
        } else if (block.type === 'toolCall') {
          chars += block.name.length + JSON.stringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case 'custom':
    case 'toolResult': {
      if (typeof message.content === 'string') {
        chars = message.content.length;
      } else {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            chars += block.text.length;
          }
          if (block.type === 'image') {
            chars += 4800;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case 'bashExecution': {
      chars = message.command.length + message.output.length;
      return Math.ceil(chars / 4);
    }
    case 'branchSummary':
    case 'compactionSummary': {
      chars = message.summary.length;
      return Math.ceil(chars / 4);
    }
  }

  return 0;
}

function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    switch (entry.type) {
      case 'message': {
        const role = entry.message.role;
        switch (role) {
          case 'bashExecution':
          case 'custom':
          case 'branchSummary':
          case 'compactionSummary':
          case 'user':
          case 'assistant':
            cutPoints.push(i);
            break;
          case 'toolResult':
            break;
        }
        break;
      }
      case 'thinking_level_change':
      case 'model_change':
      case 'compaction':
      case 'branch_summary':
      case 'custom':
      case 'custom_message':
      case 'label':
      case 'session_info':
        break;
    }

    if (entry.type === 'branch_summary' || entry.type === 'custom_message') {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}

export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];

    if (entry.type === 'branch_summary' || entry.type === 'custom_message') {
      return i;
    }
    if (entry.type === 'message') {
      const role = entry.message.role;
      if (role === 'user' || role === 'bashExecution') {
        return i;
      }
    }
  }
  return -1;
}

export interface CutPointResult {
  firstKeptEntryIndex: number;

  turnStartIndex: number;

  isSplitTurn: boolean;
}

export function findCutPoint(entries: SessionEntry[], startIndex: number, endIndex: number, keepRecentTokens: number): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];

  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== 'message') continue;

    const messageTokens = estimateTokens(entry.message);
    accumulatedTokens += messageTokens;

    if (accumulatedTokens >= keepRecentTokens) {
      for (let c = 0; c < cutPoints.length; c++) {
        if (cutPoints[c] >= i) {
          cutIndex = cutPoints[c];
          break;
        }
      }
      break;
    }
  }

  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];

    if (prevEntry.type === 'compaction') {
      break;
    }
    if (prevEntry.type === 'message') {
      break;
    }

    cutIndex--;
  }

  const cutEntry = entries[cutIndex];
  const isUserMessage = cutEntry.type === 'message' && cutEntry.message.role === 'user';
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1
  };
}

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model<any>,
  reserveTokens: number,
  apiKey: string,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string
): Promise<string> {
  const maxTokens = Math.floor(0.8 * reserveTokens);

  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }

  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);

  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  const summarizationMessages = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: promptText }],
      timestamp: Date.now()
    }
  ];

  const completionOptions = model.reasoning ? { maxTokens, signal, apiKey, reasoning: 'high' as const } : { maxTokens, signal, apiKey };

  const response = await completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, completionOptions);

  if (response.stopReason === 'error') {
    throw new Error(`Summarization failed: ${response.errorMessage || 'Unknown error'}`);
  }

  const textContent = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  return textContent;
}

export interface CompactionPreparation {
  firstKeptEntryId: string;

  messagesToSummarize: AgentMessage[];

  turnPrefixMessages: AgentMessage[];

  isSplitTurn: boolean;
  tokensBefore: number;

  previousSummary?: string;

  fileOps: FileOperations;

  settings: CompactionSettings;
}

export function prepareCompaction(pathEntries: SessionEntry[], settings: CompactionSettings): CompactionPreparation | undefined {
  if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === 'compaction') {
    return undefined;
  }

  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === 'compaction') {
      prevCompactionIndex = i;
      break;
    }
  }
  const boundaryStart = prevCompactionIndex + 1;
  const boundaryEnd = pathEntries.length;

  const usageStart = prevCompactionIndex >= 0 ? prevCompactionIndex : 0;
  const usageMessages: AgentMessage[] = [];
  for (let i = usageStart; i < boundaryEnd; i++) {
    const msg = getMessageFromEntry(pathEntries[i]);
    if (msg) usageMessages.push(msg);
  }
  const tokensBefore = estimateContextTokens(usageMessages).tokens;

  const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return undefined;
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const msg = getMessageFromEntry(pathEntries[i]);
    if (msg) messagesToSummarize.push(msg);
  }

  const turnPrefixMessages: AgentMessage[] = [];
  if (cutPoint.isSplitTurn) {
    for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
      const msg = getMessageFromEntry(pathEntries[i]);
      if (msg) turnPrefixMessages.push(msg);
    }
  }

  let previousSummary: string | undefined;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
    previousSummary = prevCompaction.summary;
  }

  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }

  return {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings
  };
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export async function compact(
  preparation: CompactionPreparation,
  model: Model<any>,
  apiKey: string,
  customInstructions?: string,
  signal?: AbortSignal
): Promise<CompactionResult> {
  const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings } = preparation;

  let summary: string;

  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const [historyResult, turnPrefixResult] = await Promise.all([
      messagesToSummarize.length > 0
        ? generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, signal, customInstructions, previousSummary)
        : Promise.resolve('No prior history.'),
      generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, signal)
    ]);

    summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
  } else {
    summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, signal, customInstructions, previousSummary);
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  if (!firstKeptEntryId) {
    throw new Error('First kept entry has no UUID - session may need migration');
  }

  return {
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: { readFiles, modifiedFiles } as CompactionDetails
  };
}

async function generateTurnPrefixSummary(
  messages: AgentMessage[],
  model: Model<any>,
  reserveTokens: number,
  apiKey: string,
  signal?: AbortSignal
): Promise<string> {
  const maxTokens = Math.floor(0.5 * reserveTokens);
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const summarizationMessages = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: promptText }],
      timestamp: Date.now()
    }
  ];

  const response = await completeSimple(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    { maxTokens, signal, apiKey }
  );

  if (response.stopReason === 'error') {
    throw new Error(`Turn prefix summarization failed: ${response.errorMessage || 'Unknown error'}`);
  }

  return response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}
