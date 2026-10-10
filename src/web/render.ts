// Headless-browser fallback for pages that build their content with JavaScript.
// Playwright is imported lazily so the bot still runs if Chromium isn't installed.
import type { Browser, Page, Route } from 'playwright';
import { FetchError, isAllowedByRobots, USER_AGENT } from './fetch.js';
import { assertPublicUrl } from './safety.js';

export interface RenderedPage {
  /** URL of the document that was finally loaded, after redirects. */
  url: string;
  html: string;
  /** HTML after clicking each day tab (e.g. "Saturday"), for schedules shown one day at a time. */
  tabs: { label: string; html: string }[];
}

export interface Renderer {
  render(url: string): Promise<RenderedPage>;
  close(): Promise<void>;
}

export interface RendererOptions {
  /** Throws if a URL must not be loaded. Defaults to the private-address check. */
  checkUrl?: (url: string) => Promise<unknown>;
  isAllowedByRobots?: (url: URL) => Promise<boolean>;
}

const GOTO_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_TABS = 7;
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);
const TAB_CANDIDATES = '[role=tab], button, a[href^="#"], li';
// Tab labels like "Saturday", "Sat", "Day 2", "Saturday Oct 10"
const DAY_TAB_LABEL = /^\s*((mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(day)?\.?|day\s*\d+)(\s*[,\-–]?\s*[a-z]+\.?\s*\d{1,2})?\s*$/i;

let warnedMissingBrowser = false;

async function launchBrowser(): Promise<Browser> {
  try {
    const { chromium } = await import('playwright');
    return await chromium.launch();
  } catch (error) {
    if (!warnedMissingBrowser) {
      warnedMissingBrowser = true;
      console.warn(
        `Headless browser unavailable, so JavaScript-heavy pages won't be fully read. Run \`npm run setup:browser\`. (${(error as Error).message.split('\n')[0]})`,
      );
    }
    throw new FetchError('Headless browser is not installed.', 'network');
  }
}

/**
 * A headless browser for one crawl. Chromium only starts when the first page needs it,
 * so crawls that never render (e.g. Devpost-only) don't pay for it.
 */
export function createRenderer(options: RendererOptions = {}): Renderer {
  const checkUrl = options.checkUrl ?? assertPublicUrl;
  const robotsAllow = options.isAllowedByRobots ?? isAllowedByRobots;
  let browser: Promise<Browser> | null = null;

  // Cache host checks so the many sub-requests a page makes don't each do a DNS lookup.
  const hostChecks = new Map<string, Promise<boolean>>();
  const isAllowedHost = (url: string): Promise<boolean> => {
    const { origin } = new URL(url);
    let check = hostChecks.get(origin);
    if (!check) {
      check = checkUrl(url).then(
        () => true,
        () => false,
      );
      hostChecks.set(origin, check);
    }
    return check;
  };

  return {
    async render(url) {
      await checkUrl(url);
      if (!(await robotsAllow(new URL(url)))) throw new FetchError('Blocked by the site’s robots.txt.', 'robots');

      browser ??= launchBrowser();
      // Service workers and WebSockets bypass request routing, so turn them off entirely.
      const context = await (await browser).newContext({ userAgent: USER_AGENT, serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        let documentUrl = url;
        await context.routeWebSocket(/.*/, (ws) => ws.close());
        await context.route('**/*', (route) =>
          handleRequest(route, isAllowedHost, (finalUrl) => {
            if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
              documentUrl = finalUrl;
            }
          }),
        );

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
        await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
        const html = await page.content();
        const tabs = await clickDayTabs(page);
        return { url: documentUrl, html, tabs };
      } finally {
        await context.close();
      }
    },
    async close() {
      const launched = await browser?.catch(() => null);
      await launched?.close();
    },
  };
}

/**
 * Load every request ourselves, following redirects by hand and checking each hop.
 * Letting Chromium follow redirects would skip the check: route handlers only see the
 * first URL of a redirect chain.
 */
async function handleRequest(
  route: Route,
  isAllowedHost: (url: string) => Promise<boolean>,
  onLoaded: (finalUrl: string) => void,
): Promise<void> {
  const request = route.request();
  if (BLOCKED_RESOURCES.has(request.resourceType())) return route.abort();

  let current = request.url();
  if (!/^https?:/.test(current)) return route.continue();
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await isAllowedHost(current))) return await route.abort('blockedbyclient');
      const response = await route.fetch({ url: current, maxRedirects: 0, timeout: REQUEST_TIMEOUT_MS });
      const location = response.headers()['location'];
      if (response.status() >= 300 && response.status() < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      onLoaded(current);
      return await route.fulfill({ response });
    }
    await route.abort();
  } catch {
    // The page may have closed mid-request, or the fetch failed; either way, drop it.
    await route.abort().catch(() => {});
  }
}

/** Schedules often show one day at a time behind tabs; click each day tab and capture the page. */
async function clickDayTabs(page: Page): Promise<RenderedPage['tabs']> {
  const candidates = page.locator(TAB_CANDIDATES);
  // One round trip for every candidate's label and visibility.
  const found = await candidates.evaluateAll((elements) =>
    elements.map((element) => ({
      label: ((element as HTMLElement).innerText ?? '').trim(),
      visible: element.getClientRects().length > 0,
    })),
  );

  const startUrl = page.url().split('#')[0];
  const seen = new Set<string>();
  const tabs: RenderedPage['tabs'] = [];
  for (const [index, { label, visible }] of found.entries()) {
    if (tabs.length >= MAX_TABS) break;
    const key = label.toLowerCase();
    if (!visible || !DAY_TAB_LABEL.test(label) || seen.has(key)) continue;
    seen.add(key);

    try {
      await candidates.nth(index).click({ timeout: 2_000 });
      await page.waitForTimeout(600);
    } catch {
      continue; // not clickable after all
    }
    // A "tab" that navigated away isn't a tab; stop rather than read another page.
    if (page.url().split('#')[0] !== startUrl) break;
    tabs.push({ label, html: await page.content() });
  }
  return tabs;
}
