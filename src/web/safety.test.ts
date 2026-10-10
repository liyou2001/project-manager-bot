import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPrivateAddress, UnsafeUrlError } from './safety.js';

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])(
    'rejects %s',
    (address) => expect(isPrivateAddress(address)).toBe(true),
  );
  it.each(['8.8.8.8', '172.32.0.1', '104.18.2.3', '2606:4700::1111'])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  const resolvesTo = (...addresses: string[]) => async () => addresses;

  it('allows public http(s) URLs', async () => {
    await expect(assertPublicUrl('https://hack.devpost.com/rules', resolvesTo('104.18.2.3'))).resolves.toBeInstanceOf(URL);
  });
  it('rejects hosts that resolve to a private address', async () => {
    await expect(assertPublicUrl('https://evil.example/', resolvesTo('104.18.2.3', '10.0.0.5'))).rejects.toThrow(UnsafeUrlError);
  });
  it('rejects private IP literals, localhost, other schemes and custom ports', async () => {
    const never = async () => {
      throw new Error('should not look up');
    };
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data', never)).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl('http://[::1]/', never)).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl('http://localhost/', never)).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl('file:///etc/passwd', never)).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl('https://example.com:8443/', never)).rejects.toThrow(UnsafeUrlError);
  });
});
