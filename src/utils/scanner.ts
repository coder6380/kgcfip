// e:\CODE\kgcfip\src\utils\scanner.ts
/**
 * 扫描结果的数据结构
 */
export interface ScanResult {
    ip: string;
    port: number;
    isAvailable: boolean;
    latency: number;
    colo?: string; // Cloudflare 数据中心代码
    domain?: boolean; // 是否为域名源（保存域名而非解析出的IP）

    // 以下为本地 Agent 测速的扩展字段，浏览器端测速不会产生这些值。
    // 全部可选，保证与原有「保存为场景 / 导出 / 筛选」等逻辑完全兼容。
    tcpMs?: number;        // TCP 三次握手耗时
    tlsMs?: number;        // 累计到 TLS 握手完成的耗时
    error?: string;        // 不可用时的原因
    downloadSpeedMBps?: number | null; // 浏览器下载速度 (MB/s)
    downloadSpeedError?: string | null; // 浏览器下载测速失败原因
}

/**
 * 判断一个 host 是否为域名（非 IPv4 / IPv6）
 */
export function isDomainName(host: string): boolean {
    // IPv6（含方括号或包含多个冒号）一律视为IP
    if (host.includes(':')) return false;
    // IPv4
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
    // 形如 example.com
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(host);
}

/**
 * 通过阿里云公共 DNS (DoH) 将域名解析为 IP（优先 A 记录，其次 AAAA）
 * 使用 dns.alidns.com，在大陆网络环境下可正常访问
 */
export async function resolveDomainToIp(host: string, signal?: AbortSignal): Promise<string | null> {
    const query = (type: 'A' | 'AAAA') =>
        fetch(`https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=${type}`, { signal });

    try {
        const resA = await query('A');
        if (resA.ok) {
            const json = await resA.json() as { Status?: number; Answer?: { type: number; data: string }[] };
            if (json.Status === 0) {
                const a = json.Answer?.find(r => r.type === 1);
                if (a) return a.data;
            }
        }
        const resAAAA = await query('AAAA');
        if (resAAAA.ok) {
            const json = await resAAAA.json() as { Status?: number; Answer?: { type: number; data: string }[] };
            if (json.Status === 0) {
                const aaaa = json.Answer?.find(r => r.type === 28);
                if (aaaa) return aaaa.data;
            }
        }
    } catch {
        // 解析失败
    }
    return null;
}

// =================================================================
// 1. 地区分组逻辑 (源于参考代码)
// =================================================================

export { coloMap, getColoName } from './colo';

// =================================================================
// 2. IP 测速逻辑 (源于参考代码)
// =================================================================

/**
 * 将 IPv4 地址转换为十六进制，用于 nip.cmliussss.hidns.vip 技巧
 */
function ipToHex(ip: string): string | null {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipv4Regex.test(ip)) {
        return null;
    }
    return ip.split('.').map(part => parseInt(part, 10).toString(16).padStart(2, '0')).join('');
}

/**
 * 判断是否为 IPv6 地址
 */
function isIPv6(ip: string): boolean {
    return ip.includes(':');
}

/**
 * 在浏览器中通过 Cloudflare 下载端点测量单个 IPv4 的实际下载速度。
 * 只统计响应流收到的字节；达到取样时长后中止请求。
 */
export async function measureIpDownloadSpeed(
    ip: string,
    port: number,
    sampleDurationMs: number,
    signal?: AbortSignal,
): Promise<number> {
    let testIp = ip;
    if (isDomainName(testIp)) {
        const resolved = await resolveDomainToIp(testIp);
        if (!resolved) throw new Error('域名解析失败');
        testIp = resolved;
    }

    if (isIPv6(testIp)) throw new Error('IPv6 暂不支持下载测速');

    const hexIp = ipToHex(testIp);
    if (!hexIp) throw new Error('无效的 IPv4 地址');
    if (!Number.isFinite(sampleDurationMs) || sampleDurationMs <= 0) {
        throw new Error('测速时长无效');
    }
    if (signal?.aborted) throw new DOMException('测速已停止', 'AbortError');

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });

    let requestTimedOut = false;
    let sampleEndedAt: number | null = null;
    let sampleStartAt: number | null = null;
    let sampleTimer: ReturnType<typeof setTimeout> | undefined;
    const requestTimer = setTimeout(() => {
        requestTimedOut = true;
        controller.abort();
    }, 15000);

    let receivedBytes = 0;
    const url = `https://${hexIp}.ns.psb.kdns.fr:${port}/__down?bytes=100000000&_t=${Date.now()}`;

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.body) throw new Error('浏览器无法读取下载数据');

        const reader = response.body.getReader();
        try {
            while (true) {
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await reader.read();
                } catch (error) {
                    if (sampleEndedAt !== null && !signal?.aborted) break;
                    throw error;
                }

                if (chunk.done) break;
                if (!chunk.value.byteLength) continue;

                if (sampleStartAt === null) {
                    sampleStartAt = performance.now();
                    sampleTimer = setTimeout(() => {
                        sampleEndedAt = performance.now();
                        controller.abort();
                    }, sampleDurationMs);
                }
                receivedBytes += chunk.value.byteLength;
            }
        } finally {
            reader.releaseLock();
        }
    } catch (error) {
        if (requestTimedOut) throw new Error('连接超时');
        throw error;
    } finally {
        clearTimeout(requestTimer);
        if (sampleTimer) clearTimeout(sampleTimer);
        signal?.removeEventListener('abort', abortFromCaller);
    }

    if (signal?.aborted) throw new DOMException('测速已停止', 'AbortError');
    if (receivedBytes === 0 || sampleStartAt === null) throw new Error('未收到下载数据');

    const endedAt = sampleEndedAt ?? performance.now();
    const elapsedSeconds = (endedAt - sampleStartAt) / 1000;
    if (elapsedSeconds <= 0) throw new Error('测速时间过短');
    return receivedBytes / 1_000_000 / elapsedSeconds;
}

