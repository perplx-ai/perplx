# Perplx Code — VS Code / Cursor Extension

AI coding agent powered by the Perplexity Agent API, directly in your editor sidebar.

## Features

- **Chat sidebar** — Ask questions, write code, and run tasks from a persistent chat panel.
- **Full tool support** — The agent can read/edit files, run shell commands, grep, find — all within your workspace.
- **Multi-model** — Switch between Anthropic, OpenAI, Google, Mistral, DeepSeek, xAI, Perplexity and custom providers.
- **Session management** — Sessions persist to disk. Resume, fork, branch, and compact long conversations.
- **Context compaction** — Automatic context window management when conversations get long.
- **Thinking levels** — Control reasoning depth (off → minimal → low → medium → high → xhigh).

## Architecture

This extension reuses the **shared `tool/` runtime** from the perplx CLI:

```
ide_extension/
├── src/
│   ├── extension.ts           ← VS Code entry point & commands
│   ├── session-adapter.ts     ← Adapter wrapping tool/src/core/* for extension use
│   ├── panels/
│   │   └── chat-view-provider.ts  ← Sidebar webview provider
│   └── webview/
│       └── main.ts            ← Chat UI (runs in webview browser context)
├── package.json               ← Extension manifest
├── esbuild.js                 ← Build script (extension host + webview bundles)
└── tsconfig.json
```

The key shared modules consumed from `../tool/src/`:
- `core/agent-session.ts` — Session orchestration, prompt handling, event bus
- `core/model-registry.ts` — Provider/model resolution with custom models.json support
- `core/auth-storage.ts` — Encrypted API key storage
- `core/sdk.ts` — `createAgentSession()` factory
- `core/session-manager.ts` — Persistent session log
- `core/settings-manager.ts` — User/project settings
- `core/tools/*` — read, edit, write, bash, grep, find, ls
- `providers/*` — Perplexity provider registration

## Getting Started

### Prerequisites

- Node.js 18+
- The `tool/` package must have its dependencies installed (`cd ../tool && pnpm install`)

### Install & Build

```bash
cd ide_extension
npm install
npm run compile
```

### Run in Development

1. Open the `ide_extension/` folder in VS Code/Cursor
2. Press **F5** to launch the Extension Development Host
3. In the new window, find the **Perplx** icon in the Activity Bar (left sidebar)
4. Set an API key: `Cmd/Ctrl+Shift+P` → `Perplx: Set API Key`
5. Start chatting!

### Package as VSIX

```bash
npx vsce package
```

The resulting `.vsix` can be installed in VS Code or Cursor via  
`Extensions: Install from VSIX...` in the command palette.

## Commands

| Command | Description |
|---------|-------------|
| `Perplx: Open Chat` | Focus the chat sidebar |
| `Perplx: New Session` | Start a fresh conversation |
| `Perplx: Abort Current Request` | Stop the current streaming response |
| `Perplx: Select Model` | Pick a model from available providers |
| `Perplx: Cycle Model` | Cycle through available models |
| `Perplx: Set API Key` | Configure an API key for a provider |
| `Perplx: Resume Session` | Resume a previous session from disk |
| `Perplx: Compact Session` | Manually compact the session context |
| `Perplx: Open Settings` | Open extension settings |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `perplx.defaultModel` | `""` | Default model ID |
| `perplx.defaultProvider` | `""` | Default provider name |
| `perplx.thinkingLevel` | `"medium"` | Default thinking level |
| `perplx.autoCompaction` | `true` | Enable auto context compaction |
| `perplx.autoRetry` | `true` | Auto-retry on transient errors |

## Cursor Compatibility

This extension targets the standard VS Code extension API (`^1.85.0`) and works in both:
- **VS Code** — Install directly or via VSIX
- **Cursor** — Install via `Extensions: Install from VSIX...`

No Microsoft-specific APIs are used, ensuring compatibility with VS Code forks.

## Technical Notes

- **No `process.exit()`** — The session adapter and all shared paths avoid hard process termination.
- **Explicit `cwd`** — The workspace root is always passed explicitly, never relying on `process.cwd()`.
- **Desktop only** — Node.js-based tools (bash, filesystem) run in the extension host, not web workers.
- **CLI unchanged** — The existing `tool/` CLI entrypoint is unmodified and continues to work independently.
