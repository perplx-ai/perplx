export { ExtensionRunner } from './types.js';

export type {
  ContextUsage,
  Extension,
  ExtensionCommandContextActions,
  ExtensionContext,
  ExtensionErrorListener,
  ExtensionFactory,
  ExtensionRuntime,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  InputSource,
  LoadExtensionsResult,
  MessageEndEvent,
  MessageRenderer,
  MessageStartEvent,
  MessageUpdateEvent,
  RegisteredCommand,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionBeforeForkEvent,
  SessionBeforeForkResult,
  SessionBeforeSwitchEvent,
  SessionBeforeSwitchResult,
  SessionBeforeTreeEvent,
  SessionBeforeTreeResult,
  SessionCompactEvent,
  SessionForkEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionSwitchEvent,
  SessionTreeEvent,
  ShutdownHandler,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolInfo,
  ToolRenderResultOptions,
  ToolResultEvent,
  TreePreparation,
  TurnEndEvent,
  TurnStartEvent,
} from './types.js';

export function wrapRegisteredTools(tools: any[], _runner?: any): any[] {
  return tools.map((t: any) => {
    const def = t.definition ?? t;
    return {
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      execute: def.execute,
    };
  });
}
