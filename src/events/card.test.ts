import { EmbedBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { StoredEvent, TimelineItem } from '../db/events.js';
import { buildEventMessages, buildFailureMessage, chunkLines, packEmbeds, PASTE_BUTTON_ID } from './card.js';

const EVENT: StoredEvent = {
  guildId: 'g1',
  sourceUrl: 'https://x.devpost.com/',
  name: 'Test Hack',
  summary: 'A *great* hackathon.',
  venue: 'Main Hall',
  timezone: 'America/New_York',
  requirements: ['Submit on Devpost'],
  judgingCriteria: [{ name: 'Impact', description: 'Does it matter?', weight: '25%' }],
  rules: ['Teams of up to 4'],
  sources: { pages: [{ url: 'https://x.devpost.com/', rendered: false }, { url: 'https://x.dev/', rendered: true }], skipped: [], unreadableTimes: 0 },
  pastedText: null,
  fetchedAt: '2026-10-10 12:00:00',
};

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

const allText = (messages: ReturnType<typeof buildEventMessages>) =>
  messages.flatMap((m) => m.embeds.map((e) => JSON.stringify(e.toJSON()))).join('\n');

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
  it('shows deadlines with countdowns and the schedule grouped by day, in viewer time', () => {
    const messages = buildEventMessages(EVENT, [
      entry('ceremony', 'Opening', '2026-10-10T09:00', '2026-10-10T13:00:00Z'),
      entry('deadline', 'Submissions due', '2026-10-11T10:00', '2026-10-11T14:00:00Z'),
    ]);
    const text = allText(messages);
    const due = Date.parse('2026-10-11T14:00:00Z') / 1000;
    expect(text).toContain(`<t:${due}:f> · <t:${due}:R> — **Submissions due**`);
    expect(text).toContain('__**Saturday, Oct 10**__');
    expect(text).toContain(`<t:${Date.parse('2026-10-10T13:00:00Z') / 1000}:t> **Opening** · Room 1`);
    expect(text).toContain('A \\\\*great\\\\* hackathon.'); // markdown escaped (JSON-encoded backslash)
    expect(text).toContain('Read 2 pages (1 in a browser)');
    expect(messages.every((m) => m.components.length === 0)).toBe(true);
  });

  it('falls back to local times and offers Paste schedule when there is no schedule', () => {
    const messages = buildEventMessages({ ...EVENT, timezone: null }, [
      entry('deadline', 'Submissions due', '2026-10-11T10:00', null),
    ]);
    const text = allText(messages);
    expect(text).toContain('Sun Oct 11, 10:00 AM — **Submissions due**');
    expect(text).toContain('Set it with `/timezone`');
    expect(text).toContain("I couldn't find a schedule");
    expect(JSON.stringify(messages.at(-1)!.components[0]!.toJSON())).toContain(PASTE_BUTTON_ID);
  });

  it('splits a very long schedule across messages without dropping items', () => {
    const items = Array.from({ length: 400 }, (_, i) =>
      entry('workshop', `Workshop number ${i} with a fairly long descriptive title`, `2026-10-10T${String(i % 24).padStart(2, '0')}:00`, null),
    );
    const messages = buildEventMessages(EVENT, items);
    expect(messages.length).toBeGreaterThan(1);
    const text = allText(messages);
    for (let i = 0; i < 400; i += 57) expect(text).toContain(`Workshop number ${i} with`);
    for (const message of messages) {
      const chars = message.embeds.reduce((sum, e) => sum + (e.data.description?.length ?? 0) + (e.data.title?.length ?? 0), 0);
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
