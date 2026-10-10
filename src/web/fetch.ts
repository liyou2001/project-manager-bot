import { createRequire } from 'node:module';
import { assertPublicUrl, UnsafeUrlError } from './safety.js';

interface Robots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}
// robots-parser is CommonJS and its types don't describe the ESM default import correctly.
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, contents: string) => Robots;

export const USER_AGENT = 'Mozilla/5.0 (compatible; ProjectManagerBot/0.1)';
const ROBOTS_AGENT = 'ProjectManagerBot';
const TIMEOUT_MS = 15_000;
const ROBOTS_TIMEOUT_MS = 5_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface FetchedHtml {
  /** Final URL after redirects. */
  url: string;
  html: string;
}

/**
 * Why a page couldn't be fetched. Only `http` and `network` failures are worth retrying
 * in the headless browser; the others would fail (or shouldn't be read) there too.
 */
export type FetchFailure = 'robots' | 'unsafe' | 'not-html' | 'too-large' | 'http' | 'network';

export class FetchError extends Error {
  constructor(
    message: string,
    readonly kind: FetchFailure,
  ) {
    super(message);
  }
}

/** Fetch with redirects followed by hand, checking every hop against private addresses. */
async function fetchPublic(url: URL, init: RequestInit & { timeoutMs: number }): Promise<{ url: URL; res: Response }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      await assertPublicUrl(current);
    } catch (error) {
      throw new FetchError((error as Error).message, error instanceof UnsafeUrlError ? 'unsafe' : 'network');
    }

    let res: Response;
    try {
      res = await fetch(current, { ...init, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs) });
    } catch (error) {
      const reason = (error as Error).name === 'TimeoutError' ? 'Timed out' : (error as Error).message;
      throw new FetchError(reason, 'network');
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    return { url: current, res };
  }
  throw new FetchError('Too many redirects.', 'http');
}

const robotsCache = new Map<string, Promise<Robots | null>>();

/** robots.txt for an origin, or null when there isn't a usable one (everything allowed). */
function getRobots(origin: string): Promise<Robots | null> {
  let robots = robotsCache.get(origin);
  if (!robots) {
    const robotsUrl = `${origin}/robots.txt`;
    robots = fetchPublic(new URL(robotsUrl), { headers: { 'user-agent': USER_AGENT }, timeoutMs: ROBOTS_TIMEOUT_MS })
      .then(async ({ res }) => {
        // Some sites answer robots.txt with an HTML error page; treat that as "no rules".
        if (!res.ok || !res.headers.get('content-type')?.includes('text/plain')) {
          await res.body?.cancel();
          return null;
        }
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
      throw new FetchError('Page is larger than 3 MB.', 'too-large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Download an HTML page, checking every redirect hop against private addresses and robots.txt. */
export async function fetchHtml(url: string): Promise<FetchedHtml> {
  const start = new URL(url);
  if (!(await isAllowedByRobots(start))) throw new FetchError('Blocked by the site’s robots.txt.', 'robots');

  const { url: final, res } = await fetchPublic(start, {
    // Devpost's bot filter rejects non-browsers that send a browser-style `accept: text/html`.
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    timeoutMs: TIMEOUT_MS,
  });
  if (final.toString() !== start.toString() && !(await isAllowedByRobots(final))) {
    await res.body?.cancel();
    throw new FetchError('Blocked by the site’s robots.txt.', 'robots');
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new FetchError(`HTTP ${res.status}`, 'http');
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/html') && !type.includes('application/xhtml')) {
    await res.body?.cancel();
    throw new FetchError(`Not a web page (${type.split(';')[0] || 'unknown type'}).`, 'not-html');
  }
  return { url: final.toString(), html: await readCapped(res) };
}
