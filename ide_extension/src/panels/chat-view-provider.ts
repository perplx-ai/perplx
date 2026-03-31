import * as vscode from 'vscode';
import type { SessionAdapter } from '../session-adapter.js';
import type {
  AgentSession,
  AgentSessionEvent,
} from 'perplx-tool';

/**
 * WebviewViewProvider that renders the Perplx chat sidebar.
 *
 * Communication with the webview uses postMessage:
 *
 *   Extension → Webview:
 *     { type: 'streamStart' }
 *     { type: 'streamChunk', text: string }
 *     { type: 'streamEnd' }
 *     { type: 'toolExecStart', toolName, args }
 *     { type: 'toolExecEnd', toolName, result, isError }
 *     { type: 'error', message: string }
 *     { type: 'sessionInfo', model, thinkingLevel, sessionId }
 *     { type: 'modelsAvailable', models: {provider, id, name}[] }
 *
 *   Webview → Extension:
 *     { type: 'prompt', text: string }
 *     { type: 'abort' }
 *     { type: 'newSession' }
 *     { type: 'selectModel', provider, modelId }
 *     { type: 'ready' }
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'perplx.chatView';

  private _view?: vscode.WebviewView;
  private _unsubscribeSession?: () => void;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _adapter: SessionAdapter,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist')],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await this._handleWebviewMessage(msg);
    });

    webviewView.onDidDispose(() => {
      this._unsubscribeSession?.();
      this._view = undefined;
    });
  }

  /** Push a message to the webview (if visible). */
  postMessage(msg: Record<string, unknown>): void {
    this._view?.webview.postMessage(msg);
  }

  /** Subscribe to session events and forward them to the webview. */
  bindSession(session: AgentSession): void {
    this._unsubscribeSession?.();

    // Send initial session info
    this.postMessage({
      type: 'sessionInfo',
      model: session.model
        ? { provider: session.model.provider, id: session.model.id, name: session.model.name }
        : null,
      thinkingLevel: session.thinkingLevel,
      sessionId: session.sessionId,
    });

    this._unsubscribeSession = session.subscribe((event: AgentSessionEvent) => {
      this._forwardEvent(event);
    });
  }

  private _forwardEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') {
          this.postMessage({ type: 'streamStart' });
        }
        break;

      case 'message_update':
        if (event.message.role === 'assistant' && event.assistantMessageEvent) {
          const ame = event.assistantMessageEvent;
          if (ame.type === 'text') {
            this.postMessage({ type: 'streamChunk', text: ame.text });
          } else if (ame.type === 'thinking') {
            this.postMessage({ type: 'thinkingChunk', text: ame.text });
          }
        }
        break;

      case 'message_end':
        if (event.message.role === 'assistant') {
          this.postMessage({ type: 'streamEnd' });
        }
        break;

      case 'tool_execution_start':
        this.postMessage({
          type: 'toolExecStart',
          toolName: event.toolName,
          args: event.args,
        });
        break;

      case 'tool_execution_end':
        this.postMessage({
          type: 'toolExecEnd',
          toolName: event.toolName,
          result: typeof event.result === 'string'
            ? event.result.slice(0, 2000) // truncate for webview
            : '[complex result]',
          isError: event.isError,
        });
        break;

      case 'auto_compaction_start':
        this.postMessage({ type: 'compactionStart', reason: event.reason });
        break;

      case 'auto_compaction_end':
        this.postMessage({ type: 'compactionEnd', aborted: event.aborted });
        break;

      case 'auto_retry_start':
        this.postMessage({
          type: 'retryStart',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        });
        break;

      case 'auto_retry_end':
        this.postMessage({
          type: 'retryEnd',
          success: event.success,
        });
        break;
    }
  }

  private async _handleWebviewMessage(msg: any): Promise<void> {
    const session = this._adapter.currentSession;

    switch (msg.type) {
      case 'ready': {
        // Webview loaded – send current state
        if (session) {
          this.bindSession(session);
        }
        // Send available models
        try {
          const models = await this._adapter.getAvailableModels();
          this.postMessage({
            type: 'modelsAvailable',
            models: models.map((m) => ({
              provider: m.provider,
              id: m.id,
              name: m.name,
            })),
          });
        } catch {
          // silently – no models yet
        }
        break;
      }

      case 'prompt': {
        if (!session) {
          this.postMessage({ type: 'error', message: 'No active session. Set an API key first.' });
          return;
        }
        try {
          await session.prompt(msg.text);
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message ?? String(err) });
        }
        break;
      }

      case 'abort': {
        if (session) {
          await session.abort();
        }
        break;
      }

      case 'newSession': {
        if (session) {
          await session.newSession();
          this.bindSession(session);
        }
        break;
      }

      case 'selectModel': {
        if (!session) return;
        const model = this._adapter.modelRegistry.find(msg.provider, msg.modelId);
        if (model) {
          try {
            await session.setModel(model);
            this.postMessage({
              type: 'sessionInfo',
              model: { provider: model.provider, id: model.id, name: model.name },
              thinkingLevel: session.thinkingLevel,
              sessionId: session.sessionId,
            });
          } catch (err: any) {
            this.postMessage({ type: 'error', message: err.message ?? String(err) });
          }
        }
        break;
      }
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'),
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';" />
  <title>Perplx Chat</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
