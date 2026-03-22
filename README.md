# perplx

**Knowledge is enough.** The terminal-native AI coding agent for everyone.

📖 [Docs](https://perplx.net/getting-started)

## Features

- **AI-Powered Coding** — Leverage Perplexity's deep reasoning to write, refactor, and debug code with full context awareness
- **Terminal Native** — Runs entirely in your terminal with interactive and non-interactive modes
- **Web Search** — Built-in web search tool powered by the Perplexity Search API for up-to-date documentation and references
- **Session Management** — Conversations are automatically saved and can be continued or resumed
- **Session Sharing** — Share coding sessions via [share.perplx.net](https://share.perplx.net) with full markdown and syntax highlighting
- **File & Image Input** — Attach source files or images as context using `@` prefixed paths
- **Extensible** — Support for custom extensions, skills, prompt templates, and themes

## Installation

Requires [Bun](https://bun.sh) and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/themackabu/perplx.git
cd perplx/tool
pnpm install
bun build src/cli.ts --target node --compile --outfile ~/.local/bin/perplx
```

Make sure `~/.local/bin` is in your `PATH`.

For development:

```bash
cd perplx/tool
pnpm dev
```

## Authentication

On first launch, you'll be prompted to authenticate with a [Perplexity API key](https://console.perplexity.ai):

```
$ perplx
# Go to https://console.perplexity.ai
# Navigate to the API Keys tab and generate a new key.
# Paste your Perplexity API key: pplx-xxxxxxxx...
```

Credentials are stored locally at `~/.perplx/agent/auth.json`.

## Usage

### Interactive Mode

Launch `perplx` in any project directory to start a conversation:

```bash
$ perplx
> add error handling to the database module
> now write tests for it
```

Use <kbd>Ctrl+P</kbd> to cycle between models during a session.

### Print Mode

For scripting and pipelines — process a prompt and exit:

```bash
perplx -p "explain this function" @src/utils.ts
```

Pipe stdin:

```bash
cat error.log | perplx "what went wrong?"
```

### File Input

Attach files as context with `@`:

```bash
perplx @src/auth.ts @src/middleware.ts "refactor these to use a shared session"
```

### Sessions

```bash
perplx --continue    # continue the last session
perplx --resume      # browse and select a session to resume
```

## Models

Three model tiers served through the Perplexity Agent API:

| Model            | ID      | Backed By                       | Context | Reasoning |
| ---------------- | ------- | ------------------------------- | ------- | --------- |
| Perplexity Rush  | `rush`  | Claude Haiku 4.5 / GPT-5.4 mini | 200k    | —         |
| Perplexity Fast  | `fast`  | Claude Sonnet 4.6 / Codex-5.3   | 200k    | ✓         |
| Perplexity Smart | `smart` | Claude Opus 4.6 / GPT-5.4 large | 200k    | ✓         |

Default model is `smart`.

## CLI Reference

| Flag                       | Short | Description                                 |
| -------------------------- | ----- | ------------------------------------------- |
| `--print`                  | `-p`  | Non-interactive mode                        |
| `--continue`               | `-c`  | Continue previous session                   |
| `--resume`                 | `-r`  | Select a session to resume                  |
| `--extension <path>`       | `-e`  | Load an extension file (repeatable)         |
| `--no-extensions`          | `-ne` | Disable extension discovery                 |
| `--skill <path>`           |       | Load a skill file or directory (repeatable) |
| `--no-skills`              | `-ns` | Disable skill discovery                     |
| `--prompt-template <path>` |       | Load a prompt template (repeatable)         |
| `--no-prompt-templates`    | `-np` | Disable prompt template discovery           |
| `--theme <path>`           |       | Load a theme file or directory (repeatable) |
| `--no-themes`              |       | Disable theme discovery                     |
| `--verbose`                |       | Force verbose startup output                |
| `--help`                   | `-h`  | Show help                                   |
| `--version`                | `-v`  | Show version number                         |

## Configuration

All configuration lives under `~/.perplx/`:

| Path                            | Description                                   |
| ------------------------------- | --------------------------------------------- |
| `~/.perplx/agent/auth.json`     | API credentials                               |
| `~/.perplx/agent/settings.json` | User preferences (theme, default model, etc.) |
| `~/.perplx/agent/models.json`   | Custom model configuration                    |
| `~/.perplx/agent/sessions/`     | Saved conversation sessions                   |

## Project Structure

```
perplx/
├── tool/
│   └── src/
│       ├── cli/        # Argument parsing & file processing
│       ├── core/       # Agent session, tools, settings, extensions
│       ├── modes/      # Interactive & print modes
│       ├── providers/  # Perplexity provider & web search tool
│       └── utils/
├── worker/         # Session sharing backend (Cloudflare Worker + Hono + D1)
├── website/        # Landing page & docs (static, Cloudflare Pages)
└── drafts/         # Design drafts
```
