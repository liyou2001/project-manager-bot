import { describe, expect, it } from 'vitest';
import { parseGithubUrl, parseHttpUrl } from './urls.js';

describe('parseHttpUrl', () => {
  it('adds https:// when missing', () => {
    expect(parseHttpUrl('example.com')).toBe('https://example.com/');
  });
  it('keeps http and https URLs', () => {
    expect(parseHttpUrl(' https://hack.devpost.com/details/dates ')).toBe('https://hack.devpost.com/details/dates');
    expect(parseHttpUrl('http://example.com')).toBe('http://example.com/');
  });
  it('rejects non-web schemes, bare words and junk', () => {
    expect(parseHttpUrl('ftp://example.com')).toBeNull();
    expect(parseHttpUrl('localhost')).toBeNull();
    expect(parseHttpUrl('not a url')).toBeNull();
  });
});

describe('parseGithubUrl', () => {
  it('accepts owner and owner/repo links', () => {
    expect(parseGithubUrl('github.com/leo')).toBe('https://github.com/leo');
    expect(parseGithubUrl('https://github.com/leo/repo')).toBe('https://github.com/leo/repo');
  });
  it('rejects other hosts and bare github.com', () => {
    expect(parseGithubUrl('https://gitlab.com/leo/repo')).toBeNull();
    expect(parseGithubUrl('https://github.com/')).toBeNull();
  });
});
