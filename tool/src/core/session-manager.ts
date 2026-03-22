import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ImageContent, Message, TextContent } from '@mariozechner/pi-ai';
import { randomUUID } from 'crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from '../config.js';
import {
  type BashExecutionMessage,
  type CustomMessage,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage
} from './messages.js';

export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
  type: 'session';
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface NewSessionOptions {
  id?: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: 'message';
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: 'thinking_level_change';
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: 'model_change';
  provider: string;
  modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;

  details?: T;

  fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
  type: 'branch_summary';
  fromId: string;
  summary: string;

  details?: T;

  fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
  type: 'custom';
  customType: string;
  data?: T;
}

export interface LabelEntry extends SessionEntryBase {
  type: 'label';
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: 'session_info';
  name?: string;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
  type: 'custom_message';
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: T;
  display: boolean;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];

  label?: string;
}

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
  path: string;
  id: string;

  cwd: string;

  name?: string;

  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

export type ReadonlySessionManager = Pick<
  SessionManager,
  | 'getCwd'
  | 'getSessionDir'
  | 'getSessionId'
  | 'getSessionFile'
  | 'getLeafId'
  | 'getLeafEntry'
  | 'getEntry'
  | 'getLabel'
  | 'getBranch'
  | 'getHeader'
  | 'getEntries'
  | 'getTree'
  | 'getSessionName'
>;

function generateId(byId: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!byId.has(id)) return id;
  }

  return randomUUID();
}

function migrateV1ToV2(entries: FileEntry[]): void {
  const ids = new Set<string>();
  let prevId: string | null = null;

  for (const entry of entries) {
    if (entry.type === 'session') {
      entry.version = 2;
      continue;
    }

    entry.id = generateId(ids);
    entry.parentId = prevId;
    prevId = entry.id;

    if (entry.type === 'compaction') {
      const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
      if (typeof comp.firstKeptEntryIndex === 'number') {
        const targetEntry = entries[comp.firstKeptEntryIndex];
        if (targetEntry && targetEntry.type !== 'session') {
          comp.firstKeptEntryId = targetEntry.id;
        }
        delete comp.firstKeptEntryIndex;
      }
    }
  }
}

function migrateV2ToV3(entries: FileEntry[]): void {
  for (const entry of entries) {
    if (entry.type === 'session') {
      entry.version = 3;
      continue;
    }

    if (entry.type === 'message') {
      const msgEntry = entry as SessionMessageEntry;
      if (msgEntry.message && (msgEntry.message as { role: string }).role === 'hookMessage') {
        (msgEntry.message as { role: string }).role = 'custom';
      }
    }
  }
}

function migrateToCurrentVersion(entries: FileEntry[]): boolean {
  const header = entries.find(e => e.type === 'session') as SessionHeader | undefined;
  const version = header?.version ?? 1;

  if (version >= CURRENT_SESSION_VERSION) return false;

  if (version < 2) migrateV1ToV2(entries);
  if (version < 3) migrateV2ToV3(entries);

  return true;
}

export function migrateSessionEntries(entries: FileEntry[]): void {
  migrateToCurrentVersion(entries);
}