/** Maximum timeout for browser latency requests. */
export const BROWSER_LATENCY_TIMEOUT_MS = 3000;

export interface IpLatencyMeasurement {
    latency: number;
    colo: string;
    error?: string;
}

/** Measure one HTTPS request to the target and stop timing when response headers arrive. */
export async function measureIpLatency(
    ip: string,
    port: number,
    timeout = BROWSER_LATENCY_TIMEOUT_MS,
    signal?: AbortSignal,
): Promise<IpLatencyMeasurement> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort();

    try {
        let testIp = ip;
        if (isDomainName(testIp)) {
            const resolveTimeoutId = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, timeout);
            let resolved: string | null;
            try {
                resolved = await resolveDomainToIp(testIp, controller.signal);
            } finally {
                clearTimeout(resolveTimeoutId);
            }
            if (controller.signal.aborted) {
                if (signal?.aborted) throw new DOMException('测速已停止', 'AbortError');
                throw new Error('连接超时');
            }
            if (!resolved) throw new Error('域名解析失败');
            testIp = resolved;
        }

        if (isIPv6(testIp)) throw new Error('浏览器模式暂不支持 IPv6');

        const hexIp = ipToHex(testIp);
        if (!hexIp) throw new Error('无效的 IPv4 地址');

        const testUrl = `https://${hexIp}.ns.psb.kdns.fr:${port}/ip.json?_t=${Date.now()}`;
        const fetchWithTimeout = async (method: 'OPTIONS' | 'GET', requestTimeout: number) => {
            const requestController = new AbortController();
            const abortRequest = () => requestController.abort();
            controller.signal.addEventListener('abort', abortRequest, { once: true });
            if (controller.signal.aborted) requestController.abort();
            let requestTimedOut = false;
            const requestTimeoutId = setTimeout(() => {
                requestTimedOut = true;
                timedOut = true;
                requestController.abort();
            }, requestTimeout);

            try {
                return await fetch(testUrl, {
                    method,
                    signal: requestController.signal,
                    cache: 'no-store',
                });
            } catch (error) {
                if (requestTimedOut) throw new Error('连接超时');
                throw error;
            } finally {
                clearTimeout(requestTimeoutId);
                controller.signal.removeEventListener('abort', abortRequest);
            }
        };

        // Warm the same endpoint before timing the GET request.
        let lastOptionsError: unknown;
        let optionsSucceeded = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (controller.signal.aborted) throw new DOMException('测速已停止', 'AbortError');
            try {
                const optionsResponse = await fetchWithTimeout('OPTIONS', timeout * 2);
                if (optionsResponse.ok) {
                    optionsSucceeded = true;
                    break;
                }
                lastOptionsError = new Error(`OPTIONS HTTP ${optionsResponse.status}`);
            } catch (error) {
                if (signal?.aborted) throw error;
                lastOptionsError = error;
            }
        }
        if (!optionsSucceeded) throw lastOptionsError || new Error('OPTIONS 不可用');

        if (controller.signal.aborted) throw new DOMException('测速已停止', 'AbortError');
        const requestStart = performance.now();
        const response = await fetchWithTimeout('GET', timeout);

        if (response.status !== 200) {
            const error = `HTTP ${response.status}`;
            return { latency: -1, colo: error, error };
        }

        let data: { colo?: string } = {};
        try {
            data = await response.json() as { colo?: string };
        } catch {
            // The response body is small metadata; keep the measured HTTP response if it is malformed.
        }
        const latency = Math.max(1, Math.round(performance.now() - requestStart));

        return { latency, colo: data?.colo || '-' };

    } catch (error: any) {
        if (signal?.aborted) return { latency: -1, colo: 'Stopped', error: '测速已停止' };
        const message = timedOut ? '连接超时' : error instanceof Error ? error.message : '测速失败';
        return { latency: -1, colo: message, error: message };
    } finally {
        signal?.removeEventListener('abort', abortFromCaller);
    }
}

