import { EmbedBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { StoredEvent, TimelineItem } from '../db/events.js';
import { buildEventMessages, buildFailureMessage, chunkLines, packEmbeds, PASTE_BUTTON_ID, truncate } from './card.js';

const EVENT: StoredEvent = {
  guildId: 'g1',
  sourceUrl: 'https://x.devpost.com/',
  name: 'Test Hack',
  summary: 'A *great* hackathon.',
  venue: 'Main Hall',
  timezone: 'America/New_York',
  detectedTimezone: 'America/New_York',
  timezoneOverride: null,
  requirements: ['Submit on Devpost'],
  judgingCriteria: [{ name: 'Impact', description: 'Does it matter?', weight: '25%' }],
  rules: ['Teams of up to 4'],
  sources: { pages: [{ url: 'https://x.devpost.com/', rendered: false }, { url: 'https://x.dev/', rendered: true }], skipped: [], unreadableTimes: 0 },
  pastedText: null,
  fetchedAt: '2026-10-10 12:00:00',
};
const NOW = new Date('2026-10-10T12:00:00Z');

let nextId = 1;
const entry = (kind: TimelineItem['kind'], title: string, localStart: string, startsAt: string | null): TimelineItem => ({
  id: nextId++,
  source: 'event',
  kind,
  title,
  localStart,
  localEnd: null,
  startsAt,
  endsAt: null,
  location: kind === 'deadline' ? null : 'Room 1',
  description: null,
});
const t = (iso: string) => Date.parse(iso) / 1000;

const embedsOf = (messages: ReturnType<typeof buildEventMessages>) => messages.flatMap((m) => m.embeds.map((e) => e.toJSON()));
const allText = (messages: ReturnType<typeof buildEventMessages>) => embedsOf(messages).map((e) => JSON.stringify(e)).join('\n');

describe('truncate', () => {
  it('cuts long text with an ellipsis and leaves short text alone', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});

describe('chunkLines', () => {
  it('groups lines without exceeding the limit', () => {
    expect(chunkLines(['aaaa', 'bbbb', 'cccc'], 9)).toEqual(['aaaa\nbbbb', 'cccc']);
  });
  it('splits a single line longer than the limit', () => {
    expect(chunkLines(['x'.repeat(10)], 4)).toEqual(['xxxx', 'xxxx', 'xx']);
  });
});

describe('packEmbeds', () => {
  it('keeps each message under 6000 characters and 10 embeds', () => {
    const big = Array.from({ length: 5 }, () => new EmbedBuilder().setDescription('x'.repeat(2500)));
    expect(packEmbeds(big).map((group) => group.length)).toEqual([2, 2, 1]);
    const small = Array.from({ length: 12 }, () => new EmbedBuilder().setDescription('x'));
    expect(packEmbeds(small).map((group) => group.length)).toEqual([10, 2]);
  });
});

describe('buildEventMessages', () => {
  const timeline = [
    entry('ceremony', 'Opening', '2026-10-10T09:00', '2026-10-10T13:00:00Z'),
    entry('deadline', 'Submissions due', '2026-10-11T10:00', '2026-10-11T14:00:00Z'),
    entry('ceremony', 'Awards', '2026-10-11T11:00', '2026-10-11T15:00:00Z'),
  ];

  it('shows one timeline with deadlines marked inline, grouped by day', () => {
    const embeds = embedsOf(buildEventMessages(EVENT, timeline, NOW));
    expect(embeds.map((e) => e.title)).toEqual(['Test Hack', '✅ Requirements', '⚖️ Judging criteria', '📜 Rules highlights', '🗓️ Timeline']);
    expect(embeds.at(-1)!.description).toBe(
      [
        '__**Saturday, Oct 10**__',
        `<t:${t('2026-10-10T13:00:00Z')}:t> **Opening** · Room 1`,
        '\n__**Sunday, Oct 11**__',
        `⏰ <t:${t('2026-10-11T14:00:00Z')}:t> **Submissions due** · <t:${t('2026-10-11T14:00:00Z')}:R>`,
        `<t:${t('2026-10-11T15:00:00Z')}:t> **Awards** · Room 1`,
      ].join('\n'),
    );
  });

  it('puts the next upcoming deadline on the overview', () => {
    const overview = embedsOf(buildEventMessages(EVENT, timeline, NOW))[0]!;
    const due = t('2026-10-11T14:00:00Z');
    expect(overview.fields).toContainEqual({ name: '⏰ Next deadline', value: `**Submissions due** · <t:${due}:f> (<t:${due}:R>)`, inline: false });

    const afterDeadline = embedsOf(buildEventMessages(EVENT, timeline, new Date('2026-10-12T00:00:00Z')))[0]!;
    expect(afterDeadline.fields?.map((f) => f.name)).not.toContain('⏰ Next deadline');
  });

  it('escapes markdown and reports how the site was read', () => {
    const text = allText(buildEventMessages(EVENT, timeline, NOW));
    expect(text).toContain('A \\\\*great\\\\* hackathon.'); // JSON-encoded backslash
    expect(text).toContain('Read 2 pages (1 in a browser)');
  });

  it('marks a time zone that was set by hand', () => {
    const overview = embedsOf(buildEventMessages({ ...EVENT, timezoneOverride: 'America/New_York' }, timeline, NOW))[0]!;
    expect(overview.fields).toContainEqual({ name: 'Time zone', value: 'America/New_York (set manually)', inline: true });
  });

  it('falls back to local times and offers Paste schedule when there is only a deadline', () => {
    const messages = buildEventMessages({ ...EVENT, timezone: null }, [entry('deadline', 'Submissions due', '2026-10-11T10:00', null)], NOW);
    const text = allText(messages);
    expect(text).toContain('⏰ 10:00 AM **Submissions due**');
    expect(text).toContain('**Submissions due** · Sun Oct 11, 10:00 AM');
    expect(text).toContain('Set it with `/timezone`');
    expect(text).toContain("I couldn't find a schedule");
    expect(JSON.stringify(messages.at(-1)!.components[0]!.toJSON())).toContain(PASTE_BUTTON_ID);
  });

  it('never fails on an empty name or a very long summary', () => {
    const messages = buildEventMessages({ ...EVENT, name: '', summary: 'x'.repeat(10_000), venue: 'v'.repeat(2_000) }, timeline, NOW);
    const overview = embedsOf(messages)[0]!;
    expect(overview.title).toBe('Hackathon');
    expect(overview.description).toHaveLength(4096);
    expect(overview.fields?.find((f) => f.name === 'Venue')?.value).toHaveLength(1024);
  });

  it('splits a very long timeline across messages without dropping items', () => {
    const items = Array.from({ length: 400 }, (_, i) =>
      entry('workshop', `Workshop number ${i} with a fairly long descriptive title`, `2026-10-10T${String(i % 24).padStart(2, '0')}:00`, null),
    );
    const messages = buildEventMessages(EVENT, items, NOW);
    expect(messages.length).toBeGreaterThan(1);
    const text = allText(messages);
    for (let i = 0; i < 400; i += 57) expect(text).toContain(`Workshop number ${i} with`);
    for (const message of messages) {
      const chars = message.embeds.reduce(
        (sum, e) =>
          sum +
          (e.data.description?.length ?? 0) +
          (e.data.title?.length ?? 0) +
          (e.data.footer?.text.length ?? 0) +
          (e.data.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0),
        0,
      );
      expect(chars).toBeLessThanOrEqual(6000);
    }
  });
});

describe('buildFailureMessage', () => {
  it('explains the failure and offers paste and retry', () => {
    const message = buildFailureMessage('https://x.dev/', ['HTTP 403']);
    expect(JSON.stringify(message.embeds[0]!.toJSON())).toContain('HTTP 403');
    expect(message.components).toHaveLength(1);
  });
});