export function parseSessionEntries(content: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const lines = content.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as FileEntry;
      entries.push(entry);
    } catch {}
  }

  return entries;
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'compaction') {
      return entries[i] as CompactionEntry;
    }
  }
  return null;
}

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null, byId?: Map<string, SessionEntry>): SessionContext {
  if (!byId) {
    byId = new Map<string, SessionEntry>();
    for (const entry of entries) {
      byId.set(entry.id, entry);
    }
  }

  let leaf: SessionEntry | undefined;
  if (leafId === null) {
    return { messages: [], thinkingLevel: 'off', model: null };
  }
  if (leafId) {
    leaf = byId.get(leafId);
  }
  if (!leaf) {
    leaf = entries[entries.length - 1];
  }

  if (!leaf) {
    return { messages: [], thinkingLevel: 'off', model: null };
  }

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  let thinkingLevel = 'off';
  let model: { provider: string; modelId: string } | null = null;
  let compaction: CompactionEntry | null = null;

  for (const entry of path) {
    if (entry.type === 'thinking_level_change') {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === 'model_change') {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === 'message' && entry.message.role === 'assistant') {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    } else if (entry.type === 'compaction') {
      compaction = entry;
    }
  }

  const messages: AgentMessage[] = [];

  const appendMessage = (entry: SessionEntry) => {
    if (entry.type === 'message') {
      messages.push(entry.message);
    } else if (entry.type === 'custom_message') {
      messages.push(createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp));
    } else if (entry.type === 'branch_summary' && entry.summary) {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  };

  if (compaction) {
    messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));

    const compactionIdx = path.findIndex(e => e.type === 'compaction' && e.id === compaction.id);

    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i];
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        appendMessage(entry);
      }
    }

    for (let i = compactionIdx + 1; i < path.length; i++) {
      const entry = path[i];
      appendMessage(entry);
    }
  } else {
    for (const entry of path) {
      appendMessage(entry);
    }
  }

  return { messages, thinkingLevel, model };
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
  const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const sessionDir = join(agentDir, 'sessions', safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf8');
  const entries: FileEntry[] = [];
  const lines = content.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as FileEntry;
      entries.push(entry);
    } catch {}
  }

  if (entries.length === 0) return entries;
  const header = entries[0];
  if (header.type !== 'session' || typeof (header as any).id !== 'string') {
    return [];
  }

  return entries;
}

function isValidSessionFile(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const bytesRead = readSync(fd, buffer, 0, 512, 0);
    closeSync(fd);
    const firstLine = buffer.toString('utf8', 0, bytesRead).split('\n')[0];
    if (!firstLine) return false;
    const header = JSON.parse(firstLine);
    return header.type === 'session' && typeof header.id === 'string';
  } catch {
    return false;
  }
}

export function findMostRecentSession(sessionDir: string): string | null {
  try {
    const files = readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(sessionDir, f))
      .filter(isValidSessionFile)
      .map(path => ({ path, mtime: statSync(path).mtime }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return files[0]?.path || null;
  } catch {
    return null;
  }
}

function isMessageWithContent(message: AgentMessage): message is Message {
  return typeof (message as Message).role === 'string' && 'content' in message;
}

function extractTextContent(message: Message): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block): block is TextContent => block.type === 'text')
    .map(block => block.text)
    .join(' ');
}

function getLastActivityTime(entries: FileEntry[]): number | undefined {
  let lastActivityTime: number | undefined;

  for (const entry of entries) {
    if (entry.type !== 'message') continue;

    const message = (entry as SessionMessageEntry).message;
    if (!isMessageWithContent(message)) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    const msgTimestamp = (message as { timestamp?: number }).timestamp;
    if (typeof msgTimestamp === 'number') {
      lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
      continue;
    }

    const entryTimestamp = (entry as SessionEntryBase).timestamp;
    if (typeof entryTimestamp === 'string') {
      const t = new Date(entryTimestamp).getTime();
      if (!Number.isNaN(t)) {
        lastActivityTime = Math.max(lastActivityTime ?? 0, t);
      }
    }
  }

  return lastActivityTime;
}

function getSessionModifiedDate(entries: FileEntry[], header: SessionHeader, statsMtime: Date): Date {
  const lastActivityTime = getLastActivityTime(entries);
  if (typeof lastActivityTime === 'number' && lastActivityTime > 0) {
    return new Date(lastActivityTime);
  }

  const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
  return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    const entries: FileEntry[] = [];
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as FileEntry);
      } catch {}
    }

    if (entries.length === 0) return null;
    const header = entries[0];
    if (header.type !== 'session') return null;

    const stats = await stat(filePath);
    let messageCount = 0;
    let firstMessage = '';
    const allMessages: string[] = [];
    let name: string | undefined;

    for (const entry of entries) {
      if (entry.type === 'session_info') {
        const infoEntry = entry as SessionInfoEntry;
        name = infoEntry.name?.trim() || undefined;
      }

      if (entry.type !== 'message') continue;
      messageCount++;

      const message = (entry as SessionMessageEntry).message;
      if (!isMessageWithContent(message)) continue;
      if (message.role !== 'user' && message.role !== 'assistant') continue;

      const textContent = extractTextContent(message);
      if (!textContent) continue;

      allMessages.push(textContent);
      if (!firstMessage && message.role === 'user') {
        firstMessage = textContent;
      }
    }

    const cwd = typeof (header as SessionHeader).cwd === 'string' ? (header as SessionHeader).cwd : '';
    const parentSessionPath = (header as SessionHeader).parentSession;

    const modified = getSessionModifiedDate(entries, header as SessionHeader, stats.mtime);

    return {
      path: filePath,
      id: (header as SessionHeader).id,
      cwd,
      name,
      parentSessionPath,
      created: new Date((header as SessionHeader).timestamp),
      modified,
      messageCount,
      firstMessage: firstMessage || '(no messages)',
      allMessagesText: allMessages.join(' ')
    };
  } catch {
    return null;
  }
}

