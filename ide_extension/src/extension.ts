import * as os from 'os';
import * as vscode from 'vscode';
import { SessionManager } from 'perplx-tool';
import { SessionAdapter } from './session-adapter.js';
import { ChatViewProvider } from './panels/chat-view-provider.js';

// QuickPick item with an attached model reference
interface ModelQuickPickItem extends vscode.QuickPickItem {
  model: { provider: string; id: string; name?: string; contextWindow?: number; [key: string]: any };
}

// QuickPick item with an attached session path
interface SessionQuickPickItem extends vscode.QuickPickItem {
  sessionPath: string;
}

let adapter: SessionAdapter | undefined;
let chatViewProvider: ChatViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = getWorkspaceRoot();

  // --- Bootstrap shared runtime adapter ---
  adapter = new SessionAdapter({ cwd: workspaceRoot });

  // --- Webview sidebar ---
  chatViewProvider = new ChatViewProvider(context.extensionUri, adapter);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('perplx.openChat', () => {
      vscode.commands.executeCommand('perplx.chatView.focus');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplx.newSession', async () => {
      await ensureSession();
      const session = adapter!.currentSession;
      if (session) {
        await session.newSession();
        chatViewProvider?.bindSession(session);
        vscode.window.showInformationMessage('Perplx: New session started.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplx.abortRequest', async () => {
      const session = adapter?.currentSession;
      if (session?.isStreaming) {
        await session.abort();
        vscode.window.showInformationMessage('Perplx: Request aborted.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplx.selectModel', async () => {
      await ensureSession();
      const models = await adapter!.getAvailableModels();
      if (models.length === 0) {
        vscode.window.showWarningMessage(
          'No models available. Set an API key first with "Perplx: Set API Key".',
        );
        return;
      }

      const items: ModelQuickPickItem[] = models.map((m) => ({
        label: m.name ?? m.id,
        description: m.provider,
        detail: `Context: ${m.contextWindow?.toLocaleString() ?? '?'} tokens`,
        model: m,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a model',
      });
      if (!picked) return;

      const session = adapter!.currentSession;
      if (session) {
        try {
          await session.setModel(picked.model);
          chatViewProvider?.postMessage({
            type: 'sessionInfo',
            model: {
              provider: picked.model.provider,
              id: picked.model.id,
              name: picked.model.name,
            },
            thinkingLevel: session.thinkingLevel,
            sessionId: session.sessionId,
          });
          vscode.window.showInformationMessage(
            `Perplx: Using ${picked.model.name ?? picked.model.id}`,
          );
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to set model: ${err.message}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplx.cycleModel', async () => {
      await ensureSession();
      const session = adapter!.currentSession;
      if (!session) return;
      const result = await session.cycleModel();
      if (result) {
        chatViewProvider?.postMessage({
          type: 'sessionInfo',
          model: {
            provider: result.model.provider,
            id: result.model.id,
            name: result.model.name,
          },
          thinkingLevel: result.thinkingLevel,
          sessionId: session.sessionId,
        });
        vscode.window.showInformationMessage(
          `Perplx: Switched to ${result.model.name ?? result.model.id}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplx.setApiKey', async () => {
      const providers = [
        'anthropic',
        'openai',
        'google',
        'mistral',
        'deepseek',
        'openrouter',
        'xai',
        'perplexity',
      ];

      const provider = await vscode.window.showQuickPick(providers, {
        placeHolder: 'Select a provider',
      });
      if (!provider) return;

      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter API key for ${provider}`,
        password: true,
        placeHolder: 'sk-...',
      });
      if (!apiKey) return;

      adapter!.setApiKey(provider, apiKey);
      vscode.window.showInformationMessage(`Perplx: API key saved for ${provider}.`);

      // Re-create session with new auth
      try {
        const result = await adapter!.createSession();
        chatViewProvider?.bindSession(result.session);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Session init failed: ${err.message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplx.resumeSession', async () => {
      await ensureSession();
      const sessions = await SessionManager.listAll();
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('No saved sessions found.');
        return;
      }

      const items: SessionQuickPickItem[] = sessions.map((s) => ({
        label: s.name ?? s.id,
        description: s.modified.toLocaleString(),
        detail: `${s.cwd} — ${s.messageCount} messages`,
        sessionPath: s.path,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a session to resume',
      });
      if (!picked) return;

      const session = adapter!.currentSession;
      if (session) {
        const success = await session.switchSession(picked.sessionPath);
        if (success) {
          chatViewProvider?.bindSession(session);
          vscode.window.showInformationMessage('Perplx: Session resumed.');
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplx.compactSession', async () => {
      const session = adapter?.currentSession;
      if (!session) {
        vscode.window.showWarningMessage('No active session to compact.');
        return;
      }
      try {
        const result = await session.compact();
        vscode.window.showInformationMessage(
          `Perplx: Session compacted (${result.tokensBefore} tokens before).`,
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Compaction failed: ${err.message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplx.openSettings', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:perplx.perplx-code',
      );
    }),
  );

  // --- Auto-create session on startup if auth is available ---
  try {
    const models = await adapter.getAvailableModels();
    if (models.length > 0) {
      const result = await adapter.createSession();
      chatViewProvider.bindSession(result.session);
    }
  } catch {
    // No models available yet – user needs to set API key
  }

  // --- Watch for workspace changes ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // If workspace root changes, could re-init. For now, keep existing session.
    }),
  );
}

export async function deactivate(): Promise<void> {
  await adapter?.dispose();
  adapter = undefined;
}

// --- Helpers ---

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return os.homedir();
}

async function ensureSession(): Promise<void> {
  if (!adapter) return;
  if (adapter.currentSession) return;

  try {
    const result = await adapter.createSession();
    chatViewProvider?.bindSession(result.session);
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `Failed to create session: ${err.message}. Set an API key with "Perplx: Set API Key".`,
    );
  }
}
