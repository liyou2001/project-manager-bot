import { extractPage, type EventHint, type ExtractedPage, type PageLink } from './extract.js';
import { FetchError, type FetchedHtml } from './fetch.js';
import {
  domainsInText,
  findDevpostSite,
  findOfficialSite,
  isDevpostHackathonHost,
  isScheduleLike,
  scoreLink,
  type SiteRoles,
} from './links.js';
import type { RenderedPage, Renderer } from './render.js';

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  rendered: boolean;
}

export interface SkippedPage {
  url: string;
  reason: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  skipped: SkippedPage[];
  eventName: string | null;
  eventHints: EventHint[];
  roles: SiteRoles;
}

export interface CrawlDeps {
  fetchHtml(url: string): Promise<FetchedHtml>;
  /** Headless browser for JavaScript-heavy pages; null when unavailable. */
  renderer: Renderer | null;
  /** Pause between requests to the same host. */
  delayMs?: number;
}

export interface CrawlOptions {
  /** Pages to read successfully. */
  maxPages?: number;
  /** Pages to try at all, including ones that fail, so a broken site can't keep the crawl going. */
  maxAttempts?: number;
  maxDepth?: number;
  /** Total text budget across all pages, so the AI prompt stays a sensible size. */
  maxChars?: number;
  /** Stop starting new pages after this long. */
  timeLimitMs?: number;
  onPage?(page: CrawledPage, pagesRead: number): void | Promise<void>;
}

interface QueueItem {
  url: string;
  linkText: string;
  score: number;
  depth: number;
}

const MIN_TEXT_FOR_PLAIN_FETCH = 300;
const MIN_USEFUL_TEXT = 50;
/** Once less than this much text budget is left, no page is worth fetching. */
const MIN_REMAINING_BUDGET = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Identity of a page for "already visited" checks: ignores www., hash and trailing slash. */
function pageKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
}

function eventNameFrom(page: ExtractedPage): string | null {
  const fromJsonLd = page.events.find((event) => event.name)?.name;
  if (fromJsonLd) return fromJsonLd;
  // Devpost titles look like "HackNC 2026: Dive into ... - Devpost"
  const title = page.title.replace(/\s*[-|–]\s*Devpost\s*$/i, '').split(':')[0]?.trim();
  return title || null;
}

/**
 * The lines of `lines` that differ from `base`, dropping the shared beginning and end
 * (header, day buttons, footer). Repeated lines in the middle, like the same time on
 * two days, are kept.
 */
export function differingMiddle(lines: string[], base: string[]): string[] {
  let start = 0;
  while (start < lines.length && start < base.length && lines[start] === base[start]) start++;
  let end = 0;
  while (
    end < lines.length - start &&
    end < base.length - start &&
    lines[lines.length - 1 - end] === base[base.length - 1 - end]
  ) {
    end++;
  }
  return lines.slice(start, lines.length - end);
}

/** Text from a rendered page plus what each day tab showed that the page itself didn't. */
function renderedText(rendered: RenderedPage): ExtractedPage {
  const page = extractPage(rendered.html, rendered.url);
  const baseLines = page.text.split('\n');
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const tab of rendered.tabs) {
    const middle = differingMiddle(extractPage(tab.html, rendered.url).text.split('\n'), baseLines);
    const key = middle.join('\n');
    // The tab showing by default adds nothing; two tabs showing the same thing count once.
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sections.push(`## ${tab.label}\n${key}`);
  }
  page.text = [page.text, ...sections].join('\n');
  return page;
}

/** Failures the headless browser might get past. Robots blocks, files and unsafe hosts aren't retried. */
function worthRendering(error: unknown): boolean {
  return !(error instanceof FetchError) || error.kind === 'http' || error.kind === 'network';
}

/**
 * Crawl a hackathon's Devpost site and official site, highest-value pages first:
 * schedules, dates, rules, FAQs. Uses the headless browser for pages that need it.
 */
