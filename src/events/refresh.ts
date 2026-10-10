import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type MessageMentionOptions,
  type ModalSubmitInteraction,
} from 'discord.js';
import { extractEventInfo } from '../ai/extractEvent.js';
import { getEventInfo, listTimeline, saveEventInfo } from '../db/events.js';
import { getProject } from '../db/projects.js';
import { crawl } from '../web/crawl.js';
import { fetchHtml } from '../web/fetch.js';
import { createRenderer } from '../web/render.js';
import { buildEventMessages, buildFailureMessage, type EventMessage } from './card.js';
import { normalizeEvent } from './normalize.js';

export type RefreshInteraction = (ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction) & {
  guildId: string;
};

// Page and AI text can contain "@everyone"; never let it ping anyone.
export const NO_MENTIONS: MessageMentionOptions = { parse: [] };
const STATUS_EDIT_INTERVAL_MS = 1_500;

const inProgress = new Set<string>();

/** A message we keep editing while work runs, then replace with the result. */
async function openStatus(interaction: RefreshInteraction, content: string) {
  let edit: (options: InteractionEditReplyOptions) => Promise<unknown>;
  if (interaction.replied || interaction.deferred) {
    const message = await interaction.followUp({ content, allowedMentions: NO_MENTIONS });
    edit = (options) => interaction.webhook.editMessage(message, options);
  } else {
    await interaction.reply({ content, allowedMentions: NO_MENTIONS });
    edit = (options) => interaction.editReply(options);
  }

  let lastEdit = 0;
  return {
    /**
     * Progress update. Frequent updates are skipped to stay under Discord's rate limits;
     * pass `force` for a new stage the user should always see.
     */
    async progress(text: string, { force = false } = {}) {
      if (!force && Date.now() - lastEdit < STATUS_EDIT_INTERVAL_MS) return;
      lastEdit = Date.now();
      await edit({ content: text, allowedMentions: NO_MENTIONS }).catch(() => {});
    },
    /** Replace the status with the first result message and post the rest after it. */
    async finish(messages: EventMessage[]) {
      const [first, ...rest] = messages;
      if (!first) return;
      await edit({ content: null, ...first, allowedMentions: NO_MENTIONS });
      for (const message of rest) await interaction.followUp({ ...message, allowedMentions: NO_MENTIONS });
    },
  };
}

/** Send the stored event cards as a reply (used by /event). */
export async function replyWithEventCards(interaction: ChatInputCommandInteraction & { guildId: string }) {
  const event = getEventInfo(interaction.guildId);
  if (!event?.fetchedAt) {
    await interaction.reply({
      content: 'I haven’t read the hackathon site yet. An admin can run `/refresh`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const [first, ...rest] = buildEventMessages(event, listTimeline(interaction.guildId));
  await interaction.reply({ ...first!, allowedMentions: NO_MENTIONS });
  for (const message of rest) await interaction.followUp({ ...message, allowedMentions: NO_MENTIONS });
}

/**
 * Crawl the hackathon site, extract the event info with the AI model, save it, and post the
 * cards, editing a status message as it goes. Only one refresh runs per server at a time.
 */
export async function runEventRefresh(interaction: RefreshInteraction): Promise<void> {
  const { guildId } = interaction;
  const reply = (content: string) =>
    interaction.replied || interaction.deferred
      ? interaction.followUp({ content, flags: MessageFlags.Ephemeral })
      : interaction.reply({ content, flags: MessageFlags.Ephemeral });

  const project = getProject(guildId);
  if (!project) {
    await reply('Set up the project first with `/setup`.');
    return;
  }
  if (inProgress.has(guildId)) {
    await reply('I’m already reading the hackathon site, hang on.');
    return;
  }

  inProgress.add(guildId);
  try {
    const url = project.website_url;
    const status = await openStatus(interaction, `🔎 Reading ${url}…`);

    const renderer = await createRenderer();
    let result;
    try {
      result = await crawl(url, { fetchHtml, renderer }, {
        onPage: (page, count) =>
          status.progress(`🔎 Reading the hackathon site… ${count} page${count === 1 ? '' : 's'} so far (${new URL(page.url).host}${new URL(page.url).pathname})`),
      });
    } finally {
      await renderer?.close();
    }

    const pastedText = getEventInfo(guildId)?.pastedText ?? null;
    if (result.pages.length === 0 && !pastedText) {
      await status.finish([buildFailureMessage(url, result.skipped.map((page) => page.reason))]);
      return;
    }

    const pageCount = result.pages.length;
    const what = [
      pageCount ? `${pageCount} page${pageCount === 1 ? '' : 's'}` : null,
      pastedText ? 'your pasted text' : null,
    ].filter(Boolean).join(' and ');
    await status.progress(`🧠 Summarizing ${what}… (this takes about 30 seconds)`, { force: true });
    let raw;
    try {
      raw = await extractEventInfo({ startUrl: url, pages: result.pages, eventHints: result.eventHints, pastedText });
    } catch (error) {
      console.error(`Event extraction failed for guild ${guildId}:`, error);
      const reason = (error as Error).message.split('\n')[0]!.slice(0, 200);
      await status.finish([buildFailureMessage(url, [`I read the site, but summarizing it failed: ${reason}`])]);
      return;
    }

    const event = normalizeEvent(raw);
    saveEventInfo(guildId, url, event, {
      pages: result.pages.map((page) => ({ url: page.url, rendered: page.rendered })),
      skipped: result.skipped,
      unreadableTimes: event.unreadableTimes,
    });
    await status.finish(buildEventMessages(getEventInfo(guildId)!, listTimeline(guildId)));
  } finally {
    inProgress.delete(guildId);
  }
}
