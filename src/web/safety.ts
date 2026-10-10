import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {}

function isPrivateIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** True for any address that isn't on the public internet (loopback, private, link-local, ...). */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version !== 6) return true;

  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped addresses, in dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1) form
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateIPv4(dotted[1]!);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
  return /^(f[cd]|fe[89ab]|ff)/.test(lower);
}

type Lookup = (hostname: string) => Promise<string[]>;

const defaultLookup: Lookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

/**
 * Throw unless `url` is an http(s) URL on a default port whose host resolves only
 * to public addresses. Stops the crawler from being pointed at internal services.
 */
export async function assertPublicUrl(url: string | URL, resolve: Lookup = defaultLookup): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`Only http and https links can be read (got ${parsed.protocol}).`);
  }
  if (parsed.port !== '') {
    throw new UnsafeUrlError('Links with a custom port are not allowed.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new UnsafeUrlError('Local addresses are not allowed.');
  }
  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  } catch {
    throw new Error(`Couldn't find a website at ${hostname}. Check the link for typos.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError(`${hostname} points to a private network address.`);
  }
  return parsed;
}
