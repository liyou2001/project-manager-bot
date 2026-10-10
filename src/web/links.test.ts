import { describe, expect, it } from 'vitest';
import { domainsInText, findOfficialSite, isDevpostHackathonHost, isScheduleLike, scoreLink, type SiteRoles } from './links.js';

const link = (url: string, text = '') => ({ url, text });

describe('isDevpostHackathonHost', () => {
  it('accepts hackathon subdomains only', () => {
    expect(isDevpostHackathonHost('hacknc-2026.devpost.com')).toBe(true);
    expect(isDevpostHackathonHost('devpost.com')).toBe(false);
    expect(isDevpostHackathonHost('secure.devpost.com')).toBe(false);
    expect(isDevpostHackathonHost('example.com')).toBe(false);
  });
});

describe('findOfficialSite', () => {
  const sponsors = [
    link('https://www.databricks.com/'),
    link('https://discord.com/invite/abc'),
    link('https://mlh.link/gemini'),
    link('https://www.bloomberg.com/'),
    link('https://hello.fullsail.edu/brand-1'),
  ];

  it.each([
    ['Knight Hacks IX', 'https://2026.knighthacks.org/', '2026.knighthacks.org'],
    ['Hacklanta', 'https://hacklanta.dev', 'hacklanta.dev'],
    ['PalmettoHacks 2026', 'https://palmettohacks.com/', 'palmettohacks.com'],
    ['HackNC 2026', 'https://hacknc.com/', 'hacknc.com'],
  ])('finds the site for %s among sponsors', (name, url, host) => {
    expect(findOfficialSite([...sponsors, link(url)], name, 'x.devpost.com')).toBe(host);
  });

  it('returns null when only sponsors are linked', () => {
    expect(findOfficialSite(sponsors, 'HackNC 2026', 'hacknc-2026.devpost.com')).toBeNull();
  });

  it('ignores short labels that could match by accident', () => {
    expect(findOfficialSite([link('https://hack.club/')], 'HackNC 2026', 'x.devpost.com')).toBeNull();
  });
});

describe('domainsInText', () => {
  it('finds website names written as text', () => {
    expect(domainsInText('## palmettohacks.com\nVisit https://www.example.org/faq or e.g. Node.js')).toEqual([
      { url: 'https://palmettohacks.com/', text: 'palmettohacks.com' },
      { url: 'https://www.example.org/', text: 'www.example.org' },
    ]);
  });
});

describe('scoreLink', () => {
  const roles: SiteRoles = { devpostHost: 'hacknc-2026.devpost.com', officialHost: 'hacknc.com' };
  const score = (url: string, text = '') => scoreLink(link(url, text), roles);

  it('follows only the useful Devpost pages, schedule first', () => {
    expect(score('https://hacknc-2026.devpost.com/details/dates')).toBeGreaterThan(score('https://hacknc-2026.devpost.com/rules'));
    expect(score('https://hacknc-2026.devpost.com/rules')).toBeGreaterThan(0);
    for (const path of ['/participants', '/project-gallery', '/forum_topics', '/calendar/google', '/submissions']) {
      expect(score(`https://hacknc-2026.devpost.com${path}`)).toBe(0);
    }
    expect(score('https://devpost.com/hackathons')).toBe(0);
  });

  it('prefers schedule pages on the official site and skips account pages', () => {
    expect(score('https://hacknc.com/schedule')).toBe(10);
    expect(score('https://www.hacknc.com/x', 'Event schedule')).toBe(10);
    expect(score('https://hacknc.com/resources')).toBeGreaterThan(score('https://hacknc.com/about'));
    expect(score('https://hacknc.com/dashboard')).toBe(0);
    expect(score('https://hacknc.com/register')).toBe(0);
    expect(score('https://hacknc.com/sponsors')).toBe(0);
  });

  it('skips files such as PDFs and calendar invites, whatever the link says', () => {
    expect(score('https://hacknc.com/schedule.pdf', 'Schedule')).toBe(0);
    expect(score('https://hacknc.com/schedule.ics', 'Add to calendar')).toBe(0);
    expect(score('https://hacknc.com/hacker-guide.PDF')).toBe(0);
    expect(score('https://hacknc.notion.site/guide.pdf', 'Hacker Guide')).toBe(0);
  });

  it('follows hacker guides on Notion or Google Docs, but not other external sites', () => {
    expect(score('https://hacknc.notion.site/abc', 'Hacker Guide')).toBeGreaterThan(0);
    expect(score('https://hacknc.notion.site/abc', 'Photos')).toBe(0);
    expect(score('https://www.databricks.com/schedule')).toBe(0);
  });
});

describe('isScheduleLike', () => {
  it('spots schedule and dates pages', () => {
    expect(isScheduleLike('https://hacknc.com/schedule')).toBe(true);
    expect(isScheduleLike('https://x.devpost.com/details/dates')).toBe(true);
    expect(isScheduleLike('https://x.com/info', 'Agenda')).toBe(true);
    expect(isScheduleLike('https://x.com/about')).toBe(false);
  });
});
