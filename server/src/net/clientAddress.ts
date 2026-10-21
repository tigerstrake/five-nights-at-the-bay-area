import { BlockList, isIP, SocketAddress } from 'node:net';

/** Canonical bucket keys also collapse IPv4-mapped IPv6 addresses. */
function canonicalIp(value: string): string | null {
  const family = isIP(value);
  if (!family) return null;
  const address = SocketAddress.parse(family === 6 ? `[${value}]:0` : `${value}:0`)?.address;
  return address?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1') ?? null;
}

/** Explicit IP/CIDR allowlist. Never treat a boolean or a hop count as permission to trust every peer. */
export function clientAddressResolver(trustProxy = process.env.TRUST_PROXY): (peer: string, forwarded?: string | string[]) => string {
  const trusted = new BlockList();
  const setting = trustProxy?.trim();
  const entries = !setting || setting.toLowerCase() === 'false' ? [] : setting.split(',');
  for (const entry of entries) {
    const [ip, prefix, ...extra] = entry.trim().split('/');
    const family = isIP(ip!);
    if (!family || extra.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128))))
      throw new Error(`Invalid TRUST_PROXY entry: ${entry}. Use proxy IP addresses or CIDRs.`);
    if (prefix === undefined) trusted.addAddress(ip!, family === 4 ? 'ipv4' : 'ipv6');
    else trusted.addSubnet(ip!, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  }
  const isTrusted = (ip: string) => trusted.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
  return (peer, forwarded) => {
    const direct = canonicalIp(peer) ?? peer;
    if (!isIP(direct) || !isTrusted(direct) || forwarded === undefined) return direct;
    const chain = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',').map(x => canonicalIp(x.trim()));
    if (chain.some(ip => ip === null)) return direct;
    let address = direct;
    // Stop at the first untrusted hop. Entries further left may have been supplied by that client.
    for (let i = chain.length - 1; i >= 0 && isTrusted(address); i--) address = chain[i]!;
    return address;
  };
}
