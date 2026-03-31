/**
 * Webview entry point – runs inside the VS Code webview iframe (browser context).
 * Communicates with the extension host via postMessage.
 */

// @ts-ignore – acquireVsCodeApi is injected by VS Code
const vscode = acquireVsCodeApi();

// ---------- State ----------

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'thinking' | 'system';
  content: string;
  toolName?: string;
  isError?: boolean;
}

interface AppState {
  messages: ChatMessage[];
  isStreaming: boolean;
  currentStreamText: string;
  currentThinkingText: string;
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: string;
  sessionId: string;
  models: { provider: string; id: string; name: string }[];
}

const state: AppState = {
  messages: [],
  isStreaming: false,
  currentStreamText: '',
  currentThinkingText: '',
  model: null,
  thinkingLevel: 'medium',
  sessionId: '',
  models: [],
};

// ---------- DOM ----------

const root = document.getElementById('root')!;
root.innerHTML = '';

// Inject styles
const style = document.createElement('style');
style.textContent = /* css */ `
  :root {
    --font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
    --font-size: var(--vscode-font-size, 13px);
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground, #cccccc);
    --input-border: var(--vscode-input-border, #3c3c3c);
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #ffffff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
    --border: var(--vscode-panel-border, #2d2d2d);
    --badge-bg: var(--vscode-badge-background, #4d4d4d);
    --badge-fg: var(--vscode-badge-foreground, #ffffff);
    --error-fg: var(--vscode-errorForeground, #f48771);
    --link: var(--vscode-textLink-foreground, #3794ff);
    --desc: var(--vscode-descriptionForeground, #969696);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font-family);
    font-size: var(--font-size);
    color: var(--fg);
    background: var(--bg);
    height: 100vh;
    overflow: hidden;
  }

  #root {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  /* Header bar */
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    min-height: 36px;
    flex-shrink: 0;
  }
  .header-model {
    font-weight: 600;
    font-size: 12px;
  }
  .header-session {
    color: var(--desc);
    font-size: 11px;
    margin-left: auto;
  }
  .header-thinking {
    font-size: 11px;
    color: var(--desc);
    background: var(--badge-bg);
    color: var(--badge-fg);
    padding: 1px 6px;
    border-radius: 3px;
  }

  /* Messages area */
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .msg {
    padding: 8px 10px;
    border-radius: 6px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 13px;
  }
  .msg-user {
    background: var(--btn-bg);
    color: var(--btn-fg);
    align-self: flex-end;
    max-width: 85%;
    border-radius: 12px 12px 2px 12px;
  }
  .msg-assistant {
    background: var(--input-bg);
    align-self: flex-start;
    max-width: 95%;
    border-radius: 12px 12px 12px 2px;
  }
  .msg-tool {
    background: transparent;
    border: 1px solid var(--border);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--desc);
    padding: 4px 8px;
  }
  .msg-tool.error {
    border-color: var(--error-fg);
    color: var(--error-fg);
  }
  .msg-thinking {
    color: var(--desc);
    font-style: italic;
    font-size: 12px;
    padding: 4px 8px;
    border-left: 2px solid var(--badge-bg);
  }
  .msg-system {
    color: var(--desc);
    font-size: 12px;
    text-align: center;
    padding: 4px;
  }
  .msg code {
    background: var(--badge-bg);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }
  .msg pre {
    background: var(--badge-bg);
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 6px 0;
  }
  .msg pre code {
    background: none;
    padding: 0;
  }

  /* Streaming indicator */
  .streaming-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--link);
    animation: blink 1s infinite;
    margin-left: 4px;
    vertical-align: middle;
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  /* Input area */
  .input-area {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .input-area textarea {
    flex: 1;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 6px;
    padding: 8px 10px;
    font-family: var(--font-family);
    font-size: var(--font-size);
    resize: none;
    outline: none;
    min-height: 38px;
    max-height: 200px;
    line-height: 1.4;
  }
  .input-area textarea:focus {
    border-color: var(--link);
  }
  .input-area textarea::placeholder {
    color: var(--vscode-input-placeholderForeground, #888);
  }
  .input-area button {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    border-radius: 6px;
    padding: 0 14px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }
  .input-area button:hover {
    background: var(--btn-hover);
  }
  .input-area button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .input-area button.abort-btn {
    background: var(--error-fg);
    color: #fff;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    flex: 1;
    padding: 40px 20px;
    text-align: center;
    color: var(--desc);
  }
  .empty-state h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--fg);
  }
  .empty-state p {
    font-size: 13px;
    max-width: 280px;
    line-height: 1.5;
  }

  /* Model selector */
  .model-select {
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 12px;
    cursor: pointer;
    outline: none;
  }
`;
document.head.appendChild(style);

