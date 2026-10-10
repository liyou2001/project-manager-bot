import { createRequire } from 'node:module';
import { assertPublicUrl } from './safety.js';

interface Robots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}
// robots-parser is CommonJS and its types don't describe the ESM default import correctly.
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, contents: string) => Robots;

export const USER_AGENT = 'Mozilla/5.0 (compatible; ProjectManagerBot/0.1)';
const ROBOTS_AGENT = 'ProjectManagerBot';
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface FetchedHtml {
  /** Final URL after redirects. */
  url: string;
  html: string;
}

export class FetchError extends Error {}

const robotsCache = new Map<string, Promise<Robots | null>>();

/** robots.txt for an origin, or null when there isn't a usable one (everything allowed). */
function getRobots(origin: string): Promise<Robots | null> {
  let robots = robotsCache.get(origin);
  if (!robots) {
    const robotsUrl = `${origin}/robots.txt`;
    robots = fetch(robotsUrl, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(5_000) })
      .then(async (res) => {
        // Some sites answer robots.txt with an HTML error page; treat that as "no rules".
        if (!res.ok || !res.headers.get('content-type')?.includes('text/plain')) return null;
        return robotsParser(robotsUrl, await res.text());
      })
      .catch(() => null);
    robotsCache.set(origin, robots);
  }
  return robots;
}

export async function isAllowedByRobots(url: URL): Promise<boolean> {
  const robots = await getRobots(url.origin);
  return robots?.isAllowed(url.toString(), ROBOTS_AGENT) ?? true;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new FetchError('Page is larger than 3 MB.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Download an HTML page, checking every redirect hop against private addresses and robots.txt. */
export async function fetchHtml(url: string): Promise<FetchedHtml> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    if (!(await isAllowedByRobots(current))) {
      throw new FetchError('Blocked by the site’s robots.txt.');
    }

    const res = await fetch(current, {
      redirect: 'manual',
      // Devpost's bot filter rejects non-browsers that send a browser-style `accept: text/html`.
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`);

    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/html') && !type.includes('application/xhtml')) {
      throw new FetchError(`Not a web page (${type.split(';')[0] || 'unknown type'}).`);
    }
    return { url: current.toString(), html: await readCapped(res) };
  }
  throw new FetchError('Too many redirects.');
}
