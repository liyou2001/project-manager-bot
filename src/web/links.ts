// Decides which links the crawler follows. Pure functions so they're easy to test.
import type { PageLink } from './extract.js';

/** The two sites a hackathon usually spans. */
export interface SiteRoles {
  /** The hackathon's Devpost site, e.g. "hacknc-2026.devpost.com". */
  devpostHost: string | null;
  /** The organizers' own site, e.g. "hacknc.com". Usually where workshop schedules live. */
  officialHost: string | null;
}

const DEVPOST_PAGE_SCORES: Record<string, number> = {
  '/': 9,
  '/details/dates': 10,
  '/rules': 8,
  '/updates': 3,
  '/resources': 3,
};
const DEVPOST_NON_HACKATHON_SUBDOMAINS = new Set(['www', 'secure', 'help', 'info', 'api', 'post']);

// Domains linked from hackathon pages that are never the organizers' own site.
const NOT_OFFICIAL = [
  'devpost.com', 'discord.com', 'discord.gg', 'mlh.io', 'mlh.link', 'mlh.com', 'github.com',
  'google.com', 'goo.gl', 'youtube.com', 'youtu.be', 'facebook.com', 'twitter.com', 'x.com',
  'instagram.com', 'linkedin.com', 'tiktok.com', 'zoom.us', 'apple.com', 'browsehappy.com',
  'notion.site', 'notion.so', 'medium.com', 'eventbrite.com', 'linktr.ee',
];
const IGNORED_LABELS = new Set(['www', 'co', 'com', 'org', 'net', 'edu', 'ac']);

const SKIP = /log-?in|sign-?in|sign-?up|register|registration|\bapply\b|dashboard|portal|team-?finder|sponsor|privacy|terms|cookie|cdn-cgi/i;
// Files, not web pages. Checked against the path alone.
const FILE_EXTENSION = /\.(png|jpe?g|gif|svg|webp|pdf|zip|ics|docx?|pptx?|xlsx?|mp4|mov)$/i;
const SCHEDULE_WORDS = /schedule|agenda|itinerary|timeline|\bevents?\b|workshops?/i;
const INFO_WORDS = /faq|rules|\binfo\b|tracks?|judging|prizes?|resources|guide|details|hackers?\b/i;
const GUIDE_HOSTS = ['notion.site', 'notion.so', 'docs.google.com'];
const GUIDE_WORDS = /hacker ?guide|handbook|schedule|itinerary|agenda/i;

const bareHost = (host: string) => host.replace(/^www\./, '');
const isOnDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function isDevpostHackathonHost(host: string): boolean {
  if (!host.endsWith('.devpost.com')) return false;
  return !DEVPOST_NON_HACKATHON_SUBDOMAINS.has(host.slice(0, -'.devpost.com'.length));
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find the organizers' own site among a page's links: the host whose name matches the
 * hackathon's name ("Knight Hacks IX" -> 2026.knighthacks.org). Sponsors won't match.
 */
export function findOfficialSite(links: PageLink[], eventName: string, excludeHost: string): string | null {
  const name = normalizeName(eventName);
  if (name.length < 4) return null;

  let best: { host: string; strength: number } | null = null;
  for (const link of links) {
    const host = new URL(link.url).hostname;
    if (host === excludeHost || NOT_OFFICIAL.some((domain) => isOnDomain(host, domain))) continue;

    const labels = host.split('.').slice(0, -1).filter((label) => !IGNORED_LABELS.has(label));
    for (const label of labels) {
      if (label.length < 6 || /^\d+$/.test(label)) continue;
      if ((name.includes(label) || label.includes(name)) && label.length > (best?.strength ?? 0)) {
        best = { host, strength: label.length };
      }
    }
  }
  return best?.host ?? null;
}

// Website names written as plain text, e.g. a "palmettohacks.com" heading that isn't a link.
const DOMAIN_IN_TEXT = /\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|dev|co|ai|app|tech|xyz|edu|us|ca|info|me|club|site|online|events?))\b/gi;

/** Websites mentioned in text but not linked, as links to their home page. */
export function domainsInText(text: string): PageLink[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(DOMAIN_IN_TEXT)) hosts.add(match[1]!.toLowerCase());
  return [...hosts].map((host) => ({ url: `https://${host}/`, text: host }));
}

/** First link to a hackathon's Devpost site, for when the crawl starts on the official site. */
export function findDevpostSite(links: PageLink[]): string | null {
  for (const link of links) {
    const host = new URL(link.url).hostname;
    if (isDevpostHackathonHost(host)) return host;
  }
  return null;
}

function officialPageScore(url: URL, text: string): number {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 9;
  let haystack = `${path} ${text}`;
  try {
    haystack = `${decodeURIComponent(path)} ${text}`;
  } catch {
    // keep the raw path
  }
  if (SKIP.test(haystack)) return 0;
  if (SCHEDULE_WORDS.test(haystack)) return 10;
  if (INFO_WORDS.test(haystack)) return 6;
  if (/about/i.test(haystack)) return 3;
  return 0;
}

/** How much a link is worth following (0 = don't). Higher is visited first. */
export function scoreLink(link: PageLink, roles: SiteRoles): number {
  const url = new URL(link.url);
  const host = url.hostname;
  if (FILE_EXTENSION.test(url.pathname)) return 0;

  if (roles.devpostHost && host === roles.devpostHost) {
    if (url.search) return 0;
    return DEVPOST_PAGE_SCORES[url.pathname.replace(/\/+$/, '') || '/'] ?? 0;
  }
  if (roles.officialHost && bareHost(host) === bareHost(roles.officialHost)) {
    return officialPageScore(url, link.text);
  }
  // Hacker guides are often a Notion page or Google Doc linked from either site.
  if (GUIDE_HOSTS.some((domain) => isOnDomain(host, domain)) && GUIDE_WORDS.test(link.text)) return 7;
  return 0;
}

/** Pages likely to hold a schedule, which often needs a real browser to read fully. */
export function isScheduleLike(url: string, linkText = ''): boolean {
  return SCHEDULE_WORDS.test(`${new URL(url).pathname} ${linkText}`) || /dates/i.test(new URL(url).pathname);
}
