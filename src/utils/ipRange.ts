const parseIpv4 = (value: string): number[] | null => {
    const parts = value.split('.');
    if (parts.length !== 4) return null;

    const octets = parts.map(part => {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        return octet <= 255 ? octet : null;
    });

    return octets.every((octet): octet is number => octet !== null) ? octets : null;
};

const formatIpv4 = (octets: number[]) => octets.join('.');

export function normalizeIpv4Cidr(value: string): string | null {
    const trimmed = value.trim();
    const [address, prefixText, ...extra] = trimmed.split('/');
    if (extra.length > 0) return null;

    const octets = parseIpv4(address);
    if (!octets) return null;
    if (prefixText === undefined) return `${formatIpv4(octets)}/32`;
    if (!/^\d{1,2}$/.test(prefixText)) return null;

    const prefix = Number(prefixText);
    if (prefix < 0 || prefix > 32) return null;

    const ip = (((octets[0] << 24) >>> 0)
        + (octets[1] << 16)
        + (octets[2] << 8)
        + octets[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ip & mask) >>> 0;
    const networkOctets = [
        (network >>> 24) & 0xff,
        (network >>> 16) & 0xff,
        (network >>> 8) & 0xff,
        network & 0xff,
    ];

    return `${formatIpv4(networkOctets)}/${prefix}`;
}

export function parseIpv4CidrList(text: string) {
    const entries = text
        .split(/\r?\n/)
        .flatMap(line => line.split('#', 1)[0].split(/[\s,;]+/).filter(Boolean));
    const normalizedEntries = entries.map(entry => normalizeIpv4Cidr(entry));
    const cidrs = [...new Set(normalizedEntries.filter((cidr): cidr is string => cidr !== null))];

    return {
        cidrs,
        invalidEntries: entries.filter((_, index) => normalizedEntries[index] === null),
        duplicateCount: normalizedEntries.filter((cidr): cidr is string => cidr !== null).length - cidrs.length,
    };
}
