import { describe, expect, it, vi } from 'vitest';
import { crawl, differingMiddle, type CrawlDeps } from './crawl.js';
import { FetchError } from './fetch.js';
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
    expect(result.skipped).toEqual([{ url: 'https://testhack.dev/faq', reason: 'Too long to fit in one summary' }]);
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
        html: page(`<nav>Home Schedule</nav><p>Friday 5:30 PM Kickoff</p><p>${filler(20)}</p>`),
        tabs: [
          {
            label: 'Saturday',
            html: page(`<nav>Home Schedule</nav><p>Friday 5:30 PM Kickoff</p><ul><li>9:00 AM Breakfast</li><li>10:00 AM Hacking starts</li></ul>`),
          },
        ],
      })),
      close: vi.fn(async () => {}),
    };

    const result = await crawl('https://testhack.dev/', { fetchHtml, renderer, delayMs: 0 });

    expect(renderer.render).toHaveBeenCalledWith('https://testhack.dev/schedule');
    expect(renderer.render).not.toHaveBeenCalledWith('https://testhack.dev/');
    const schedule = result.pages.find((p) => p.url.endsWith('/schedule'))!;
    expect(schedule.rendered).toBe(true);
    // Only what the tab added, with the same formatting as the page (no menus, no repeats).
    expect(schedule.text).toContain('## Saturday\n- 9:00 AM Breakfast\n- 10:00 AM Hacking starts');
    expect(schedule.text.match(/Kickoff/g)).toHaveLength(1);
    expect(schedule.text).not.toContain('Home Schedule');
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

  it.each([
    ['robots.txt blocks', new FetchError('Blocked by the site’s robots.txt.', 'robots')],
    ['it is a file', new FetchError('Not a web page (application/pdf).', 'not-html')],
    ['it is unsafe', new FetchError('points to a private network address', 'unsafe')],
  ])('does not open a page in the browser when %s', async (_, error) => {
    const renderer: Renderer = { render: vi.fn(), close: vi.fn() };
    const fetchHtml = vi.fn(async () => {
      throw error;
    });
    const result = await crawl('https://testhack.dev/schedule', { fetchHtml, renderer, delayMs: 0 });
    expect(renderer.render).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([{ url: 'https://testhack.dev/schedule', reason: error.message }]);
  });

  it('retries pages that failed with an HTTP or network error in the browser', async () => {
    const renderer: Renderer = {
      render: vi.fn(async (url: string) => ({ url, html: page(`9:00 AM Opening ${filler(30)}`), tabs: [] })),
      close: vi.fn(),
    };
    const fetchHtml = vi.fn(async () => {
      throw new FetchError('HTTP 403', 'http');
    });
    const result = await crawl('https://testhack.dev/', { fetchHtml, renderer, delayMs: 0 });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.rendered).toBe(true);
  });

  it('counts failed pages toward the attempt limit', async () => {
    const links = Array.from({ length: 50 }, (_, i) => `<a href="/events-${i}">Events ${i}</a>`).join('');
    const fetchHtml = vi.fn(async (url: string) => {
      if (url === 'https://testhack.dev/') return { url, html: page(filler(30) + links) };
      throw new FetchError('HTTP 500', 'http');
    });
    const result = await crawl('https://testhack.dev/', { fetchHtml, renderer: null, delayMs: 0 }, { maxAttempts: 15 });
    expect(fetchHtml).toHaveBeenCalledTimes(15);
    expect(result.skipped.filter((s) => s.reason === 'Too many pages tried')).toHaveLength(36);
  });

  it('stops starting new pages after the time limit', async () => {
    const fetchHtml = fakeWeb({
      'https://testhack.dev': page(`${filler(30)}<a href="/faq">FAQ</a>`),
      'https://testhack.dev/faq': page(filler(30)),
    });
    const result = await crawl('https://testhack.dev/', { fetchHtml, renderer: null, delayMs: 0 }, { timeLimitMs: 0 });
    expect(result.pages.map((p) => p.url)).toEqual(['https://testhack.dev/']);
    expect(result.skipped).toEqual([{ url: 'https://testhack.dev/faq', reason: 'Time limit reached' }]);
  });

  it('stops once the text budget is used up', async () => {
    const links = Array.from({ length: 5 }, (_, i) => `<a href="/faq-${i}">FAQ ${i}</a>`).join('');
    const pages: Record<string, string> = { 'https://testhack.dev': page(filler(100) + links) };
    for (let i = 0; i < 5; i++) pages[`https://testhack.dev/faq-${i}`] = page(filler(100));
    const fetchHtml = fakeWeb(pages);

    const result = await crawl('https://testhack.dev/', { fetchHtml, renderer: null, delayMs: 0 }, { maxChars: 4_500 });

    expect(result.pages).toHaveLength(2);
    expect(fetchHtml).toHaveBeenCalledTimes(2);
    expect(result.skipped.every((s) => s.reason === 'Size limit for one summary reached')).toBe(true);
  });

  it('keeps lines a tab repeats from another day, such as the same time', () => {
    const header = ['## Schedule', 'Thursday Friday'];
    const footer = ['made with <3'];
    const thursday = [...header, 'October 8', '5:30 PM', '## Mini Hackathon', ...footer];
    const friday = [...header, 'October 9', '5:30 PM', '## Kickoff', '5:30 PM', '## Team Matching', ...footer];
    expect(differingMiddle(friday, thursday)).toEqual(['October 9', '5:30 PM', '## Kickoff', '5:30 PM', '## Team Matching']);
    expect(differingMiddle(thursday, thursday)).toEqual([]);
  });
});