export async function crawl(startUrl: string, deps: CrawlDeps, options: CrawlOptions = {}): Promise<CrawlResult> {
  const { maxPages = 10, maxAttempts = 15, maxDepth = 2, maxChars = 120_000, timeLimitMs = 90_000 } = options;
  const delayMs = deps.delayMs ?? 300;
  const deadline = Date.now() + timeLimitMs;

  const queue: QueueItem[] = [{ url: startUrl, linkText: '', score: Infinity, depth: 0 }];
  const visited = new Set<string>();
  const lastRequestAt = new Map<string, number>();
  const pages: CrawledPage[] = [];
  const skipped: SkippedPage[] = [];
  const eventHints: EventHint[] = [];
  const roles: SiteRoles = { devpostHost: null, officialHost: null };
  let eventName: string | null = null;
  let usedChars = 0;
  let attempts = 0;
  let rolesKnown = false;

  const politely = async <T>(url: string, load: () => Promise<T>): Promise<T> => {
    const host = new URL(url).host;
    const wait = (lastRequestAt.get(host) ?? 0) + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await load();
    } finally {
      lastRequestAt.set(host, Date.now());
    }
  };

  const enqueue = (links: PageLink[], depth: number) => {
    if (depth > maxDepth) return;
    for (const link of links) {
      const score = scoreLink(link, roles);
      if (score > 0 && !visited.has(pageKey(link.url))) queue.push({ url: link.url, linkText: link.text, score, depth });
    }
  };

  /** Why the crawl should stop now, or null to keep going. */
  const stopReason = (): string | null => {
    if (pages.length >= maxPages) return 'Page limit reached';
    if (attempts >= maxAttempts) return 'Too many pages tried';
    if (maxChars - usedChars < MIN_REMAINING_BUDGET) return 'Size limit for one summary reached';
    if (attempts > 0 && Date.now() >= deadline) return 'Time limit reached';
    return null;
  };

  while (queue.length > 0 && !stopReason()) {
    queue.sort((a, b) => b.score - a.score);
    const item = queue.shift()!;
    const key = pageKey(item.url);
    if (visited.has(key)) continue;
    visited.add(key);
    attempts++;

    const host = new URL(item.url).hostname;
    const isDevpost = host === roles.devpostHost || isDevpostHackathonHost(host);
    let page: ExtractedPage | null = null;
    let finalUrl = item.url;
    let rendered = false;
    let error: unknown = null;

    try {
      const fetched = await politely(item.url, () => deps.fetchHtml(item.url));
      finalUrl = fetched.url;
      page = extractPage(fetched.html, fetched.url);
    } catch (fetchError) {
      error = fetchError;
    }

    // Devpost renders on the server. Other sites often build schedules with JavaScript
    // or hide days behind tabs, so render those (and pages a plain fetch couldn't get).
    const wantsRender = page
      ? !isDevpost && (page.text.length < MIN_TEXT_FOR_PLAIN_FETCH || isScheduleLike(item.url, item.linkText))
      : !isDevpost && worthRendering(error);
    if (wantsRender && deps.renderer) {
      try {
        const result = await politely(finalUrl, () => deps.renderer!.render(finalUrl));
        const renderedPage = renderedText(result);
        if (!page || renderedPage.text.length >= page.text.length) {
          renderedPage.links = [...(page?.links ?? []), ...renderedPage.links];
          page = renderedPage;
          finalUrl = result.url;
          rendered = true;
        }
      } catch (renderError) {
        error ??= renderError;
      }
    }

    if (!page) {
      skipped.push({ url: item.url, reason: (error as Error | null)?.message ?? 'Could not load page' });
      continue;
    }
    // A redirect can land on a page we've already read (e.g. example.com -> www.example.com/).
    if (pageKey(finalUrl) !== key) {
      if (visited.has(pageKey(finalUrl))) continue;
      visited.add(pageKey(finalUrl));
    }
    eventHints.push(...page.events);

    // The first page tells us which hackathon this is and where its other site lives.
    if (!rolesKnown) {
      rolesKnown = true;
      eventName = eventNameFrom(page);
      const startHost = new URL(finalUrl).hostname;
      if (isDevpostHackathonHost(startHost)) {
        roles.devpostHost = startHost;
        const candidates = [...page.links, ...domainsInText(page.text)];
        roles.officialHost = eventName ? findOfficialSite(candidates, eventName, startHost) : null;
        if (roles.officialHost) enqueue([{ url: `https://${roles.officialHost}/`, text: '' }], 1);
      } else {
        roles.officialHost = startHost;
        roles.devpostHost = findDevpostSite(page.links);
        if (roles.devpostHost) enqueue([{ url: `https://${roles.devpostHost}/`, text: '' }], 1);
      }
    }
    enqueue(page.links, item.depth + 1);

    if (page.text.length < MIN_USEFUL_TEXT) {
      skipped.push({ url: finalUrl, reason: 'No readable text' });
      continue;
    }
    if (usedChars + page.text.length > maxChars) {
      skipped.push({ url: finalUrl, reason: 'Too long to fit in one summary' });
      continue;
    }
    usedChars += page.text.length;
    const crawled: CrawledPage = { url: finalUrl, title: page.title, text: page.text, rendered };
    pages.push(crawled);
    await options.onPage?.(crawled, pages.length);
  }

  const leftoverReason = stopReason() ?? 'Not reached';
  for (const item of queue) {
    if (!visited.has(pageKey(item.url))) {
      visited.add(pageKey(item.url));
      skipped.push({ url: item.url, reason: leftoverReason });
    }
  }
  return { pages, skipped, eventName, eventHints, roles };
}
