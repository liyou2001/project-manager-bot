import { extractPage, type EventHint, type ExtractedPage, type PageLink } from './extract.js';
import type { FetchedHtml } from './fetch.js';
import {
  domainsInText,
  findDevpostSite,
  findOfficialSite,
  isDevpostHackathonHost,
  isScheduleLike,
  scoreLink,
  type SiteRoles,
} from './links.js';
import type { Renderer } from './render.js';

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
  maxPages?: number;
  maxDepth?: number;
  /** Total text budget across all pages, so the AI prompt stays a sensible size. */
  maxChars?: number;
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

/** Append text revealed by clicking day tabs, skipping lines the page text already has. */
function withTabTexts(text: string, tabTexts: { label: string; text: string }[]): string {
  const seen = new Set(text.split('\n'));
  const sections: string[] = [];
  for (const tab of tabTexts) {
    const fresh = tab.text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line && !seen.has(line));
    fresh.forEach((line) => seen.add(line));
    if (fresh.length) sections.push(`## ${tab.label}\n${fresh.join('\n')}`);
  }
  return [text, ...sections].join('\n');
}

/**
 * Crawl a hackathon's Devpost site and official site, highest-value pages first:
 * schedules, dates, rules, FAQs. Uses the headless browser for pages that need it.
 */
export async function crawl(startUrl: string, deps: CrawlDeps, options: CrawlOptions = {}): Promise<CrawlResult> {
  const { maxPages = 10, maxDepth = 2, maxChars = 120_000 } = options;
  const delayMs = deps.delayMs ?? 300;

  const queue: QueueItem[] = [{ url: startUrl, linkText: '', score: Infinity, depth: 0 }];
  const visited = new Set<string>();
  const lastRequestAt = new Map<string, number>();
  const pages: CrawledPage[] = [];
  const skipped: SkippedPage[] = [];
  const eventHints: EventHint[] = [];
  const roles: SiteRoles = { devpostHost: null, officialHost: null };
  let eventName: string | null = null;
  let usedChars = 0;
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

  while (queue.length > 0 && pages.length < maxPages) {
    queue.sort((a, b) => b.score - a.score);
    const item = queue.shift()!;
    const key = pageKey(item.url);
    if (visited.has(key)) continue;
    visited.add(key);

    const host = new URL(item.url).hostname;
    const isDevpost = host === roles.devpostHost || isDevpostHackathonHost(host);
    let page: ExtractedPage | null = null;
    let finalUrl = item.url;
    let rendered = false;
    let error: string | null = null;

    try {
      const fetched = await politely(item.url, () => deps.fetchHtml(item.url));
      finalUrl = fetched.url;
      page = extractPage(fetched.html, fetched.url);
    } catch (fetchError) {
      error = (fetchError as Error).message;
    }

    // Devpost renders on the server. Other sites often build schedules with JavaScript
    // or hide days behind tabs, so render those (and anything that came back empty).
    const wantsRender =
      deps.renderer &&
      !isDevpost &&
      (!page || page.text.length < MIN_TEXT_FOR_PLAIN_FETCH || isScheduleLike(item.url, item.linkText));
    if (wantsRender && deps.renderer) {
      try {
        const result = await politely(item.url, () => deps.renderer!.render(item.url));
        const renderedPage = extractPage(result.html, result.url);
        renderedPage.text = withTabTexts(renderedPage.text, result.tabTexts);
        if (!page || renderedPage.text.length >= page.text.length) {
          renderedPage.links = [...(page?.links ?? []), ...renderedPage.links];
          page = renderedPage;
          finalUrl = result.url;
          rendered = true;
        }
      } catch (renderError) {
        error ??= (renderError as Error).message;
      }
    }

    if (!page) {
      skipped.push({ url: item.url, reason: error ?? 'Could not load page' });
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
      skipped.push({ url: finalUrl, reason: 'Over the size limit for one summary' });
      continue;
    }
    usedChars += page.text.length;
    const crawled: CrawledPage = { url: finalUrl, title: page.title, text: page.text, rendered };
    pages.push(crawled);
    await options.onPage?.(crawled, pages.length);
  }

  for (const item of queue) {
    if (!visited.has(pageKey(item.url))) {
      visited.add(pageKey(item.url));
      skipped.push({ url: item.url, reason: 'Page limit reached' });
    }
  }
  return { pages, skipped, eventName, eventHints, roles };
}
