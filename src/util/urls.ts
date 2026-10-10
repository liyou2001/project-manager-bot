/** Returns a normalized http(s) URL string, or null if invalid. Adds https:// if missing. */
export function parseHttpUrl(raw: string): string | null {
  const value = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Returns a normalized github.com URL with at least an owner, or null if invalid. */
export function parseGithubUrl(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  const { hostname, pathname } = new URL(url);
  if (hostname !== 'github.com' && hostname !== 'www.github.com') return null;
  // Require at least an owner: github.com/owner or github.com/owner/repo
  if (pathname.split('/').filter(Boolean).length === 0) return null;
  return url;
}
