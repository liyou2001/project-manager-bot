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

/** A failure whose message is already written for the user. */
class RefreshError extends Error {}

const firstLine = (error: unknown) => ((error as Error)?.message ?? String(error)).split('\n')[0]!.slice(0, 200);

type Status = Awaited<ReturnType<typeof openStatus>>;

/** The steps of a refresh after the status message is up. Throws on failure. */
async function readSite(status: Status, guildId: string, url: string): Promise<void> {
  // Pasted text and a manual time zone only carry over while the link stays the same.
  const previous = getEventInfo(guildId);
  const sameSource = previous?.sourceUrl === url;
  const pastedText = sameSource ? previous.pastedText : null;
  const timezoneOverride = sameSource ? previous.timezoneOverride : null;

  const renderer = createRenderer();
  let result;
  try {
    result = await crawl(url, { fetchHtml, renderer }, {
      onPage: (page, count) => {
        const where = `${new URL(page.url).host}${new URL(page.url).pathname}`;
        return status.progress(`🔎 Reading the hackathon site… ${count} page${count === 1 ? '' : 's'} so far (${where})`);
      },
    });
  } finally {
    await renderer.close();
  }

  if (result.pages.length === 0 && !pastedText) {
    await status.finish([buildFailureMessage(url, result.skipped.map((page) => page.reason))]);
    return;
  }

  const pageCount = result.pages.length;
  const what = [pageCount ? `${pageCount} page${pageCount === 1 ? '' : 's'}` : null, pastedText ? 'your pasted text' : null]
    .filter(Boolean)
    .join(' and ');
  await status.progress(`🧠 Summarizing ${what}… (this takes about 30 seconds)`, { force: true });

  let raw;
  try {
    raw = await extractEventInfo({ startUrl: url, pages: result.pages, eventHints: result.eventHints, pastedText });
  } catch (error) {
    throw new RefreshError(`I read the site, but summarizing it failed: ${firstLine(error)}`, { cause: error });
  }

  const event = normalizeEvent(raw, { timezoneOverride });
  saveEventInfo(guildId, url, event, {
    pages: result.pages.map((page) => ({ url: page.url, rendered: page.rendered })),
    skipped: result.skipped,
    unreadableTimes: event.unreadableTimes,
  });
  await status.finish(buildEventMessages(getEventInfo(guildId)!, listTimeline(guildId)));
}

/**
 * Crawl the hackathon site, extract the event info with the AI model, save it, and post the
 * cards, editing a status message as it goes. Only one refresh runs per server at a time.
 * Any failure replaces the status with an explanation and a Try again button.
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
  const url = project.website_url;
  let status: Status | null = null;
  try {
    status = await openStatus(interaction, `🔎 Reading ${url}…`);
    await readSite(status, guildId, url);
  } catch (error) {
    console.error(`Reading the hackathon site failed for guild ${guildId}:`, error);
    // Without a status message there's nothing to update; let the interaction router report it.
    if (!status) throw error;
    const reason = error instanceof RefreshError ? error.message : `Something went wrong: ${firstLine(error)}`;
    await status
      .finish([buildFailureMessage(url, [reason])])
      .catch((finishError: unknown) => console.error('Could not post the failure message:', finishError));
  } finally {
    inProgress.delete(guildId);
  }
}
