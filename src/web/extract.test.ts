import { describe, expect, it } from 'vitest';
import { extractPage } from './extract.js';

// A trimmed-down page shaped like a Devpost hackathon page.
const DEVPOST_LIKE = `<!doctype html><html><head>
  <title>Test Hack 2026: Build things - Devpost</title>
  <meta property="og:title" content="Test Hack 2026">
  <script type="application/ld+json">{"@context":"http://schema.org","@type":"Event","name":"Test Hack 2026",
    "startDate":"2026-10-10T09:00:00-04:00","endDate":"2026-10-11T12:00:00-04:00",
    "location":{"@type":"Place","name":"Main Hall","address":{"@type":"PostalAddress","streetAddress":"1 College Ave"}}}</script>
  <style>.x{color:red}</style>
</head><body>
  <div id="unsupported_browser_version" class="persistent_message">Please upgrade your browser</div>
  <header id="global-nav"><nav><a href="/login">Log in</a><a href="https://devpost.com/hackathons">Join a hackathon</a></nav></header>
  <section id="challenge-header"><h1>Test Hack 2026</h1><p>Deadline: Oct 11, 2026 @ 10:00am EDT</p></section>
  <nav id="challenge-navigation"><a href="/details/dates">Schedule</a><a href="/rules#top">Rules</a></nav>
  <article>
    <h2>Requirements</h2>
    <ul><li>Submit a <b>demo video</b></li><li>Link your repo</li></ul>
    <table><tr><th>Period</th><th>Begins</th></tr><tr><td>Submissions</td><td>October 10 at 11:30am EDT</td></tr></table>
    <p>Official site: <a href="https://testhack.dev/">testhack.dev</a> &amp; more</p>
    <script>window.secret = "do not include"</script>
    <div hidden>Hidden text</div>
  </article>
  <footer><a href="/terms">Terms</a> Copyright</footer>
  <div class="hackathon-recommendations">Other hackathons you may like</div>
</body></html>`;

describe('extractPage', () => {
  const page = extractPage(DEVPOST_LIKE, 'https://testhack-2026.devpost.com/');

  it('uses og:title as the title', () => {
    expect(page.title).toBe('Test Hack 2026');
  });

  it('keeps the deadline header and content, with structure', () => {
    expect(page.text).toContain('## Test Hack 2026');
    expect(page.text).toContain('Deadline: Oct 11, 2026 @ 10:00am EDT');
    expect(page.text).toContain('## Requirements\n- Submit a demo video\n- Link your repo');
    expect(page.text).toContain('Submissions | October 10 at 11:30am EDT');
    expect(page.text).toContain('Official site: testhack.dev & more');
  });

  it('drops menus, banners, footers, scripts and hidden content', () => {
    for (const unwanted of ['upgrade your browser', 'Log in', 'Join a hackathon', 'Copyright', 'Other hackathons', 'do not include', 'Hidden text', 'color:red']) {
      expect(page.text).not.toContain(unwanted);
    }
  });

  it('collects absolute links, including ones inside menus, without hashes', () => {
    const urls = page.links.map((link) => link.url);
    expect(urls).toContain('https://testhack-2026.devpost.com/details/dates');
    expect(urls).toContain('https://testhack-2026.devpost.com/rules');
    expect(urls).toContain('https://testhack.dev/');
    expect(page.links.find((link) => link.url.endsWith('/details/dates'))?.text).toBe('Schedule');
  });

  it('reads schema.org Event data', () => {
    expect(page.events).toEqual([
      {
        name: 'Test Hack 2026',
        startDate: '2026-10-10T09:00:00-04:00',
        endDate: '2026-10-11T12:00:00-04:00',
        location: 'Main Hall, 1 College Ave',
      },
    ]);
  });

  it('copes with broken JSON-LD and pages without a body', () => {
    const broken = extractPage('<script type="application/ld+json">{oops</script><p>Hi</p>', 'https://a.dev/');
    expect(broken.events).toEqual([]);
    expect(broken.text).toBe('Hi');
  });
});
