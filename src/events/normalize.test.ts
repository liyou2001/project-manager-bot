import { describe, expect, it } from 'vitest';
import type { EventInfo } from '../ai/schemas.js';
import { localToUtc, normalizeEvent, parseLocalTime } from './normalize.js';

function rawEvent(overrides: Partial<EventInfo> = {}): EventInfo {
  return {
    name: ' Test Hack ',
    summary: 'A hackathon.',
    venue: 'Main Hall',
    timezone: 'America/New_York',
    schedule: [],
    deadlines: [],
    requirements: [],
    judgingCriteria: [],
    rules: [],
    ...overrides,
  };
}

const item = (title: string, start: string, end: string | null = null) => ({
  title,
  kind: 'workshop' as const,
  start,
  end,
  location: null,
  description: null,
});

describe('localToUtc', () => {
  it('converts EDT and EST correctly across the daylight-saving change', () => {
    expect(localToUtc('2026-10-10T09:00', 'America/New_York')).toBe('2026-10-10T13:00:00Z'); // EDT, UTC-4
    expect(localToUtc('2026-11-02T09:00', 'America/New_York')).toBe('2026-11-02T14:00:00Z'); // EST, UTC-5
  });
  it('returns null without a valid zone or time', () => {
    expect(localToUtc('2026-10-10T09:00', null)).toBeNull();
    expect(localToUtc('2026-10-10T09:00', 'Mars/Olympus')).toBeNull();
    expect(localToUtc(null, 'America/New_York')).toBeNull();
  });
});

describe('parseLocalTime', () => {
  it('accepts ISO-ish times and rejects junk', () => {
    expect(parseLocalTime('2026-10-10T09:00')).toBe('2026-10-10T09:00');
    expect(parseLocalTime('2026-10-10 9:00')).toBeNull();
    expect(parseLocalTime('2026-10-10 09:00')).toBe('2026-10-10T09:00');
    expect(parseLocalTime('Saturday morning')).toBeNull();
  });
});

describe('normalizeEvent', () => {
  it('builds a sorted timeline of schedule items and deadlines with UTC times', () => {
    const event = normalizeEvent(
      rawEvent({
        schedule: [item('Lunch', '2026-10-10T12:00'), item('Opening', '2026-10-10T09:00', '2026-10-10T10:00')],
        deadlines: [{ title: 'Submissions due', at: '2026-10-11T10:00', description: null }],
      }),
    );
    expect(event.timeline.map((entry) => [entry.title, entry.kind, entry.startsAt])).toEqual([
      ['Opening', 'workshop', '2026-10-10T13:00:00Z'],
      ['Lunch', 'workshop', '2026-10-10T16:00:00Z'],
      ['Submissions due', 'deadline', '2026-10-11T14:00:00Z'],
    ]);
    expect(event.timeline[0]!.endsAt).toBe('2026-10-10T14:00:00Z');
  });

  it('drops duplicates and counts unreadable times', () => {
    const event = normalizeEvent(
      rawEvent({
        schedule: [item('Lunch', '2026-10-10T12:00'), item('lunch ', '2026-10-10T12:00'), item('Dinner', 'evening')],
      }),
    );
    expect(event.timeline.map((entry) => entry.title)).toEqual(['Lunch']);
    expect(event.unreadableTimes).toBe(1);
  });

  it('keeps local times but no UTC times when the time zone is invalid', () => {
    const event = normalizeEvent(rawEvent({ timezone: 'EDT', schedule: [item('Lunch', '2026-10-10T12:00')] }));
    expect(event.timezone).toBeNull();
    expect(event.timeline[0]).toMatchObject({ localStart: '2026-10-10T12:00', startsAt: null });
  });

  it('trims and de-duplicates lists, and keeps at most 8 rules', () => {
    const event = normalizeEvent(
      rawEvent({
        requirements: [' Submit on Devpost ', 'Submit on Devpost', ''],
        rules: Array.from({ length: 10 }, (_, i) => `Rule ${i}`),
      }),
    );
    expect(event.name).toBe('Test Hack');
    expect(event.requirements).toEqual(['Submit on Devpost']);
    expect(event.rules).toHaveLength(8);
  });
});