// Build DOM structure
const headerEl = document.createElement('div');
headerEl.className = 'header';

const modelLabel = document.createElement('span');
modelLabel.className = 'header-model';

const thinkingBadge = document.createElement('span');
thinkingBadge.className = 'header-thinking';

const sessionLabel = document.createElement('span');
sessionLabel.className = 'header-session';

headerEl.append(modelLabel, thinkingBadge, sessionLabel);

const messagesEl = document.createElement('div');
messagesEl.className = 'messages';

const inputArea = document.createElement('div');
inputArea.className = 'input-area';

const textarea = document.createElement('textarea');
textarea.placeholder = 'Ask anything... (Shift+Enter for newline)';
textarea.rows = 1;

const sendBtn = document.createElement('button');
sendBtn.textContent = 'Send';

inputArea.append(textarea, sendBtn);
root.append(headerEl, messagesEl, inputArea);

// ---------- Rendering ----------

function render(): void {
  // Header
  if (state.model) {
    modelLabel.textContent = state.model.name ?? state.model.id;
  } else {
    modelLabel.textContent = 'No model';
  }
  thinkingBadge.textContent = state.thinkingLevel;
  thinkingBadge.style.display = state.thinkingLevel === 'off' ? 'none' : '';
  sessionLabel.textContent = state.sessionId ? `#${state.sessionId.slice(0, 8)}` : '';

  // Messages
  messagesEl.innerHTML = '';

  if (state.messages.length === 0 && !state.isStreaming) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <h2>Perplx Code</h2>
      <p>AI coding agent powered by the Perplexity Agent API. Ask a question or describe a task to get started.</p>
    `;
    messagesEl.appendChild(empty);
  } else {
    for (const msg of state.messages) {
      messagesEl.appendChild(createMessageEl(msg));
    }

    // Streaming assistant text
    if (state.isStreaming && state.currentStreamText) {
      const el = document.createElement('div');
      el.className = 'msg msg-assistant';
      el.innerHTML = renderMarkdownBasic(state.currentStreamText);
      const dot = document.createElement('span');
      dot.className = 'streaming-dot';
      el.appendChild(dot);
      messagesEl.appendChild(el);
    } else if (state.isStreaming) {
      const el = document.createElement('div');
      el.className = 'msg msg-assistant';
      el.innerHTML = '<span class="streaming-dot"></span> Thinking...';
      messagesEl.appendChild(el);
    }

    // Thinking text
    if (state.currentThinkingText) {
      const el = document.createElement('div');
      el.className = 'msg msg-thinking';
      el.textContent = state.currentThinkingText.slice(-500); // show tail
      messagesEl.appendChild(el);
    }
  }

  // Scroll to bottom
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // Button state
  if (state.isStreaming) {
    sendBtn.textContent = 'Stop';
    sendBtn.className = 'abort-btn';
    sendBtn.disabled = false;
  } else {
    sendBtn.textContent = 'Send';
    sendBtn.className = '';
    sendBtn.disabled = false;
  }
}

function createMessageEl(msg: ChatMessage): HTMLElement {
  const el = document.createElement('div');
  if (msg.role === 'user') {
    el.className = 'msg msg-user';
    el.textContent = msg.content;
  } else if (msg.role === 'assistant') {
    el.className = 'msg msg-assistant';
    el.innerHTML = renderMarkdownBasic(msg.content);
  } else if (msg.role === 'tool') {
    el.className = `msg msg-tool${msg.isError ? ' error' : ''}`;
    const label = msg.toolName ? `[${msg.toolName}] ` : '';
    el.textContent = label + msg.content;
  } else if (msg.role === 'thinking') {
    el.className = 'msg msg-thinking';
    el.textContent = msg.content;
  } else {
    el.className = 'msg msg-system';
    el.textContent = msg.content;
  }
  return el;
}

/** Very basic markdown→HTML (code blocks, inline code, bold, links). */
function renderMarkdownBasic(text: string): string {
  let html = escapeHtml(text);

  // Code blocks: ```lang\n...\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Links
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
    '<a href="$2" style="color:var(--link)">$1</a>',
  );

  // Line breaks
  html = html.replace(/\n/g, '<br/>');

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Input handling ----------