export type SessionListProgress = (loaded: number, total: number) => void;

async function listSessionsFromDir(
  dir: string,
  onProgress?: SessionListProgress,
  progressOffset = 0,
  progressTotal?: number
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  if (!existsSync(dir)) {
    return sessions;
  }

  try {
    const dirEntries = await readdir(dir);
    const files = dirEntries.filter(f => f.endsWith('.jsonl')).map(f => join(dir, f));
    const total = progressTotal ?? files.length;

    let loaded = 0;
    const results = await Promise.all(
      files.map(async file => {
        const info = await buildSessionInfo(file);
        loaded++;
        onProgress?.(progressOffset + loaded, total);
        return info;
      })
    );
    for (const info of results) {
      if (info) {
        sessions.push(info);
      }
    }
  } catch {}

  return sessions;
}

export class SessionManager {
  private sessionId: string = '';
  private sessionFile: string | undefined;
  private sessionDir: string;
  private cwd: string;
  private persist: boolean;
  private flushed: boolean = false;
  private fileEntries: FileEntry[] = [];
  private byId: Map<string, SessionEntry> = new Map();
  private labelsById: Map<string, string> = new Map();
  private leafId: string | null = null;

  private constructor(cwd: string, sessionDir: string, sessionFile: string | undefined, persist: boolean) {
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.persist = persist;
    if (persist && sessionDir && !existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    if (sessionFile) {
      this.setSessionFile(sessionFile);
    } else {
      this.newSession();
    }
  }

  setSessionFile(sessionFile: string): void {
    this.sessionFile = resolve(sessionFile);
    if (existsSync(this.sessionFile)) {
      this.fileEntries = loadEntriesFromFile(this.sessionFile);

      if (this.fileEntries.length === 0) {
        const explicitPath = this.sessionFile;
        this.newSession();
        this.sessionFile = explicitPath;
        this._rewriteFile();
        this.flushed = true;
        return;
      }

      const header = this.fileEntries.find(e => e.type === 'session') as SessionHeader | undefined;
      this.sessionId = header?.id ?? randomUUID();

      if (migrateToCurrentVersion(this.fileEntries)) {
        this._rewriteFile();
      }

      this._buildIndex();
      this.flushed = true;
    } else {
      const explicitPath = this.sessionFile;
      this.newSession();
      this.sessionFile = explicitPath;
    }
  }

  newSession(options?: NewSessionOptions): string | undefined {
    this.sessionId = options?.id ?? randomUUID();
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: options?.parentSession
    };
    this.fileEntries = [header];
    this.byId.clear();
    this.labelsById.clear();
    this.leafId = null;
    this.flushed = false;

    if (this.persist) {
      const fileTimestamp = timestamp.replace(/[:.]/g, '-');
      this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
    }
    return this.sessionFile;
  }

