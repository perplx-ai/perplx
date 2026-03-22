import type { AssistantMessage, ImageContent } from '@mariozechner/pi-ai';
import type { AgentSession } from '../core/agent-session.js';

export interface PrintModeOptions {
  mode: 'text' | 'json';
  messages?: string[];
  initialMessage?: string;
  initialImages?: ImageContent[];
}

export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
  const { mode, messages = [], initialMessage, initialImages } = options;
  if (mode === 'json') {
    const header = session.sessionManager.getHeader();
    if (header) {
      console.log(JSON.stringify(header));
    }
  }

  await session.bindExtensions({
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      newSession: async options => {
        const success = await session.newSession({ parentSession: options?.parentSession });
        if (success && options?.setup) {
          await options.setup(session.sessionManager);
        }
        return { cancelled: !success };
      },
      fork: async entryId => {
        const result = await session.fork(entryId);
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId, options) => {
        const result = await session.navigateTree(targetId, {
          summarize: options?.summarize,
          customInstructions: options?.customInstructions,
          replaceInstructions: options?.replaceInstructions,
          label: options?.label
        });
        return { cancelled: result.cancelled };
      },
      switchSession: async sessionPath => {
        const success = await session.switchSession(sessionPath);
        return { cancelled: !success };
      },
      reload: async () => {
        await session.reload();
      }
    },
    onError: err => {
      console.error(`Extension error (${err.extensionPath}): ${err.error}`);
    }
  });

  session.subscribe(event => {
    if (mode === 'json') {
      console.log(JSON.stringify(event));
    }
  });

  if (initialMessage) {
    await session.prompt(initialMessage, { images: initialImages });
  }

  for (const message of messages) {
    await session.prompt(message);
  }

  if (mode === 'text') {
    const state = session.state;
    const lastMessage = state.messages[state.messages.length - 1];

    if (lastMessage?.role === 'assistant') {
      const assistantMsg = lastMessage as AssistantMessage;

      if (assistantMsg.stopReason === 'error' || assistantMsg.stopReason === 'aborted') {
        console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
        process.exit(1);
      }

      for (const content of assistantMsg.content) {
        if (content.type === 'text') {
          console.log(content.text);
        }
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', err => {
      if (err) reject(err);
      else resolve();
    });
  });
}