function sendMessage(): void {
  const text = textarea.value.trim();
  if (!text) return;

  if (state.isStreaming) {
    vscode.postMessage({ type: 'abort' });
    return;
  }

  state.messages.push({ role: 'user', content: text });
  textarea.value = '';
  textarea.style.height = 'auto';
  render();

  vscode.postMessage({ type: 'prompt', text });
}

sendBtn.addEventListener('click', sendMessage);

textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
textarea.addEventListener('input', () => {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
});

// ---------- Message handler ----------

window.addEventListener('message', (event) => {
  const msg = event.data;

  switch (msg.type) {
    case 'streamStart':
      state.isStreaming = true;
      state.currentStreamText = '';
      state.currentThinkingText = '';
      render();
      break;

    case 'streamChunk':
      state.currentStreamText += msg.text;
      render();
      break;

    case 'thinkingChunk':
      state.currentThinkingText += msg.text;
      render();
      break;

    case 'streamEnd':
      if (state.currentStreamText) {
        state.messages.push({ role: 'assistant', content: state.currentStreamText });
      }
      state.isStreaming = false;
      state.currentStreamText = '';
      state.currentThinkingText = '';
      render();
      break;

    case 'toolExecStart':
      state.messages.push({
        role: 'tool',
        content: `Running ${msg.toolName}...`,
        toolName: msg.toolName,
      });
      render();
      break;

    case 'toolExecEnd': {
      // Replace the "Running..." placeholder with the result
      const lastTool = [...state.messages]
        .reverse()
        .find(
          (m) =>
            m.role === 'tool' &&
            m.toolName === msg.toolName &&
            m.content.startsWith('Running'),
        );
      if (lastTool) {
        const preview =
          typeof msg.result === 'string'
            ? msg.result.slice(0, 500)
            : String(msg.result);
        lastTool.content = preview;
        lastTool.isError = msg.isError;
      }
      render();
      break;
    }

    case 'error':
      state.messages.push({ role: 'system', content: `Error: ${msg.message}` });
      state.isStreaming = false;
      render();
      break;

    case 'sessionInfo':
      state.model = msg.model;
      state.thinkingLevel = msg.thinkingLevel ?? 'off';
      state.sessionId = msg.sessionId ?? '';
      render();
      break;

    case 'modelsAvailable':
      state.models = msg.models ?? [];
      break;

    case 'compactionStart':
      state.messages.push({
        role: 'system',
        content: `Compacting context (${msg.reason})...`,
      });
      render();
      break;

    case 'compactionEnd':
      state.messages.push({
        role: 'system',
        content: msg.aborted ? 'Compaction aborted.' : 'Context compacted.',
      });
      render();
      break;

    case 'retryStart':
      state.messages.push({
        role: 'system',
        content: `Retrying (attempt ${msg.attempt}/${msg.maxAttempts})...`,
      });
      render();
      break;

    case 'retryEnd':
      if (!msg.success) {
        state.messages.push({ role: 'system', content: 'Retry failed.' });
        state.isStreaming = false;
      }
      render();
      break;
  }
});

// ---------- Init ----------

render();
vscode.postMessage({ type: 'ready' });
