import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../events/normalize.js';
import { appendPastedText, getEventInfo, listTimeline, saveEventInfo, setEventTimezone } from './events.js';
import { db } from './index.js';

const SOURCES = { pages: [{ url: 'https://x.devpost.com/', rendered: false }], skipped: [], unreadableTimes: 0 };

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    name: 'Test Hack',
    summary: 'A hackathon.',
    venue: 'Main Hall',
    timezone: 'America/New_York',
    detectedTimezone: 'America/New_York',
    requirements: ['Submit on Devpost'],
    judgingCriteria: [{ name: 'Impact', description: null, weight: '25%' }],
    rules: ['Teams of up to 4'],
    timeline: [
      {
        kind: 'deadline',
        title: 'Submissions due',
        localStart: '2026-10-11T10:00',
        localEnd: null,
        startsAt: '2026-10-11T14:00:00Z',
        endsAt: null,
        location: null,
        description: null,
      },
    ],
    unreadableTimes: 0,
    ...overrides,
  };
}

describe('event storage', () => {
  it('saves and reads back event info and its timeline', () => {
    saveEventInfo('g1', 'https://x.devpost.com/', event(), SOURCES);
    expect(getEventInfo('g1')).toMatchObject({
      name: 'Test Hack',
      requirements: ['Submit on Devpost'],
      judgingCriteria: [{ name: 'Impact', description: null, weight: '25%' }],
      sources: SOURCES,
    });
    expect(listTimeline('g1').map((item) => item.title)).toEqual(['Submissions due']);
  });

  it('replaces only event items on refresh, keeping the team plan', () => {
    db.prepare(
      "INSERT INTO timeline_items (guild_id, source, kind, title, local_start) VALUES ('g2', 'plan', 'other', 'Feature freeze', '2026-10-11T08:00')",
    ).run();
    saveEventInfo('g2', 'https://x.devpost.com/', event(), SOURCES);
    saveEventInfo('g2', 'https://x.devpost.com/', event({ timeline: [] }), SOURCES);
    expect(listTimeline('g2').map((item) => [item.source, item.title])).toEqual([['plan', 'Feature freeze']]);
  });

  it('recomputes UTC times when the time zone changes, and back again with auto', () => {
    saveEventInfo('g3', 'https://x.devpost.com/', event(), SOURCES);
    expect(setEventTimezone('g3', 'America/Los_Angeles')).toEqual({ timezone: 'America/Los_Angeles', updated: 1 });
    expect(getEventInfo('g3')).toMatchObject({ timezone: 'America/Los_Angeles', timezoneOverride: 'America/Los_Angeles' });
    expect(listTimeline('g3')[0]?.startsAt).toBe('2026-10-11T17:00:00Z');

    expect(setEventTimezone('g3', null)).toEqual({ timezone: 'America/New_York', updated: 1 });
    expect(listTimeline('g3')[0]?.startsAt).toBe('2026-10-11T14:00:00Z');
  });

  it('keeps a manual time zone when the same site is read again', () => {
    saveEventInfo('g5', 'https://x.devpost.com/', event(), SOURCES);
    setEventTimezone('g5', 'America/Chicago');
    saveEventInfo('g5', 'https://x.devpost.com/', event({ detectedTimezone: 'America/Denver' }), SOURCES);
    expect(getEventInfo('g5')).toMatchObject({
      timezone: 'America/Chicago',
      timezoneOverride: 'America/Chicago',
      detectedTimezone: 'America/Denver',
    });
  });

  it('drops pasted text and the manual time zone when the hackathon link changes', () => {
    appendPastedText('g6', 'https://old.devpost.com/', 'Old schedule');
    saveEventInfo('g6', 'https://old.devpost.com/', event(), SOURCES);
    setEventTimezone('g6', 'America/Chicago');

    saveEventInfo('g6', 'https://new.devpost.com/', event(), SOURCES);
    expect(getEventInfo('g6')).toMatchObject({ sourceUrl: 'https://new.devpost.com/', pastedText: null, timezoneOverride: null });

    appendPastedText('g6', 'https://new.devpost.com/', 'New schedule');
    appendPastedText('g6', 'https://other.devpost.com/', 'Other schedule');
    expect(getEventInfo('g6')).toMatchObject({ sourceUrl: 'https://other.devpost.com/', pastedText: 'Other schedule' });
  });

  it('accumulates pasted text, even before the site has been read', () => {
    appendPastedText('g4', 'https://x.devpost.com/', 'Sat 9am Opening');
    appendPastedText('g4', 'https://x.devpost.com/', 'Sun 10am Demos');
    expect(getEventInfo('g4')).toMatchObject({ pastedText: 'Sat 9am Opening\n\nSun 10am Demos', fetchedAt: null });
    saveEventInfo('g4', 'https://x.devpost.com/', event(), SOURCES);
    expect(getEventInfo('g4')?.pastedText).toBe('Sat 9am Opening\n\nSun 10am Demos');
  });
});
