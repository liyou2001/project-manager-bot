// Runs a real headless browser against local servers. Skipped if Chromium isn't installed.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError } from './fetch.js';
import { createRenderer, type Renderer } from './render.js';

const browserAvailable = await import('playwright')
  .then(({ chromium }) => chromium.launch().then((browser) => browser.close().then(() => true)))
  .catch(() => false);

function serve(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })),
  );
}

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe.skipIf(!browserAvailable)('createRenderer', () => {
  let forbidden: { server: http.Server; origin: string };
  let site: { server: http.Server; origin: string };
  let renderer: Renderer;

  beforeAll(async () => {
    // Stands in for an internal service the bot must never read.
    forbidden = await serve((_, res) => {
      res.setHeader('content-type', 'text/html');
      res.setHeader('access-control-allow-origin', '*');
      res.end(html('<p>SECRET INTERNAL DATA</p>'));
    });
    site = await serve((req, res) => {
      const redirect = (to: string) => {
        res.statusCode = 302;
        res.setHeader('location', to);
        res.end();
      };
      if (req.url === '/to-secret') return redirect(`${forbidden.origin}/secret`);
      if (req.url === '/moved') return redirect('/final');
      res.setHeader('content-type', 'text/html');
      if (req.url === '/calls-secret') {
        return res.end(
          html(`<p>public page</p><script>
            fetch('${forbidden.origin}/secret').then((r) => r.text())
              .then((t) => document.body.insertAdjacentHTML('beforeend', '<p>' + t + '</p>')).catch(() => {});
          </script>`),
        );
      }
      if (req.url === '/schedule') {
        return res.end(
          html(`<button>Friday</button><button>Saturday</button><div id="day">Friday 5:30 PM Kickoff</div>
            <script>
              const days = { Friday: 'Friday 5:30 PM Kickoff', Saturday: 'Saturday 9:00 AM Breakfast' };
              for (const b of document.querySelectorAll('button')) b.onclick = () => (document.getElementById('day').textContent = days[b.textContent]);
            </script>`),
        );
      }
      res.end(html(`<p>public ${req.url}</p>`));
    });
    // Only the test site counts as public; the "internal" server is treated as private.
    renderer = createRenderer({
      checkUrl: async (url) => {
        if (!url.startsWith(site.origin)) throw new Error('private address');
      },
      isAllowedByRobots: async (url) => !url.pathname.startsWith('/private'),
    });
  });

  afterAll(async () => {
    await renderer?.close();
    forbidden?.server.close();
    site?.server.close();
  });

  it('follows a redirect within allowed sites and reports the final URL', async () => {
    const page = await renderer.render(`${site.origin}/moved`);
    expect(page.url).toBe(`${site.origin}/final`);
    expect(page.html).toContain('public /final');
  }, 30_000);

  it('blocks a redirect to a private address', async () => {
    const result = await renderer.render(`${site.origin}/to-secret`).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  }, 30_000);

  it('blocks scripts on the page from reading private addresses', async () => {
    const page = await renderer.render(`${site.origin}/calls-secret`);
    expect(page.html).toContain('public page');
    expect(page.html).not.toContain('SECRET');
  }, 30_000);

  it('refuses private start URLs and pages robots.txt disallows', async () => {
    await expect(renderer.render(`${forbidden.origin}/secret`)).rejects.toThrow('private address');
    await expect(renderer.render(`${site.origin}/private/page`)).rejects.toThrow(FetchError);
  }, 30_000);

  it('captures each day tab of a schedule', async () => {
    const page = await renderer.render(`${site.origin}/schedule`);
    expect(page.tabs.map((tab) => tab.label)).toEqual(['Friday', 'Saturday']);
    expect(page.tabs[1]!.html).toContain('Saturday 9:00 AM Breakfast');
  }, 30_000);
});
