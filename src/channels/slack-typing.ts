/**
 * Slack typing indicator — assistant API with emoji reaction fallback.
 * Extracted from slack.ts for cleaner upstream merges.
 *
 * Strategy:
 * 1. Try Slack's assistant.threads.setStatus (native "is typing..." in thread)
 * 2. Fall back to adding/removing an hourglass emoji reaction on the user's message
 *
 * The assistant API only works when the Slack app has "Agents & AI Apps" enabled
 * and the assistant:write scope. Availability is detected per-channel at runtime.
 */
import type { App } from '@slack/bolt';

import { logger } from '../logger.js';

// Emoji reaction added to the user's message while the bot is processing.
// Requires reactions:write scope. Visible from the channel without opening the thread.
const THINKING_REACTION = 'hourglass_flowing_sand';

export class SlackTypingIndicator {
  // Whether the assistant.threads.setStatus API is available per channel (detected at runtime).
  // undefined = not yet tested, true = works, false = not available (fall back to reaction).
  // Keyed by channelId because the API only works in AI-app DM threads, not regular channels.
  private assistantStatusAvailable = new Map<string, boolean>();

  // Thinking indicator state.
  // When using assistant API: stores 'assistant:<thread_ts>' so stop knows how to clear.
  // When using reaction fallback: stores 'reaction:<channelId>:<msgTs>'.
  private thinkingTs = new Map<string, string>();

  constructor(private app: App) {}

  /** Show or hide the typing indicator for a given jid. */
  async setTyping(
    jid: string,
    isTyping: boolean,
    threadTs: string | undefined,
    lastUserMessageTs: string | undefined,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (isTyping) {
      if (this.thinkingTs.has(jid)) return; // already showing

      // Try the native assistant typing indicator first.
      // Requires assistant:write scope + "Agents & AI Apps" enabled in the Slack app.
      if (threadTs && this.assistantStatusAvailable.get(channelId) !== false) {
        try {
          await (
            this.app.client as unknown as {
              apiCall: (
                method: string,
                args: Record<string, unknown>,
              ) => Promise<void>;
            }
          ).apiCall('assistant.threads.setStatus', {
            channel_id: channelId,
            thread_ts: threadTs,
            status: 'is typing...',
          });
          this.thinkingTs.set(jid, `assistant:${threadTs}`);
          this.assistantStatusAvailable.set(channelId, true);
          return;
        } catch (err) {
          this.assistantStatusAvailable.set(channelId, false);
          logger.info(
            { jid, err },
            'assistant.threads.setStatus unavailable, falling back to reaction',
          );
        }
      }

      // Fallback: add a thinking emoji reaction to the user's message.
      // Visible in the channel without needing the thread open.
      if (lastUserMessageTs) {
        try {
          await this.app.client.reactions.add({
            channel: channelId,
            timestamp: lastUserMessageTs,
            name: THINKING_REACTION,
          });
          this.thinkingTs.set(
            jid,
            `reaction:${channelId}:${lastUserMessageTs}`,
          );
        } catch (err) {
          logger.warn({ jid, err }, 'Failed to add thinking reaction');
        }
      }
    } else {
      const ts = this.thinkingTs.get(jid);
      if (!ts) return;
      this.thinkingTs.delete(jid);

      if (ts.startsWith('assistant:')) {
        // Clear the native assistant typing indicator
        const indicatorThreadTs = ts.slice('assistant:'.length);
        try {
          await (
            this.app.client as unknown as {
              apiCall: (
                method: string,
                args: Record<string, unknown>,
              ) => Promise<void>;
            }
          ).apiCall('assistant.threads.setStatus', {
            channel_id: channelId,
            thread_ts: indicatorThreadTs,
            status: '',
          });
        } catch (err) {
          logger.warn(
            { jid, err },
            'Failed to clear assistant typing indicator',
          );
        }
      } else if (ts.startsWith('reaction:')) {
        // Remove the thinking emoji reaction
        const parts = ts.split(':');
        const rxChannel = parts[1];
        const rxTs = parts[2];
        try {
          await this.app.client.reactions.remove({
            channel: rxChannel,
            timestamp: rxTs,
            name: THINKING_REACTION,
          });
        } catch (err) {
          logger.warn({ jid, err }, 'Failed to remove thinking reaction');
        }
      }
    }
  }
}
