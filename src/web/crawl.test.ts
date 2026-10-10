import { describe, expect, it, vi } from 'vitest';
import { crawl, type CrawlDeps } from './crawl.js';
import type { Renderer } from './render.js';

const page = (body: string, title = 'Test Hack 2026') => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const filler = (words: number) => 'Hackathon details. '.repeat(words);

/** A fake web: URL -> HTML. Unknown URLs fail like a 404. */
function fakeWeb(pages: Record<string, string>): CrawlDeps['fetchHtml'] {
  return vi.fn(async (url: string) => {
    const key = url.replace(/\/$/, '');
    const html = pages[key];
    if (html === undefined) throw new Error('HTTP 404');
    return { url, html };
  });
}

const DEVPOST = 'https://test-hack.devpost.com';

describe('crawl', () => {
  it('reads Devpost pages and the official site, schedule pages first, skipping noise', async () => {
    const fetchHtml = fakeWeb({
      [DEVPOST]: page(
        `${filler(30)}
         <a href="/details/dates">Schedule</a><a href="/rules">Rules</a><a href="/participants">People</a>
         <a href="https://www.sponsor-corp.com/">Sponsor</a><a href="https://testhack.dev/">Website</a>`,
      ),
      [`${DEVPOST}/details/dates`]: page(`Submissions October 10 at 11:30am EDT ${filler(5)}`),
      [`${DEVPOST}/rules`]: page(`Teams of up to 4. ${filler(5)}`),
      'https://testhack.dev': page(`${filler(30)}<a href="/schedule">Schedule</a><a href="/login">Log in</a>`),
      'https://testhack.dev/schedule': page(`9:00 AM Opening ceremony ${filler(30)}`),
    });

    const result = await crawl(`${DEVPOST}/`, { fetchHtml, renderer: null, delayMs: 0 });

    expect(result.eventName).toBe('Test Hack 2026');
    expect(result.roles).toEqual({ devpostHost: 'test-hack.devpost.com', officialHost: 'testhack.dev' });
    expect(result.pages.map((p) => p.url)).toEqual([
      `${DEVPOST}/`,
      `${DEVPOST}/details/dates`,
      'https://testhack.dev/',
      'https://testhack.dev/schedule',
      `${DEVPOST}/rules`,
    ]);
    const fetched = vi.mocked(fetchHtml).mock.calls.map(([url]) => url);
    expect(fetched).not.toContain(`${DEVPOST}/participants`);
    expect(fetched).not.toContain('https://www.sponsor-corp.com/');
    expect(fetched).not.toContain('https://testhack.dev/login');
  });

  it('stops at the page limit and reports what it skipped', async () => {
    const links = Array.from({ length: 6 }, (_, i) => `<a href="/schedule-${i}">Schedule ${i}</a>`).join('');
    const pages: Record<string, string> = { 'https://testhack.dev': page(filler(30) + links) };
    for (let i = 0; i < 6; i++) pages[`https://testhack.dev/schedule-${i}`] = page(`10:00 AM item ${filler(20)}`);

    const result = await crawl('https://testhack.dev/', { fetchHtml: fakeWeb(pages), renderer: null, delayMs: 0 }, { maxPages: 3 });

    expect(result.pages).toHaveLength(3);
    expect(result.skipped.filter((s) => s.reason === 'Page limit reached')).toHaveLength(4);
  });

  it('skips pages that would go over the size budget, saying why', async () => {
    const fetchHtml = fakeWeb({
      'https://testhack.dev': page(`${filler(20)}<a href="/faq">FAQ</a>`),
      'https://testhack.dev/faq': page(filler(500)),
    });
    const result = await crawl('https://testhack.dev/', { fetchHtml, renderer: null, delayMs: 0 }, { maxChars: 2_000 });

    expect(result.pages.map((p) => p.url)).toEqual(['https://testhack.dev/']);
    expect(result.skipped).toEqual([{ url: 'https://testhack.dev/faq', reason: 'Over the size limit for one summary' }]);
  });

  it('records pages that fail to load', async () => {
    const result = await crawl('https://testhack.dev/', { fetchHtml: fakeWeb({}), renderer: null, delayMs: 0 });
    expect(result.pages).toEqual([]);
    expect(result.skipped).toEqual([{ url: 'https://testhack.dev/', reason: 'HTTP 404' }]);
  });

  it('renders schedule pages on non-Devpost sites and adds text from day tabs', async () => {
    const fetchHtml = fakeWeb({
      'https://testhack.dev': page(`${filler(30)}<a href="/schedule">Schedule</a>`),
      'https://testhack.dev/schedule': page('Friday 5:30 PM Kickoff'),
    });
    const renderer: Renderer = {
      render: vi.fn(async (url: string) => ({
        url,
        html: page(`<p>Friday 5:30 PM Kickoff</p><p>${filler(20)}</p>`),
        tabTexts: [{ label: 'Saturday', text: 'Friday 5:30 PM Kickoff\n9:00 AM Breakfast\n10:00 AM Hacking starts' }],
      })),
      close: vi.fn(async () => {}),
    };

    const result = await crawl('https://testhack.dev/', { fetchHtml, renderer, delayMs: 0 });

    expect(renderer.render).toHaveBeenCalledWith('https://testhack.dev/schedule');
    expect(renderer.render).not.toHaveBeenCalledWith('https://testhack.dev/');
    const schedule = result.pages.find((p) => p.url.endsWith('/schedule'))!;
    expect(schedule.rendered).toBe(true);
    expect(schedule.text).toContain('## Saturday\n9:00 AM Breakfast\n10:00 AM Hacking starts');
  });

  it('never renders Devpost pages', async () => {
    const renderer: Renderer = { render: vi.fn(), close: vi.fn() };
    const fetchHtml = fakeWeb({
      [DEVPOST]: page(`${filler(30)}<a href="/details/dates">Dates</a>`),
      [`${DEVPOST}/details/dates`]: page('Short dates page'),
    });
    await crawl(`${DEVPOST}/`, { fetchHtml, renderer, delayMs: 0 });
    expect(renderer.render).not.toHaveBeenCalled();
  });
});
