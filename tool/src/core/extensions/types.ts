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
  hasHandlers(_event: string): boolean { return false; }
  async emitBeforeProviderRequest(_payload: any): Promise<any> { return undefined; }
  async emitUserBash(_event: any): Promise<any> { return undefined; }
  async emitSessionStart(_event: any): Promise<void> {}
  async emitSessionShutdown(_event: any): Promise<void> {}
  async emitSessionBeforeCompact(_event: any): Promise<any> { return undefined; }
  async emitSessionBeforeFork(_event: any): Promise<any> { return undefined; }
  async emitSessionBeforeSwitch(_event: any): Promise<any> { return undefined; }
  async emitSessionBeforeTree(_event: any): Promise<any> { return undefined; }
  async emitTurnStart(_event: any): Promise<void> {}
  async emitTurnEnd(_event: any): Promise<void> {}
  dispose(): void {}
}
export type ExtensionContext = any;
export type ExtensionUIContext = any;
export type ExtensionUIDialogOptions = any;
export type ExtensionWidgetOptions = any;
export type ExtensionErrorListener = any;
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
