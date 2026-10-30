export interface IpTextLineInput {
    ip: string;
    port: number;
    alias: string;
    latency: number;
    downloadSpeedMBps?: number | null;
}

export function formatIpTextLine(item: IpTextLineInput): string {
    const speedSuffix = typeof item.downloadSpeedMBps === 'number'
        && Number.isFinite(item.downloadSpeedMBps)
        && item.downloadSpeedMBps >= 0
        ? `|${item.downloadSpeedMBps.toFixed(2)}MB/s`
        : '';

    return `${item.ip}:${item.port}#${item.alias}|${item.latency}ms${speedSuffix}`;
}
