// Headless-browser fallback for pages that build their content with JavaScript.
// Playwright is imported lazily so the bot still runs if Chromium isn't installed.
import type { Browser, Page } from 'playwright';
import { USER_AGENT } from './fetch.js';
import { assertPublicUrl } from './safety.js';

export interface RenderedPage {
  url: string;
  html: string;
  /** Text revealed by clicking day tabs (e.g. "Saturday"), which isn't in `html`. */
  tabTexts: { label: string; text: string }[];
}

export interface Renderer {
  render(url: string): Promise<RenderedPage>;
  close(): Promise<void>;
}

const GOTO_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 8_000;
const MAX_TABS = 7;
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);
// Tab labels like "Saturday", "Sat", "Day 2", "Saturday Oct 10"
const DAY_TAB_LABEL = /^\s*((mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(day)?\.?|day\s*\d+)(\s*[,\-–]?\s*[a-z]+\.?\s*\d{1,2})?\s*$/i;

let warnedMissingBrowser = false;

/** Start a headless browser for one crawl, or return null if Chromium isn't available. */
export async function createRenderer(): Promise<Renderer | null> {
  let browser: Browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  } catch (error) {
    if (!warnedMissingBrowser) {
      warnedMissingBrowser = true;
      console.warn(
        `Headless browser unavailable, so JavaScript-heavy pages won't be fully read. Run \`npm run setup:browser\`. (${(error as Error).message.split('\n')[0]})`,
      );
    }
    return null;
  }

  // Cache host checks so the many sub-requests a page makes don't each do a DNS lookup.
  const hostChecks = new Map<string, Promise<boolean>>();
  const isPublicHost = (url: string): Promise<boolean> => {
    const { origin } = new URL(url);
    let check = hostChecks.get(origin);
    if (!check) {
      check = assertPublicUrl(url).then(
        () => true,
        () => false,
      );
      hostChecks.set(origin, check);
    }
    return check;
  };

  return {
    async render(url) {
      await assertPublicUrl(url);
      const page = await browser.newPage({ userAgent: USER_AGENT });
      try {
        await page.route('**/*', async (route) => {
          const request = route.request();
          if (BLOCKED_RESOURCES.has(request.resourceType())) return route.abort();
          if (/^https?:/.test(request.url()) && !(await isPublicHost(request.url()))) return route.abort();
          return route.continue();
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
        await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
        const html = await page.content();
        const tabTexts = await clickDayTabs(page);
        return { url: page.url(), html, tabTexts };
      } finally {
        await page.close();
      }
    },
    async close() {
      await browser.close();
    },
  };
}

/** Schedules often show one day at a time behind tabs; click each day tab and capture its text. */
async function clickDayTabs(page: Page): Promise<RenderedPage['tabTexts']> {
  const candidates = page.locator('[role=tab], button, a[href^="#"], li');
  const count = Math.min(await candidates.count(), 300);
  const seen = new Set<string>();
  const results: RenderedPage['tabTexts'] = [];

  for (let i = 0; i < count && seen.size < MAX_TABS; i++) {
    const tab = candidates.nth(i);
    const label = (await tab.innerText({ timeout: 1_000 }).catch(() => '')).trim();
    const key = label.toLowerCase();
    if (!DAY_TAB_LABEL.test(label) || seen.has(key)) continue;
    if (!(await tab.isVisible().catch(() => false))) continue;
    seen.add(key);

    try {
      await tab.click({ timeout: 2_000 });
      await page.waitForTimeout(600);
      results.push({ label, text: await page.innerText('body') });
    } catch {
      // Not clickable after all; skip it.
    }
  }
  return results;
}