/**
 * 浏览器端测速可用性自检：探测测速域名能否被解析。
 * 注意该域名是通配符解析，裸域 ns.psb.kdns.fr 本身可能无记录，
 * 因此按实际测速路径，用十六进制编码的样例 IP 子域名去探测
 * （与 measureIpLatency 拼接的 <hexIp>.ns.psb.kdns.fr 完全一致）。
 *
 * 为避免单次 DNS 偶发失败造成误判，默认随机取样例 IP 并行探测 10 次，
 * 只要有一次解析成功即认为当前环境可进行网页测速；
 * 全部失败才判定不可用，应切换到「本地 Agent 测速」兜底。
 *
 * @param sampleIps 页面同步到的 Cloudflare IP 段中随机生成的样例 IP 列表
 * @param attempts  探测次数，默认 10
 */
const PROBE_FALLBACK_IPS = ['104.16.0.1', '172.67.0.1', '162.159.0.1', '162.158.0.1', '188.114.96.1', '108.162.192.1'];

export async function probeBrowserAvailable(sampleIps?: string[], attempts = 10): Promise<boolean> {
    const tasks = Array.from({ length: attempts }, async (_, i) => {
        const ip = sampleIps?.[i] ?? PROBE_FALLBACK_IPS[Math.floor(Math.random() * PROBE_FALLBACK_IPS.length)];
        const probeHex = ipToHex(ip);
        if (!probeHex) return false;
        const resolved = await resolveDomainToIp(`${probeHex}.ns.psb.kdns.fr`);
        return !!resolved;
    });
    const results = await Promise.all(tasks);
    return results.some(Boolean);
}

// =================================================================
// 3. 批量扫描器和 IP 生成器
// =================================================================

export class BatchScanner {
    private ips: string[];
    private port: number;
    private threads: number;
    private latencyLimit: number;
    private onProgress: (result: ScanResult) => void;
    private onComplete: (results: ScanResult[]) => void;
    private abortController: AbortController;
    private targetAvailableCount?: number;
    // 解析出的测速IP映射：key 为 "host:port"，value 为实际用于测速的IP（域名解析后）
    private resolvedMap?: Record<string, string | null>;
    private paused = false;
    private resumeResolvers: Array<() => void> = [];

    constructor(
        ips: string[],
        port: number,
        threads: number,
        latencyLimit: number,
        onProgress: (result: ScanResult) => void,
        onComplete: (results: ScanResult[]) => void,
        resolvedMap?: Record<string, string | null>,
        targetAvailableCount?: number,
    ) {
        this.ips = ips;
        this.port = port;
        this.threads = Math.min(ips.length, threads);
        this.latencyLimit = latencyLimit;
        this.onProgress = onProgress;
        this.onComplete = onComplete;
        this.abortController = new AbortController();
        this.resolvedMap = resolvedMap;
        this.targetAvailableCount = targetAvailableCount;
    }

    public stop() {
        this.abortController.abort();
    }

    public pause() {
        this.paused = true;
    }

    public resume() {
        this.paused = false;
        const resolvers = this.resumeResolvers;
        this.resumeResolvers = [];
        resolvers.forEach((r) => r());
    }

    /**
     * 解析 "host:port" / "[IPv6]:port" / "host" 字符串
     */
    private parseTarget(rawTarget: string): { host: string; port: number } {
        let host = rawTarget;
        let port = this.port;

        const lastColonIndex = rawTarget.lastIndexOf(':');
        const closeBracketIndex = rawTarget.lastIndexOf(']');

        if (lastColonIndex > -1 && lastColonIndex > closeBracketIndex) {
            const portPart = rawTarget.substring(lastColonIndex + 1);
            const parsedPort = parseInt(portPart, 10);
            if (!isNaN(parsedPort)) {
                port = parsedPort;
                host = rawTarget.substring(0, lastColonIndex);
                if (host.startsWith('[') && host.endsWith(']')) {
                    host = host.substring(1, host.length - 1);
                }
            }
        }

        if (port === 0) port = 443;
        return { host, port };
    }

