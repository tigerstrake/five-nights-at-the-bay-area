import { describe, expect, it } from 'vitest';
import { clientAddressResolver } from './clientAddress';

describe('trusted proxy addresses', () => {
  it('walks trusted hops from right to left and stops before spoofed client entries', () => {
    const resolve = clientAddressResolver('10.42.0.0/16,2001:db8:abcd::/48');
    expect(resolve('10.42.0.7', '192.0.2.99, 198.51.100.1, 10.42.0.8')).toBe('198.51.100.1');
    expect(resolve('2001:db8:abcd::1', ['198.51.100.1', '10.42.0.8'])).toBe('198.51.100.1');
    expect(resolve('10.99.0.1', '198.51.100.1')).toBe('10.99.0.1');
  });

  it('defaults to trusting none and falls back to the peer on missing or malformed headers', () => {
    const resolve = clientAddressResolver('10.42.0.7');
    for (const forwarded of [undefined, '', 'unknown', '198.51.100.1, bad']) expect(resolve('10.42.0.7', forwarded)).toBe('10.42.0.7');
    for (const setting of ['', ' ', 'false']) expect(clientAddressResolver(setting)('10.42.0.7', '198.51.100.1')).toBe('10.42.0.7');
  });

  it('canonicalizes equivalent IPv6 and IPv4-mapped addresses to the same budget key', () => {
    const resolve = clientAddressResolver('::ffff:10.42.0.7');
    expect(resolve('::ffff:a2a:7', '::ffff:c633:6401')).toBe('198.51.100.1');
    expect(resolve('2001:0db8:0000::1')).toBe('2001:db8::1');
    expect(resolve('::ffff:198.51.100.1')).toBe('198.51.100.1');
  });

  it.each(['true', '1', 'proxy.local', '10.0.0.1/33', '::1/129', '10.0.0.1/-1', '10.0.0.1/8/1'])('rejects invalid trust configuration %s', setting => {
    expect(() => clientAddressResolver(setting)).toThrow('Invalid TRUST_PROXY');
  });
});
