import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { DateTime } from 'luxon';
import type { StoredEvent, TimelineItem } from '../db/events.js';

// Discord limits
const EMBED_DESCRIPTION_LIMIT = 4096;
const MESSAGE_EMBED_CHARS = 6000;
const EMBEDS_PER_MESSAGE = 10;

export const PASTE_BUTTON_ID = 'event:paste';
export const RETRY_BUTTON_ID = 'event:retry';

const COLORS = { overview: 0x5865f2, deadlines: 0xed4245, requirements: 0xfee75c, judging: 0x57f287, schedule: 0x5865f2 };

export interface EventMessage {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/** Group lines into chunks of at most `maxChars`, breaking only between lines where possible. */
export function chunkLines(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    // A single line longer than a chunk (rare) is split mid-line.
    const pieces = line.length > maxChars ? line.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g'))! : [line];
    for (const piece of pieces) {
      if (current && current.length + 1 + piece.length > maxChars) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function embedLength(embed: EmbedBuilder): number {
  const data = embed.data;
  return (
    (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.footer?.text.length ?? 0) +
    (data.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

/** Put embeds into as few messages as Discord allows, keeping their order. */
export function packEmbeds(embeds: EmbedBuilder[]): EmbedBuilder[][] {
  const messages: EmbedBuilder[][] = [];
  let current: EmbedBuilder[] = [];
  let currentChars = 0;
  for (const embed of embeds) {
    const length = embedLength(embed);
    if (current.length && (current.length === EMBEDS_PER_MESSAGE || currentChars + length > MESSAGE_EMBED_CHARS)) {
      messages.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(embed);
    currentChars += length;
  }
  if (current.length) messages.push(current);
  return messages;
}

/** One embed per chunk of lines, titled "Title" then "Title (continued)". */
function sectionEmbeds(title: string, lines: string[], color: number): EmbedBuilder[] {
  if (lines.length === 0) return [];
  return chunkLines(lines, EMBED_DESCRIPTION_LIMIT).map((chunk, i) =>
    new EmbedBuilder()
      .setTitle(i === 0 ? title : `${title} (continued)`)
      .setDescription(chunk)
      .setColor(color),
  );
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const text = (value: string) => escapeMarkdown(value);

/** "<t:...:f>" when the UTC time is known (shown in each viewer's time zone), else the local time as written. */
function when(local: string, utc: string | null, style: 't' | 'f'): string {
  if (utc) return `<t:${unix(utc)}:${style}>`;
  const parsed = DateTime.fromISO(local);
  return parsed.toFormat(style === 't' ? 'h:mm a' : 'ccc LLL d, h:mm a');
}

function deadlineLines(items: TimelineItem[]): string[] {
  return items.map((item) => {
    const countdown = item.startsAt ? ` · <t:${unix(item.startsAt)}:R>` : '';
    const detail = item.description ? ` — ${text(item.description)}` : '';
    return `${when(item.localStart, item.startsAt, 'f')}${countdown} — **${text(item.title)}**${detail}`;
  });
}

function scheduleLines(items: TimelineItem[]): string[] {
  const lines: string[] = [];
  let day = '';
  for (const item of items) {
    const itemDay = item.localStart.slice(0, 10);
    if (itemDay !== day) {
      day = itemDay;
      lines.push(`${lines.length ? '\n' : ''}__**${DateTime.fromISO(itemDay).toFormat('cccc, LLL d')}**__`);
    }
    const end = item.localEnd ? `–${when(item.localEnd, item.endsAt, 't')}` : '';
    const where = item.location ? ` · ${text(item.location)}` : '';
    lines.push(`${when(item.localStart, item.startsAt, 't')}${end} **${text(item.title)}**${where}`);
  }
  return lines;
}

function footerText(event: StoredEvent): string {
  const { pages, skipped, unreadableTimes } = event.sources;
  const rendered = pages.filter((page) => page.rendered).length;
  const parts = [`Read ${pages.length} page${pages.length === 1 ? '' : 's'}${rendered ? ` (${rendered} in a browser)` : ''}`];
  if (event.pastedText) parts.push('plus pasted text');
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  if (unreadableTimes) parts.push(`${unreadableTimes} item${unreadableTimes === 1 ? '' : 's'} had unreadable times`);
  parts.push('/refresh to update');
  return parts.join(' · ');
}

function actionRow(): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(PASTE_BUTTON_ID).setLabel('Paste schedule').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(RETRY_BUTTON_ID).setLabel('Try again').setStyle(ButtonStyle.Secondary),
  );
}

/** The cards for an event: overview, deadlines, requirements, judging, rules, then the schedule. */
export function buildEventMessages(event: StoredEvent, timeline: TimelineItem[]): EventMessage[] {
  const deadlines = timeline.filter((item) => item.kind === 'deadline');
  const schedule = timeline.filter((item) => item.kind !== 'deadline');

  const overview = new EmbedBuilder()
    .setTitle((event.name ?? 'Hackathon').slice(0, 256))
    .setURL(event.sourceUrl)
    .setDescription(event.summary ? text(event.summary) : 'No summary found.')
    .addFields(
      ...(event.venue ? [{ name: 'Venue', value: text(event.venue).slice(0, 1024), inline: true }] : []),
      {
        name: 'Time zone',
        value: event.timezone ?? 'Unknown, so times are shown as written. Set it with `/timezone`.',
        inline: true,
      },
    )
    .setFooter({ text: footerText(event) })
    .setColor(COLORS.overview);
  if (event.fetchedAt) overview.setTimestamp(new Date(`${event.fetchedAt}Z`));
  if (schedule.length === 0) {
    overview.addFields({
      name: 'Schedule',
      value: "I couldn't find a schedule. If you have one, use **Paste schedule** below.",
    });
  }

  const judgingLines = event.judgingCriteria.map((criterion) => {
    const weight = criterion.weight ? ` (${text(criterion.weight)})` : '';
    const detail = criterion.description ? ` — ${text(criterion.description)}` : '';
    return `• **${text(criterion.name)}**${weight}${detail}`;
  });

  const embeds = [
    overview,
    ...sectionEmbeds('⏰ Deadlines', deadlineLines(deadlines), COLORS.deadlines),
    ...sectionEmbeds('✅ Requirements', event.requirements.map((item) => `• ${text(item)}`), COLORS.requirements),
    ...sectionEmbeds('⚖️ Judging criteria', judgingLines, COLORS.judging),
    ...sectionEmbeds('📜 Rules highlights', event.rules.map((item) => `• ${text(item)}`), COLORS.judging),
    ...sectionEmbeds('🗓️ Schedule', scheduleLines(schedule), COLORS.schedule),
  ];

  const messages: EventMessage[] = packEmbeds(embeds).map((group) => ({ embeds: group, components: [] }));
  if (schedule.length === 0) messages[messages.length - 1]!.components.push(actionRow());
  return messages;
}

/** Shown when nothing could be read from the site. */
export function buildFailureMessage(url: string, reasons: string[]): EventMessage {
  const details = reasons.length ? `\n${reasons.slice(0, 3).map((reason) => `• ${text(reason)}`).join('\n')}` : '';
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("Couldn't read the hackathon site")
        .setDescription(
          `I wasn't able to read ${url}.${details}\n\nYou can paste the schedule, rules and deadlines instead, or try again later.`,
        )
        .setColor(COLORS.deadlines),
    ],
    components: [actionRow()],
  };
}
