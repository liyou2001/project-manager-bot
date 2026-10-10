import { DateTime, IANAZone } from 'luxon';
import type { EventInfo } from '../ai/schemas.js';

export type TimelineKind = EventInfo['schedule'][number]['kind'] | 'deadline';

export interface TimelineEntry {
  kind: TimelineKind;
  title: string;
  /** As written on the page: YYYY-MM-DDTHH:mm in the event's time zone. */
  localStart: string;
  localEnd: string | null;
  /** UTC ISO timestamps; null while the time zone is unknown. */
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  description: string | null;
}

export interface JudgingCriterion {
  name: string;
  description: string | null;
  weight: string | null;
}

export interface NormalizedEvent {
  name: string;
  summary: string;
  venue: string | null;
  /** Zone used for the UTC times: the manual override if there is one, else the detected zone. */
  timezone: string | null;
  /** Zone found on the site (validated), kept so clearing an override can fall back to it. */
  detectedTimezone: string | null;
  requirements: string[];
  judgingCriteria: JudgingCriterion[];
  rules: string[];
  timeline: TimelineEntry[];
  /** Items dropped because their time couldn't be read. */
  unreadableTimes: number;
}

const MAX_RULES = 8;

/**
 * A real location-based time zone like "America/New_York" (or "UTC"). Legacy fixed-offset
 * names like "EST" or "Etc/GMT+5" are rejected: they ignore daylight saving, which would put
 * every time an hour off for half the year.
 */
export function isValidTimezone(zone: string | null | undefined): zone is string {
  if (!zone || !IANAZone.isValidZone(zone)) return false;
  return zone === 'UTC' || (zone.includes('/') && !zone.startsWith('Etc/'));
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/;

/**
 * Parse a local "YYYY-MM-DDTHH:mm" time; returns it normalized, or null if unreadable.
 * Seconds and any UTC offset the model adds are ignored: the wall-clock time is what was
 * written on the page. Date-only values are unreadable (no time to remind people at).
 */
export function parseLocalTime(local: string): string | null {
  const match = local.trim().match(LOCAL_TIME);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const parsed = DateTime.fromObject({ year, month, day, hour, minute }, { zone: 'utc' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm") : null;
}

/** Convert a local time in `zone` to a UTC ISO timestamp, or null if either is invalid. */
export function localToUtc(local: string | null, zone: string | null): string | null {
  if (!local || !isValidTimezone(zone)) return null;
  const parsed = DateTime.fromISO(local, { zone });
  return parsed.isValid ? parsed.toUTC().toISO({ suppressMilliseconds: true }) : null;
}

export interface NormalizeOptions {
  /** A time zone an admin set with /timezone; wins over the one found on the site. */
  timezoneOverride?: string | null;
}

/** Validate times and time zone, convert to UTC, drop duplicates, and sort the timeline. */
export function normalizeEvent(raw: EventInfo, options: NormalizeOptions = {}): NormalizedEvent {
  const detectedTimezone = isValidTimezone(raw.timezone) ? raw.timezone : null;
  const timezone = isValidTimezone(options.timezoneOverride) ? options.timezoneOverride : detectedTimezone;
  const entries: TimelineEntry[] = [];
  let unreadableTimes = 0;

  const add = (entry: Omit<TimelineEntry, 'localStart' | 'localEnd' | 'startsAt' | 'endsAt'>, start: string, end: string | null) => {
    const localStart = parseLocalTime(start);
    if (!localStart) {
      unreadableTimes++;
      return;
    }
    const localEnd = end ? parseLocalTime(end) : null;
    entries.push({
      ...entry,
      title: entry.title.trim(),
      localStart,
      localEnd,
      startsAt: localToUtc(localStart, timezone),
      endsAt: localToUtc(localEnd, timezone),
    });
  };

  for (const item of raw.schedule) {
    add({ kind: item.kind, title: item.title, location: item.location, description: item.description }, item.start, item.end);
  }
  for (const deadline of raw.deadlines) {
    add({ kind: 'deadline', title: deadline.title, location: null, description: deadline.description }, deadline.at, null);
  }

  const seen = new Set<string>();
  const timeline = entries
    .filter((entry) => {
      const key = `${entry.kind === 'deadline'}|${entry.title.toLowerCase()}|${entry.localStart}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Local ISO strings in one zone sort correctly as text.
    .sort((a, b) => a.localStart.localeCompare(b.localStart));

  const clean = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];

  return {
    name: raw.name.trim(),
    summary: raw.summary.trim(),
    venue: raw.venue?.trim() || null,
    timezone,
    detectedTimezone,
    requirements: clean(raw.requirements),
    judgingCriteria: raw.judgingCriteria.filter((criterion) => criterion.name.trim()),
    rules: clean(raw.rules).slice(0, MAX_RULES),
    timeline,
    unreadableTimes,
  };
}
