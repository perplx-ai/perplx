import { type Component, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import type { AgentSession } from '../../../core/agent-session.js';
import type { ReadonlyFooterDataProvider } from '../../../core/footer-data-provider.js';
import { theme } from '../theme/theme.js';

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export class FooterComponent implements Component {
  private autoCompactEnabled = true;

  constructor(
    private session: AgentSession,
    private footerData: ReadonlyFooterDataProvider
  ) {}

  setAutoCompactEnabled(enabled: boolean): void {
    this.autoCompactEnabled = enabled;
  }

  invalidate(): void {}

  dispose(): void {}

  render(width: number): string[] {
    const state = this.session.state;

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

    for (const entry of this.session.sessionManager.getEntries()) {
      if (entry.type === 'message' && entry.message.role === 'assistant') {
        totalInput += entry.message.usage.input;
        totalOutput += entry.message.usage.output;
        totalCacheRead += entry.message.usage.cacheRead;
        totalCacheWrite += entry.message.usage.cacheWrite;
        totalCost += entry.message.usage.cost.total;
      }
    }

    const contextUsage = this.session.getContextUsage();
    const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
    const contextPercentValue = contextUsage?.percent ?? 0;
    const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : '?';

    let pwd = process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home && pwd.startsWith(home)) {
      pwd = `~${pwd.slice(home.length)}`;
    }

    const branch = this.footerData.getGitBranch();
    if (branch) {
      pwd = `${pwd} (${branch})`;
    }

    const sessionName = this.session.sessionManager.getSessionName();
    if (sessionName) {
      pwd = `${pwd} • ${sessionName}`;
    }

    const statsParts = [];
    if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
    if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
    if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
    if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

    const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
    if (totalCost || usingSubscription) {
      const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? ' (sub)' : ''}`;
      statsParts.push(costStr);
    }

    let contextPercentStr: string;
    const autoIndicator = this.autoCompactEnabled ? ' (auto)' : '';
    const contextPercentDisplay =
      contextPercent === '?'
        ? `?/${formatTokens(contextWindow)}${autoIndicator}`
        : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
    if (contextPercentValue > 90) {
      contextPercentStr = theme.fg('error', contextPercentDisplay);
    } else if (contextPercentValue > 70) {
      contextPercentStr = theme.fg('warning', contextPercentDisplay);
    } else {
      contextPercentStr = contextPercentDisplay;
    }
    statsParts.push(contextPercentStr);

    let statsLeft = statsParts.join(' ');

    const modelName = state.model?.id || 'no-model';

    let statsLeftWidth = visibleWidth(statsLeft);

    if (statsLeftWidth > width) {
      statsLeft = truncateToWidth(statsLeft, width, '...');
      statsLeftWidth = visibleWidth(statsLeft);
    }

    const minPadding = 2;

    let rightSideWithoutProvider = modelName;
    if (state.model?.reasoning) {
      const thinkingLevel = state.thinkingLevel || 'off';
      rightSideWithoutProvider = thinkingLevel === 'off' ? `perplexity/${modelName} • thinking off` : `perplexity/${modelName} • ${thinkingLevel}`;
    }

    let rightSide = rightSideWithoutProvider;
    if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
      rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
      if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
        rightSide = rightSideWithoutProvider;
      }
    }

    const rightSideWidth = visibleWidth(rightSide);
    const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

    let statsLine: string;
    if (totalNeeded <= width) {
      const padding = ' '.repeat(width - statsLeftWidth - rightSideWidth);
      statsLine = statsLeft + padding + rightSide;
    } else {
      const availableForRight = width - statsLeftWidth - minPadding;
      if (availableForRight > 0) {
        const truncatedRight = truncateToWidth(rightSide, availableForRight, '');
        const truncatedRightWidth = visibleWidth(truncatedRight);
        const padding = ' '.repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
        statsLine = statsLeft + padding + truncatedRight;
      } else {
        statsLine = statsLeft;
      }
    }

    const dimStatsLeft = theme.fg('dim', statsLeft);
    const remainder = statsLine.slice(statsLeft.length);
    const dimRemainder = theme.fg('dim', remainder);

    const pwdLine = truncateToWidth(theme.fg('dim', pwd), width, theme.fg('dim', '...'));
    const lines = [pwdLine, dimStatsLeft + dimRemainder];

    const extensionStatuses = this.footerData.getExtensionStatuses();
    if (extensionStatuses.size > 0) {
      const sortedStatuses = Array.from(extensionStatuses.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatusText(text));
      const statusLine = sortedStatuses.join(' ');

      lines.push(truncateToWidth(statusLine, width, theme.fg('dim', '...')));
    }

    return lines;
  }
}
