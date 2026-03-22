import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Component } from '@mariozechner/pi-tui';

export interface ToolDefinition {
  renderCall?: (args: any) => string;
  renderResult?: (result: any, options?: ToolRenderResultOptions) => string;
}

export interface ToolRenderResultOptions {
  expanded?: boolean;
}

export interface MessageRenderer {
  render(message: any): Component | null;
}

export class ExtensionRunner {
  constructor(..._args: any[]) {}
  bindCore(..._args: any[]): void {}
  bindCommandContext(..._args: any[]): void {}
  setUIContext(..._args: any[]): void {}
  onError(_listener: any): () => void { return () => {}; }
  emitError(_event: any): void {}
  hasHandlers(_eventType: string): boolean { return false; }
  getExtensionPaths(): string[] { return []; }
  getAllRegisteredTools(): any[] { return []; }
  getToolDefinition(_name: string): any { return undefined; }
  getFlags(): Map<string, any> { return new Map(); }
  getFlagValues(): Map<string, any> { return new Map(); }
  setFlagValue(_name: string, _value: any): void {}
  getShortcuts(_keybindings: any): Map<string, any> { return new Map(); }
  getShortcutDiagnostics(): any[] { return []; }
  getRegisteredCommands(_reserved?: Set<string>): any[] { return []; }
  getCommandDiagnostics(): any[] { return []; }
  getRegisteredCommandsWithPaths(): any[] { return []; }
  getCommand(_name: string): any { return undefined; }
  getMessageRenderer(_customType: string): MessageRenderer | undefined { return undefined; }
  createContext(): any { return {}; }
  createCommandContext(): any { return {}; }
  shutdown(): void {}
  async emit(_event: any): Promise<any> { return undefined; }
  async emitToolCall(_event: any): Promise<any> { return undefined; }
  async emitToolResult(_event: any): Promise<any> { return undefined; }
  async emitUserBash(_event: any): Promise<any> { return undefined; }
  async emitContext(messages: any[]): Promise<any[]> { return messages; }
  async emitBeforeProviderRequest(payload: any): Promise<any> { return payload; }
  async emitBeforeAgentStart(..._args: any[]): Promise<any> { return undefined; }
  async emitResourcesDiscover(..._args: any[]): Promise<any> { return { skillPaths: [], promptPaths: [], themePaths: [] }; }
  async emitInput(text: string, images: any, _source: any): Promise<any> { return { action: 'continue', text, images }; }
  dispose(): void {}
}

export type ExtensionContext = any;
export type ExtensionUIContext = any;
export type ExtensionUIDialogOptions = any;
export type ExtensionWidgetOptions = any;
export type ExtensionErrorListener = (error: any) => void;
export type ExtensionCommandContextActions = any;
export type InputSource = any;
export type ShutdownHandler = () => void | Promise<void>;
export type TreePreparation = any;
export type ContextUsage = { contextWindow: number; percent: number | null; used: number };

export type MessageStartEvent = any;
export type MessageUpdateEvent = any;
export type MessageEndEvent = any;
export type TurnStartEvent = any;
export type TurnEndEvent = any;
export type ToolExecutionStartEvent = any;
export type ToolExecutionUpdateEvent = any;
export type ToolExecutionEndEvent = any;
export type ToolCallEvent = any;
export type ToolCallEventResult = any;
export type ToolResultEvent = any;
export type SessionStartEvent = any;
export type SessionCompactEvent = any;
export type SessionForkEvent = any;
export type SessionSwitchEvent = any;
export type SessionTreeEvent = any;
export type SessionShutdownEvent = any;
export type SessionBeforeCompactEvent = any;
export type SessionBeforeForkEvent = any;
export type SessionBeforeSwitchEvent = any;
export type SessionBeforeTreeEvent = any;
export type SessionBeforeCompactResult = any;
export type SessionBeforeForkResult = any;
export type SessionBeforeSwitchResult = any;
export type SessionBeforeTreeResult = any;
export type RegisteredCommand = any;
export type ToolInfo = { name: string; tool: AgentTool<any> };

export interface Extension {
  name: string;
  path: string;
}

export type ExtensionFactory = any;

export interface ExtensionRuntime {
  pendingProviderRegistrations: any[];
}

export interface LoadExtensionsResult {
  extensions: Extension[];
  errors: string[];
  runtime: ExtensionRuntime;
}