    public async run() {
        const queue = [...this.ips];
        const finalResults: ScanResult[] = [];
        let availableCount = 0;
        const requestTimeout = Math.max(1, Math.min(this.latencyLimit, BROWSER_LATENCY_TIMEOUT_MS));

        const worker = async () => {
            while (queue.length > 0) {
                if (this.abortController.signal.aborted) break;
                if (this.paused) {
                    await new Promise<void>((resolve) => { this.resumeResolvers.push(resolve); });
                    if (this.abortController.signal.aborted) break;
                    continue;
                }

                const rawTarget = queue.shift();
                if (!rawTarget) continue;

                const { host, port } = this.parseTarget(rawTarget);

                // 域名源：先用阿里云 DoH 解析出 IP 再用 IP 测速，保存时仍保存域名
                let testHost = host;
                let isDomain = false;
                if (isDomainName(host)) {
                    isDomain = true;
                    const resolved = this.resolvedMap
                        ? (this.resolvedMap[rawTarget] ?? null)
                        : await resolveDomainToIp(host, this.abortController.signal);
                    if (this.abortController.signal.aborted) break;
                    if (!resolved) {
                        const fail: ScanResult = {
                            ip: host,
                            port,
                            isAvailable: false,
                            latency: -1,
                            colo: 'ResolveFail',
                            domain: true,
                        };
                        finalResults.push(fail);
                        this.onProgress(fail);
                        continue;
                    }
                    testHost = resolved;
                }

                const { latency, colo, error } = await measureIpLatency(
                    testHost,
                    port,
                    requestTimeout,
                    this.abortController.signal,
                );
                if (this.abortController.signal.aborted) break;

                const result: ScanResult = {
                    ip: isDomain ? host : testHost, // 域名源保存域名，IP源保存IP
                    port,
                    isAvailable: latency > 0 && latency <= this.latencyLimit,
                    latency,
                    colo,
                    error,
                    domain: isDomain || undefined,
                };

                finalResults.push(result);
                this.onProgress(result);
                if (result.isAvailable) {
                    availableCount++;
                    if (this.targetAvailableCount !== undefined && availableCount >= this.targetAvailableCount) {
                        this.abortController.abort();
                    }
                }
            }
        };

        const workers = Array(this.threads).fill(null).map(() => worker());
        await Promise.all(workers);

        // 按延迟对成功的结果进行排序
        const sortedResults = finalResults
            .filter(r => r.isAvailable)
            .sort((a, b) => a.latency - b.latency);

        this.onComplete(sortedResults);
    }
}

/**
 * 从 CIDR 块生成随机 IP
 */
function generateRandomIPFromCIDR(cidr: string): string {
    const [baseIP, prefixLength] = cidr.split('/');
    const prefix = parseInt(prefixLength, 10);
    
    if (prefix === 32) return baseIP;

    const hostBits = 32 - prefix;
    const ipParts = baseIP.split('.').map(p => parseInt(p, 10));
    
    const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
    const randomOffset = Math.floor(Math.random() * (2 ** hostBits));
    const mask = (0xFFFFFFFF << hostBits) >>> 0;
    const randomIPInt = ((ipInt & mask) >>> 0) + randomOffset;
    
    return [
        (randomIPInt >>> 24) & 0xFF,
        (randomIPInt >>> 16) & 0xFF,
        (randomIPInt >>> 8) & 0xFF,
        randomIPInt & 0xFF
    ].join('.');
}

/**
 * 从 CIDR 列表生成指定数量的随机 IP
 */
export function generateRandomIps(
    cidrs: string[],
    count: number,
    excludedIps: ReadonlySet<string> = new Set(),
): string[] {
    if (!cidrs || cidrs.length === 0 || count <= 0) {
        return [];
    }
    const randomIps = new Set<string>();
    const maxAttempts = count * 10;
    let attempts = 0;

    while (randomIps.size < count && attempts < maxAttempts) {
        const randomCidr = cidrs[Math.floor(Math.random() * cidrs.length)];
        const randomIp = generateRandomIPFromCIDR(randomCidr);
        if (!excludedIps.has(randomIp)) randomIps.add(randomIp);
        attempts++;
    }
    return Array.from(randomIps);
}

// =================================================================
// 4. 其他工具函数
// =================================================================

/**
 * 根据延迟值获取颜色样式
 */
export const getLatencyColor = (latency: number): string => {
    if (latency < 0) return 'text-gray-400 dark:text-gray-500';
    if (latency < 200) return 'text-green-500 dark:text-green-400';
    if (latency < 500) return 'text-yellow-500 dark:text-yellow-400';
    return 'text-red-500 dark:text-red-400';
};


/**
 * 备用的 Cloudflare CIDR 列表。
 * 此列表已废弃，CIDR数据现在应完全从API/KV中获取。
 * 保留为空数组以确保类型兼容和旧逻辑的平稳过渡。
 */
export const CF_CIDR_LIST: string[] = [];
