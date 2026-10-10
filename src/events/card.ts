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
const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048 };
const MESSAGE_EMBED_CHARS = 6000;
const EMBEDS_PER_MESSAGE = 10;

export const PASTE_BUTTON_ID = 'event:paste';
export const RETRY_BUTTON_ID = 'event:retry';

const COLORS = { overview: 0x5865f2, requirements: 0xfee75c, judging: 0x57f287, timeline: 0x5865f2, failure: 0xed4245 };

export interface EventMessage {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/** Shorten to `max` characters, ending in "…" if anything was cut. */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
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
  return chunkLines(lines, LIMITS.description).map((chunk, i) =>
    new EmbedBuilder()
      .setTitle(i === 0 ? title : `${title} (continued)`)
      .setDescription(chunk)
      .setColor(color),
  );
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const text = (value: string) => escapeMarkdown(value);

/**
 * "<t:...>" when the UTC time is known (Discord shows it in each viewer's time zone),
 * otherwise the local time exactly as written on the site.
 */
function when(local: string, utc: string | null, style: 't' | 'f'): string {
  if (utc) return `<t:${unix(utc)}:${style}>`;
  // Read as UTC only to avoid the host's own daylight-saving rules shifting the wall time.
  return DateTime.fromISO(local, { zone: 'utc' }).toFormat(style === 't' ? 'h:mm a' : 'ccc LLL d, h:mm a');
}

/** Schedule and deadlines together, grouped by day; deadlines are marked ⏰ with a countdown. */
function timelineLines(items: TimelineItem[]): string[] {
  const lines: string[] = [];
  let day = '';
  for (const item of items) {
    const itemDay = item.localStart.slice(0, 10);
    if (itemDay !== day) {
      day = itemDay;
      lines.push(`${lines.length ? '\n' : ''}__**${DateTime.fromISO(itemDay, { zone: 'utc' }).toFormat('cccc, LLL d')}**__`);
    }
    const start = when(item.localStart, item.startsAt, 't');
    if (item.kind === 'deadline') {
      const countdown = item.startsAt ? ` · <t:${unix(item.startsAt)}:R>` : '';
      const detail = item.description ? ` — ${text(item.description)}` : '';
      lines.push(`⏰ ${start} **${text(item.title)}**${countdown}${detail}`);
    } else {
      const end = item.localEnd ? `–${when(item.localEnd, item.endsAt, 't')}` : '';
      const where = item.location ? ` · ${text(item.location)}` : '';
      lines.push(`${start}${end} **${text(item.title)}**${where}`);
    }
  }
  return lines;
}

/** The next deadline still ahead (or the first one, if times aren't known in UTC). */
function nextDeadline(items: TimelineItem[], now: Date): string | null {
  const deadlines = items.filter((item) => item.kind === 'deadline');
  const upcoming = deadlines.find((item) => item.startsAt && Date.parse(item.startsAt) > now.getTime());
  if (upcoming?.startsAt) {
    return `**${text(upcoming.title)}** · <t:${unix(upcoming.startsAt)}:f> (<t:${unix(upcoming.startsAt)}:R>)`;
  }
  const unknownZone = deadlines.find((item) => !item.startsAt);
  return unknownZone ? `**${text(unknownZone.title)}** · ${when(unknownZone.localStart, null, 'f')}` : null;
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

function timezoneText(event: StoredEvent): string {
  if (!event.timezone) return 'Unknown, so times are shown as written. Set it with `/timezone`.';
  return event.timezoneOverride ? `${event.timezone} (set manually)` : event.timezone;
}

function actionRow(): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(PASTE_BUTTON_ID).setLabel('Paste schedule').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(RETRY_BUTTON_ID).setLabel('Try again').setStyle(ButtonStyle.Secondary),
  );
}

/**
 * The cards for an event: overview (with the next deadline), requirements, judging, rules,
 * then the timeline. Never throws for stored data: every text is cut to Discord's limits.
 */
export function buildEventMessages(event: StoredEvent, timeline: TimelineItem[], now = new Date()): EventMessage[] {
  const hasSchedule = timeline.some((item) => item.kind !== 'deadline');
  const field = (name: string, value: string, inline = false) => ({
    name: truncate(name, LIMITS.fieldName),
    value: truncate(value, LIMITS.fieldValue),
    inline,
  });

  const overview = new EmbedBuilder()
    .setTitle(truncate(event.name?.trim() || 'Hackathon', LIMITS.title))
    .setURL(event.sourceUrl)
    .setDescription(truncate(event.summary?.trim() ? text(event.summary) : 'No summary found.', LIMITS.description))
    .setFooter({ text: truncate(footerText(event), LIMITS.footer) })
    .setColor(COLORS.overview);
  if (event.venue) overview.addFields(field('Venue', text(event.venue), true));
  overview.addFields(field('Time zone', timezoneText(event), true));
  const next = nextDeadline(timeline, now);
  if (next) overview.addFields(field('⏰ Next deadline', next));
  if (!hasSchedule) {
    overview.addFields(field('Schedule', "I couldn't find a schedule. If you have one, use **Paste schedule** below."));
  }
  if (event.fetchedAt) overview.setTimestamp(new Date(`${event.fetchedAt}Z`));

  const judgingLines = event.judgingCriteria.map((criterion) => {
    const weight = criterion.weight ? ` (${text(criterion.weight)})` : '';
    const detail = criterion.description ? ` — ${text(criterion.description)}` : '';
    return `• **${text(criterion.name)}**${weight}${detail}`;
  });

  const embeds = [
    overview,
    ...sectionEmbeds('✅ Requirements', event.requirements.map((item) => `• ${text(item)}`), COLORS.requirements),
    ...sectionEmbeds('⚖️ Judging criteria', judgingLines, COLORS.judging),
    ...sectionEmbeds('📜 Rules highlights', event.rules.map((item) => `• ${text(item)}`), COLORS.judging),
    ...sectionEmbeds('🗓️ Timeline', timelineLines(timeline), COLORS.timeline),
  ];

  const messages: EventMessage[] = packEmbeds(embeds).map((group) => ({ embeds: group, components: [] }));
  if (!hasSchedule) messages[messages.length - 1]!.components.push(actionRow());
  return messages;
}

/** Shown when the site couldn't be read, or reading it failed partway. */
export function buildFailureMessage(url: string, reasons: string[]): EventMessage {
  const details = reasons.length ? `\n${reasons.slice(0, 3).map((reason) => `• ${text(reason)}`).join('\n')}` : '';
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("Couldn't read the hackathon site")
        .setDescription(
          truncate(
            `I wasn't able to read ${url}.${details}\n\nYou can paste the schedule, rules and deadlines instead, or try again later.`,
            LIMITS.description,
          ),
        )
        .setColor(COLORS.failure),
    ],
    components: [actionRow()],
  };
}
