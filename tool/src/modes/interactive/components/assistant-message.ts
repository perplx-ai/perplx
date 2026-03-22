import type { AssistantMessage } from '@mariozechner/pi-ai';
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from '@mariozechner/pi-tui';
import { getMarkdownTheme, theme } from '../theme/theme.js';

export class AssistantMessageComponent extends Container {
  private contentContainer: Container;
  private hideThinkingBlock: boolean;
  private markdownTheme: MarkdownTheme;
  private lastMessage?: AssistantMessage;

  constructor(message?: AssistantMessage, hideThinkingBlock = false, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
    super();

    this.hideThinkingBlock = hideThinkingBlock;
    this.markdownTheme = markdownTheme;

    this.contentContainer = new Container();
    this.addChild(this.contentContainer);

    if (message) {
      this.updateContent(message);
    }
  }

  override invalidate(): void {
    super.invalidate();
    if (this.lastMessage) {
      this.updateContent(this.lastMessage);
    }
  }

  setHideThinkingBlock(hide: boolean): void {
    this.hideThinkingBlock = hide;
  }

  updateContent(message: AssistantMessage): void {
    this.lastMessage = message;

    this.contentContainer.clear();

    const hasVisibleContent = message.content.some(c => (c.type === 'text' && c.text.trim()) || (c.type === 'thinking' && c.thinking.trim()));

    if (hasVisibleContent) {
      this.contentContainer.addChild(new Spacer(1));
    }

    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i];
      if (content.type === 'text' && content.text.trim()) {
        this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme));
      } else if (content.type === 'thinking' && content.thinking.trim()) {
        const hasVisibleContentAfter = message.content
          .slice(i + 1)
          .some(c => (c.type === 'text' && c.text.trim()) || (c.type === 'thinking' && c.thinking.trim()));

        if (this.hideThinkingBlock) {
          this.contentContainer.addChild(new Text(theme.italic(theme.fg('thinkingText', 'Thinking...')), 1, 0));
          if (hasVisibleContentAfter) {
            this.contentContainer.addChild(new Spacer(1));
          }
        } else {
          this.contentContainer.addChild(
            new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
              color: (text: string) => theme.fg('thinkingText', text),
              italic: true
            })
          );
          if (hasVisibleContentAfter) {
            this.contentContainer.addChild(new Spacer(1));
          }
        }
      }
    }

    const hasToolCalls = message.content.some(c => c.type === 'toolCall');
    if (!hasToolCalls) {
      if (message.stopReason === 'aborted') {
        const abortMessage = message.errorMessage && message.errorMessage !== 'Request was aborted' ? message.errorMessage : 'Operation aborted';
        if (hasVisibleContent) {
          this.contentContainer.addChild(new Spacer(1));
        } else {
          this.contentContainer.addChild(new Spacer(1));
        }
        this.contentContainer.addChild(new Text(theme.fg('error', abortMessage), 1, 0));
      } else if (message.stopReason === 'error') {
        const errorMsg = message.errorMessage || 'Unknown error';
        this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(new Text(theme.fg('error', `Error: ${errorMsg}`), 1, 0));
      }
    }
  }
}