  private _buildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.leafId = null;
    for (const entry of this.fileEntries) {
      if (entry.type === 'session') continue;
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      if (entry.type === 'label') {
        if (entry.label) {
          this.labelsById.set(entry.targetId, entry.label);
        } else {
          this.labelsById.delete(entry.targetId);
        }
      }
    }
  }

  private _rewriteFile(): void {
    if (!this.persist || !this.sessionFile) return;
    const content = `${this.fileEntries.map(e => JSON.stringify(e)).join('\n')}\n`;
    writeFileSync(this.sessionFile, content);
  }

  isPersisted(): boolean {
    return this.persist;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  _persist(entry: SessionEntry): void {
    if (!this.persist || !this.sessionFile) return;

    const hasAssistant = this.fileEntries.some(e => e.type === 'message' && e.message.role === 'assistant');
    if (!hasAssistant) {
      this.flushed = false;
      return;
    }

    if (!this.flushed) {
      for (const e of this.fileEntries) {
        appendFileSync(this.sessionFile, `${JSON.stringify(e)}\n`);
      }
      this.flushed = true;
    } else {
      appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
    }
  }

  private _appendEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this._persist(entry);
  }

  appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
    const entry: SessionMessageEntry = {
      type: 'message',
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry: ThinkingLevelChangeEntry = {
      type: 'thinking_level_change',
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      thinkingLevel
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: ModelChangeEntry = {
      type: 'model_change',
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendCompaction<T = unknown>(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: T, fromHook?: boolean): string {
    const entry: CompactionEntry<T> = {
      type: 'compaction',
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: 'custom',
      customType,
      data,
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString()
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendSessionInfo(name: string): string {
    const entry: SessionInfoEntry = {
      type: 'session_info',
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name: name.trim()
    };
    this._appendEntry(entry);
    return entry.id;
  }

  getSessionName(): string | undefined {
    const entries = this.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === 'session_info') {
        return entry.name?.trim() || undefined;
      }
    }
    return undefined;
  }

  appendCustomMessageEntry<T = unknown>(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: T): string {
    const entry: CustomMessageEntry<T> = {
      type: 'custom_message',
      customType,
      content,
      display,
      details,
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString()
    };
    this._appendEntry(entry);
    return entry.id;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getChildren(parentId: string): SessionEntry[] {
    const children: SessionEntry[] = [];
    for (const entry of this.byId.values()) {
      if (entry.parentId === parentId) {
        children.push(entry);
      }
    }
    return children;
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: LabelEntry = {
      type: 'label',
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
      label
    };
    this._appendEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
    } else {
      this.labelsById.delete(targetId);
    }
    return entry.id;
  }

  getBranch(fromId?: string): SessionEntry[] {
    const path: SessionEntry[] = [];
    const startId = fromId ?? this.leafId;
    let current = startId ? this.byId.get(startId) : undefined;
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return path;
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.getEntries(), this.leafId, this.byId);
  }

  getHeader(): SessionHeader | null {
    const h = this.fileEntries.find(e => e.type === 'session');
    return h ? (h as SessionHeader) : null;
  }

  getEntries(): SessionEntry[] {
    return this.fileEntries.filter((e): e is SessionEntry => e.type !== 'session');
  }

  getTree(): SessionTreeNode[] {
    const entries = this.getEntries();
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];

    for (const entry of entries) {
      const label = this.labelsById.get(entry.id);
      nodeMap.set(entry.id, { entry, children: [], label });
    }

    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(entry.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      }
    }

    const stack: SessionTreeNode[] = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
      stack.push(...node.children);
    }

    return roots;
  }

  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
  }

  resetLeaf(): void {
    this.leafId = null;
  }

  branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
    const entry: BranchSummaryEntry = {
      type: 'branch_summary',
      id: generateId(this.byId),
      parentId: branchFromId,
      timestamp: new Date().toISOString(),
      fromId: branchFromId ?? 'root',
      summary,
      details,
      fromHook
    };
    this._appendEntry(entry);
    return entry.id;
  }

  createBranchedSession(leafId: string): string | undefined {
    const previousSessionFile = this.sessionFile;
    const path = this.getBranch(leafId);
    if (path.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }

    const pathWithoutLabels = path.filter(e => e.type !== 'label');

    const newSessionId = randomUUID();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, '-');
    const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

    const header: SessionHeader = {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: newSessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: this.persist ? previousSessionFile : undefined
    };

    const pathEntryIds = new Set(pathWithoutLabels.map(e => e.id));
    const labelsToWrite: Array<{ targetId: string; label: string }> = [];
    for (const [targetId, label] of this.labelsById) {
      if (pathEntryIds.has(targetId)) {
        labelsToWrite.push({ targetId, label });
      }
    }

    if (this.persist) {
      const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
      let parentId = lastEntryId;
      const labelEntries: LabelEntry[] = [];
      for (const { targetId, label } of labelsToWrite) {
        const labelEntry: LabelEntry = {
          type: 'label',
          id: generateId(new Set(pathEntryIds)),
          parentId,
          timestamp: new Date().toISOString(),
          targetId,
          label
        };
        pathEntryIds.add(labelEntry.id);
        labelEntries.push(labelEntry);
        parentId = labelEntry.id;
      }

      this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
      this.sessionId = newSessionId;
      this.sessionFile = newSessionFile;
      this._buildIndex();

      const hasAssistant = this.fileEntries.some(e => e.type === 'message' && e.message.role === 'assistant');
      if (hasAssistant) {
        this._rewriteFile();
        this.flushed = true;
      } else {
        this.flushed = false;
      }

      return newSessionFile;
    }

    const labelEntries: LabelEntry[] = [];
    let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
    for (const { targetId, label } of labelsToWrite) {
      const labelEntry: LabelEntry = {
        type: 'label',
        id: generateId(new Set([...pathEntryIds, ...labelEntries.map(e => e.id)])),
        parentId,
        timestamp: new Date().toISOString(),
        targetId,
        label
      };
      labelEntries.push(labelEntry);
      parentId = labelEntry.id;
    }
    this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
    this.sessionId = newSessionId;
    this._buildIndex();
    return undefined;
  }

  static create(cwd: string, sessionDir?: string): SessionManager {
    const dir = sessionDir ?? getDefaultSessionDir(cwd);
    return new SessionManager(cwd, dir, undefined, true);
  }

  static open(path: string, sessionDir?: string): SessionManager {
    const entries = loadEntriesFromFile(path);
    const header = entries.find(e => e.type === 'session') as SessionHeader | undefined;
    const cwd = header?.cwd ?? process.cwd();

    const dir = sessionDir ?? resolve(path, '..');
    return new SessionManager(cwd, dir, path, true);
  }

  static continueRecent(cwd: string, sessionDir?: string): SessionManager {
    const dir = sessionDir ?? getDefaultSessionDir(cwd);
    const mostRecent = findMostRecentSession(dir);
    if (mostRecent) {
      return new SessionManager(cwd, dir, mostRecent, true);
    }
    return new SessionManager(cwd, dir, undefined, true);
  }

  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd, '', undefined, false);
  }

  static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager {
    const sourceEntries = loadEntriesFromFile(sourcePath);
    if (sourceEntries.length === 0) {
      throw new Error(`Cannot fork: source session file is empty or invalid: ${sourcePath}`);
    }

    const sourceHeader = sourceEntries.find(e => e.type === 'session') as SessionHeader | undefined;
    if (!sourceHeader) {
      throw new Error(`Cannot fork: source session has no header: ${sourcePath}`);
    }

    const dir = sessionDir ?? getDefaultSessionDir(targetCwd);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const newSessionId = randomUUID();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, '-');
    const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

    const newHeader: SessionHeader = {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: newSessionId,
      timestamp,
      cwd: targetCwd,
      parentSession: sourcePath
    };
    appendFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`);

    for (const entry of sourceEntries) {
      if (entry.type !== 'session') {
        appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
      }
    }

    return new SessionManager(targetCwd, dir, newSessionFile, true);
  }

  static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    const dir = sessionDir ?? getDefaultSessionDir(cwd);
    const sessions = await listSessionsFromDir(dir, onProgress);
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return sessions;
  }

  static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    const sessionsDir = getSessionsDir();

    try {
      if (!existsSync(sessionsDir)) {
        return [];
      }
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => join(sessionsDir, e.name));

      let totalFiles = 0;
      const dirFiles: string[][] = [];
      for (const dir of dirs) {
        try {
          const files = (await readdir(dir)).filter(f => f.endsWith('.jsonl'));
          dirFiles.push(files.map(f => join(dir, f)));
          totalFiles += files.length;
        } catch {
          dirFiles.push([]);
        }
      }

      let loaded = 0;
      const sessions: SessionInfo[] = [];
      const allFiles = dirFiles.flat();

      const results = await Promise.all(
        allFiles.map(async file => {
          const info = await buildSessionInfo(file);
          loaded++;
          onProgress?.(loaded, totalFiles);
          return info;
        })
      );

      for (const info of results) {
        if (info) {
          sessions.push(info);
        }
      }

      sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
      return sessions;
    } catch {
      return [];
    }
  }
}
