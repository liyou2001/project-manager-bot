import * as cheerio from 'cheerio';

export interface PageLink {
  url: string;
  text: string;
}

/** The useful parts of a schema.org Event block. */
export interface EventHint {
  name: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
}

export interface ExtractedPage {
  title: string;
  /** Readable text with light structure: "## heading", "- item", "cell | cell". */
  text: string;
  links: PageLink[];
  events: EventHint[];
}

// Elements that never hold content worth reading. Devpost's site-wide menu, old-browser
// banner and "other hackathons" box are named explicitly; #challenge-header is kept
// because it shows the submission deadline.
const REMOVE = [
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'template',
  'nav',
  'footer',
  'form',
  '[hidden]',
  '[aria-hidden="true"]',
  '#global-nav',
  '#unsupported_browser_version',
  '.persistent_message',
  '.hackathon-recommendations',
].join(',');

const BLOCK_TAGS = 'p,div,section,article,main,aside,header,ul,ol,dl,dt,dd,table,blockquote,pre,br,hr,tr';

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function locationText(location: unknown): string | null {
  if (typeof location === 'string') return location.trim() || null;
  if (!location || typeof location !== 'object') return null;
  const place = location as Record<string, unknown>;
  const address = place.address;
  const addressText =
    typeof address === 'string'
      ? address
      : address && typeof address === 'object'
        ? asString((address as Record<string, unknown>).streetAddress) ??
          asString((address as Record<string, unknown>).name)
        : null;
  return [asString(place.name), addressText].filter(Boolean).join(', ') || null;
}

function parseEventHints($: cheerio.CheerioAPI): EventHint[] {
  const hints: EventHint[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: unknown;
    try {
      data = JSON.parse($(el).text());
    } catch {
      return;
    }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items.flatMap((entry) => (entry && typeof entry === 'object' && '@graph' in entry ? (entry as { '@graph': unknown[] })['@graph'] : [entry]))) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const type = record['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (!types.some((t) => typeof t === 'string' && t.endsWith('Event'))) continue;
      hints.push({
        name: asString(record.name),
        startDate: asString(record.startDate),
        endDate: asString(record.endDate),
        location: locationText(record.location),
      });
    }
  });
  return hints;
}

function collectLinks($: cheerio.CheerioAPI, baseUrl: string): PageLink[] {
  const links = new Map<string, PageLink>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    url.hash = '';
    const text = ($(el).text() || $(el).attr('aria-label') || '').replace(/\s+/g, ' ').trim();
    const existing = links.get(url.toString());
    if (!existing || (!existing.text && text)) links.set(url.toString(), { url: url.toString(), text });
  });
  return [...links.values()];
}

/** Turn the DOM into text, keeping headings, list items and table rows recognizable. */
function readableText($: cheerio.CheerioAPI): string {
  const mark = (selector: string, before: string, after = '') =>
    $(selector).each((_, el) => {
      $(el).prepend(before).append(after);
    });
  mark('h1,h2,h3,h4,h5,h6', '\n## ', '\n');
  mark('li', '\n- ', '\n');
  mark('td,th', '', ' | ');
  mark(BLOCK_TAGS, '\n', '\n');

  const root = $('body').length ? $('body').text() : $.root().text();
  const lines = root
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .filter((line) => line && line !== '-' && line !== '##' && line !== '|');

  // Drop immediate repeats (e.g. a heading that also appears as a link right after it).
  return lines.filter((line, i) => line !== lines[i - 1]).join('\n');
}

export function extractPage(html: string, url: string): ExtractedPage {
  const $ = cheerio.load(html);
  const title = (
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text() ||
    ''
  ).trim();
  const events = parseEventHints($);
  // Links first: menus are removed below but often hold the most useful links (e.g. /schedule).
  const links = collectLinks($, url);
  $(REMOVE).remove();
  return { title, text: readableText($), links, events };
}
