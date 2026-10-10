import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventInfo } from '../ai/schemas.js';

// Replace the network and AI parts; the database is a real in-memory one.
const extractEventInfo = vi.fn();
const crawl = vi.fn();
let failSave = false;

vi.mock('../ai/extractEvent.js', () => ({ extractEventInfo: (...args: unknown[]) => extractEventInfo(...args) }));
vi.mock('../web/crawl.js', () => ({ crawl: (...args: unknown[]) => crawl(...args) }));
vi.mock('../web/render.js', () => ({ createRenderer: () => ({ render: vi.fn(), close: vi.fn(async () => {}) }) }));
vi.mock('../db/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/events.js')>();
  return {
    ...actual,
    saveEventInfo: (...args: Parameters<typeof actual.saveEventInfo>) => {
      if (failSave) throw new Error('disk full');
      return actual.saveEventInfo(...args);
    },
  };
});

const { runEventRefresh } = await import('./refresh.js');
const { saveProject } = await import('../db/projects.js');
const { appendPastedText, getEventInfo, setEventTimezone } = await import('../db/events.js');

const URL_A = 'https://a-hack.devpost.com/';

const RAW: EventInfo = {
  name: 'A Hack',
  summary: 'A hackathon.',
  venue: null,
  timezone: 'America/New_York',
  schedule: [{ title: 'Opening', kind: 'ceremony', start: '2026-10-10T09:00', end: null, location: null, description: null }],
  deadlines: [],
  requirements: [],
  judgingCriteria: [],
  rules: [],
};

/** A fake slash-command interaction that records what the bot showed. */
function fakeInteraction(guildId: string) {
  const shown: unknown[] = [];
  const state = { replied: false };
  const interaction = {
    guildId,
    get replied() {
      return state.replied;
    },
    deferred: false,
    reply: vi.fn(async (options: unknown) => {
      state.replied = true;
      shown.push(options);
    }),
    editReply: vi.fn(async (options: unknown) => shown.push(options)),
    followUp: vi.fn(async (options: unknown) => shown.push(options)),
    webhook: { editMessage: vi.fn(async (_: unknown, options: unknown) => shown.push(options)) },
  };
  return { interaction: interaction as unknown as Parameters<typeof runEventRefresh>[0], shown };
}

const lastShown = (shown: unknown[]) => JSON.stringify(shown.at(-1));

beforeEach(() => {
  failSave = false;
  extractEventInfo.mockReset().mockResolvedValue(RAW);
  crawl.mockReset().mockResolvedValue({
    pages: [{ url: URL_A, title: 'A Hack', text: 'Opening at 9:00 AM', rendered: false }],
    skipped: [],
    eventName: 'A Hack',
    eventHints: [],
    roles: { devpostHost: 'a-hack.devpost.com', officialHost: null },
  });
});

function setUpProject(guildId: string, url = URL_A) {
  saveProject({ guildId, guildName: 'G', websiteUrl: url, githubUrl: null, updatedBy: 'u' });
}

describe('runEventRefresh', () => {
  it('posts the event cards when everything works', async () => {
    setUpProject('ok');
    const { interaction, shown } = fakeInteraction('ok');
    await runEventRefresh(interaction);
    expect(lastShown(shown)).toContain('🗓️ Timeline');
    expect(getEventInfo('ok')?.name).toBe('A Hack');
  });

  it('replaces the status with a failure card when saving fails', async () => {
    setUpProject('save-fails');
    failSave = true;
    const { interaction, shown } = fakeInteraction('save-fails');
    await runEventRefresh(interaction);
    expect(lastShown(shown)).toContain("Couldn't read the hackathon site");
    expect(lastShown(shown)).toContain('Something went wrong: disk full');
    expect(lastShown(shown)).toContain('event:retry');
  });

  it('explains when summarizing fails', async () => {
    setUpProject('ai-fails');
    extractEventInfo.mockRejectedValue(new Error('rate limited\nmore details'));
    const { interaction, shown } = fakeInteraction('ai-fails');
    await runEventRefresh(interaction);
    expect(lastShown(shown)).toContain('I read the site, but summarizing it failed: rate limited');
  });

  it('keeps pasted text and the manual time zone for the same link only', async () => {
    setUpProject('carry');
    appendPastedText('carry', URL_A, 'Sat 9am Opening');
    await runEventRefresh(fakeInteraction('carry').interaction);
    setEventTimezone('carry', 'America/Chicago');

    await runEventRefresh(fakeInteraction('carry').interaction);
    expect(extractEventInfo.mock.lastCall![0].pastedText).toBe('Sat 9am Opening');
    expect(getEventInfo('carry')).toMatchObject({ timezone: 'America/Chicago', timezoneOverride: 'America/Chicago' });

    setUpProject('carry', 'https://b-hack.devpost.com/');
    await runEventRefresh(fakeInteraction('carry').interaction);
    expect(extractEventInfo.mock.lastCall![0].pastedText).toBeNull();
    expect(getEventInfo('carry')).toMatchObject({ timezone: 'America/New_York', timezoneOverride: null });
  });

  it('refuses to start a second refresh for the same server', async () => {
    setUpProject('busy');
    let release!: () => void;
    crawl.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ pages: [], skipped: [], eventName: null, eventHints: [], roles: {} }))));
    const first = runEventRefresh(fakeInteraction('busy').interaction);
    const second = fakeInteraction('busy');
    await vi.waitFor(() => expect(crawl).toHaveBeenCalled());
    await runEventRefresh(second.interaction);
    expect(lastShown(second.shown)).toContain('already reading');
    release();
    await first;
  });
});
