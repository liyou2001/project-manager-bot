import { localToUtc, type JudgingCriterion, type NormalizedEvent, type TimelineKind } from '../events/normalize.js';
import { db } from './index.js';

export interface EventSources {
  pages: { url: string; rendered: boolean }[];
  skipped: { url: string; reason: string }[];
  unreadableTimes: number;
}

export interface StoredEvent {
  guildId: string;
  sourceUrl: string;
  name: string | null;
  summary: string | null;
  venue: string | null;
  timezone: string | null;
  requirements: string[];
  judgingCriteria: JudgingCriterion[];
  rules: string[];
  sources: EventSources;
  pastedText: string | null;
  fetchedAt: string | null;
}

export interface TimelineItem {
  id: number;
  source: 'event' | 'plan';
  kind: TimelineKind;
  title: string;
  localStart: string;
  localEnd: string | null;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  description: string | null;
}

interface EventInfoRow {
  guild_id: string;
  source_url: string;
  name: string | null;
  summary: string | null;
  venue: string | null;
  timezone: string | null;
  requirements_json: string;
  judging_json: string;
  rules_json: string;
  sources_json: string;
  pasted_text: string | null;
  fetched_at: string | null;
}

interface TimelineRow {
  id: number;
  source: 'event' | 'plan';
  kind: TimelineKind;
  title: string;
  local_start: string;
  local_end: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  description: string | null;
}

const upsertInfo = db.prepare(`
  INSERT INTO event_info (guild_id, source_url, name, summary, venue, timezone,
    requirements_json, judging_json, rules_json, sources_json, fetched_at)
  VALUES (@guildId, @sourceUrl, @name, @summary, @venue, @timezone,
    @requirements, @judging, @rules, @sources, datetime('now'))
  ON CONFLICT(guild_id) DO UPDATE SET
    source_url = excluded.source_url, name = excluded.name, summary = excluded.summary,
    venue = excluded.venue, timezone = excluded.timezone,
    requirements_json = excluded.requirements_json, judging_json = excluded.judging_json,
    rules_json = excluded.rules_json, sources_json = excluded.sources_json,
    fetched_at = excluded.fetched_at
`);
const deleteEventItems = db.prepare<[string]>("DELETE FROM timeline_items WHERE guild_id = ? AND source = 'event'");
const insertItem = db.prepare(`
  INSERT INTO timeline_items (guild_id, source, kind, title, local_start, local_end,
    starts_at, ends_at, location, description)
  VALUES (@guildId, 'event', @kind, @title, @localStart, @localEnd, @startsAt, @endsAt, @location, @description)
`);
const getInfo = db.prepare<[string], EventInfoRow>('SELECT * FROM event_info WHERE guild_id = ?');
const listItems = db.prepare<[string], TimelineRow>(
  'SELECT * FROM timeline_items WHERE guild_id = ? ORDER BY local_start, id',
);
const appendPasted = db.prepare(`
  INSERT INTO event_info (guild_id, source_url, pasted_text) VALUES (@guildId, @sourceUrl, @text)
  ON CONFLICT(guild_id) DO UPDATE SET
    pasted_text = COALESCE(event_info.pasted_text || char(10) || char(10), '') || excluded.pasted_text
`);
const updateTimezone = db.prepare<[string | null, string]>('UPDATE event_info SET timezone = ? WHERE guild_id = ?');
const updateItemTimes = db.prepare<[string | null, string | null, number]>(
  'UPDATE timeline_items SET starts_at = ?, ends_at = ? WHERE id = ?',
);

/** Save freshly extracted event info, replacing the previous event schedule (plan items stay). */
export const saveEventInfo = db.transaction(
  (guildId: string, sourceUrl: string, event: NormalizedEvent, sources: EventSources) => {
    upsertInfo.run({
      guildId,
      sourceUrl,
      name: event.name,
      summary: event.summary,
      venue: event.venue,
      timezone: event.timezone,
      requirements: JSON.stringify(event.requirements),
      judging: JSON.stringify(event.judgingCriteria),
      rules: JSON.stringify(event.rules),
      sources: JSON.stringify(sources),
    });
    deleteEventItems.run(guildId);
    for (const item of event.timeline) insertItem.run({ guildId, ...item });
  },
);

export function getEventInfo(guildId: string): StoredEvent | undefined {
  const row = getInfo.get(guildId);
  if (!row) return undefined;
  return {
    guildId: row.guild_id,
    sourceUrl: row.source_url,
    name: row.name,
    summary: row.summary,
    venue: row.venue,
    timezone: row.timezone,
    requirements: JSON.parse(row.requirements_json) as string[],
    judgingCriteria: JSON.parse(row.judging_json) as JudgingCriterion[],
    rules: JSON.parse(row.rules_json) as string[],
    sources: JSON.parse(row.sources_json) as EventSources,
    pastedText: row.pasted_text,
    fetchedAt: row.fetched_at,
  };
}

export function listTimeline(guildId: string): TimelineItem[] {
  return listItems.all(guildId).map((row) => ({
    id: row.id,
    source: row.source,
    kind: row.kind,
    title: row.title,
    localStart: row.local_start,
    localEnd: row.local_end,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    description: row.description,
  }));
}

/** Add schedule text the team pasted in; it's included in every later extraction. */
export function appendPastedText(guildId: string, sourceUrl: string, text: string): void {
  appendPasted.run({ guildId, sourceUrl, text });
}

/** Change the event's time zone and recompute every item's UTC times from its local times. */
export const setEventTimezone = db.transaction((guildId: string, timezone: string): number => {
  updateTimezone.run(timezone, guildId);
  const items = listItems.all(guildId);
  for (const item of items) {
    updateItemTimes.run(localToUtc(item.local_start, timezone), localToUtc(item.local_end, timezone), item.id);
  }
  return items.length;
});
