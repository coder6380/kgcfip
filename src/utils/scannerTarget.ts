import { normalizeIpv4Cidr } from './ipRange.ts';

export type ScannerIpSource = 'cf' | 'cm' | 'third' | 'custom';
export type SelectedPort = number | 'random';

export type ParsedThirdPartySource =
    | { kind: 'url'; url: string }
    | { kind: 'target'; ip: string; port: number }
    | { kind: 'invalid'; source: string };

export function parseThirdPartySource(source: string): ParsedThirdPartySource {
    const value = source.replace(/^\uFEFF/, '').trim();

    if (/^https?:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            if (url.hostname) return { kind: 'url', url: value };
        } catch {
            // Invalid URL input is reported in the source list.
        }
        return { kind: 'invalid', source: value };
    }

    const target = value.split('#', 1)[0].trim();
    const match = target.match(/^((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/);
    if (!match) return { kind: 'invalid', source: value };

    const cidr = normalizeIpv4Cidr(match[1]);
    const port = Number(match[2]);
    if (!cidr || !Number.isInteger(port) || port < 1 || port > 65535) {
        return { kind: 'invalid', source: value };
    }

    return { kind: 'target', ip: cidr.slice(0, -3), port };
}

function replaceTargetPort(target: string, port: number): string {
    const lastColonIndex = target.lastIndexOf(':');
    const closeBracketIndex = target.lastIndexOf(']');
    let host = target;

    if (lastColonIndex > closeBracketIndex) {
        const currentPort = Number.parseInt(target.substring(lastColonIndex + 1), 10);
        if (!Number.isNaN(currentPort)) host = target.substring(0, lastColonIndex);
    }

    if (host.includes(':') && !(host.startsWith('[') && host.endsWith(']'))) {
        host = `[${host}]`;
    }
    return `${host}:${port}`;
}

export function assignScanPort(
    target: string,
    source: ScannerIpSource,
    selectedPort: SelectedPort,
    randomPort: number,
): string {
    if (source === 'third') return target;
    return replaceTargetPort(target, selectedPort === 'random' ? randomPort : selectedPort);
}
