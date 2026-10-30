import { useState, useRef, useEffect, useCallback } from 'react';
import { CloudflareIps, getThirdPartySourceList, getThirdPartySourceIps } from '../api';

type SourceRowStatus = 'pending' | 'loading' | 'done' | 'error';
interface SourceRow {
    url: string;
    status: SourceRowStatus;
    ipCount?: number;
    domainCount?: number;
    error?: string;
    ips?: { ip: string; port: number }[];
}
import {
    generateRandomIps,
    BatchScanner,
    BROWSER_LATENCY_TIMEOUT_MS,
    ScanResult,
    CF_CIDR_LIST,
    isDomainName,
    resolveDomainToIp,
    probeBrowserAvailable,
} from '../utils/scanner';
import { coloCountryMap, coloMap, getColoText } from '../utils/colo';
import { isColoSelectable, isRegionCountrySelectable, isRegionQualifiedResult, matchesSelectedColo } from '../utils/regionFilter';
import { assignScanPort, parseThirdPartySource, type ScannerIpSource } from '../utils/scannerTarget';
import {
    probeLocalAgent, startAgentScan, fetchAgentProgress, stopAgentScan,
    DEFAULT_AGENT_PORT,
    type AgentResult, type AgentProbeResult,
} from '../utils/localAgent';
import { useToast } from './Toast';
import { Gauge, Play, StopCircle, Loader2, Pause, Square, Cpu, RefreshCw, AlertTriangle, CheckCircle2, ChevronDown, MapPin, Plus, Search } from 'lucide-react';
import { useConfirm } from './ConfirmDialog';

interface IpScannerConfigAndControlProps {
    cfIps: CloudflareIps | null;
    onScanComplete: (results: ScanResult[]) => void;
    onScanProgress: (results: ScanResult[]) => void;
}

const CLOUDFLARE_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
const RANDOM_CANDIDATES_PER_BATCH = 20;
const countryDisplayNames = (() => {
    const intlWithDisplayNames = Intl as typeof Intl & {
        DisplayNames?: new (locales: string[], options: { type: 'region' }) => { of: (code: string) => string | undefined };
    };
    return intlWithDisplayNames.DisplayNames
        ? new intlWithDisplayNames.DisplayNames(['zh-CN'], { type: 'region' })
        : null;
})();

const getCountryLabel = (countryCode: string) => countryCode === 'other'
    ? '其他'
    : countryDisplayNames?.of(countryCode.toUpperCase()) ?? countryCode.toUpperCase();

const REGION_GROUPS = (() => {
    const groups = new Map<string, string[]>();
    Object.keys(coloMap).forEach(colo => {
        const countryCode = coloCountryMap[colo] ?? 'other';
        if (!isRegionCountrySelectable(countryCode)) return;
        const group = groups.get(countryCode) ?? [];
        group.push(colo);
        groups.set(countryCode, group);
    });

    return Array.from(groups, ([countryCode, colos]) => ({
        countryCode,
        name: getCountryLabel(countryCode),
        colos: colos.sort(),
    })).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
})();

const getSourceUrlForExpansionRound = (sourceUrl: string, round: number) => {
    if (round <= 0) return sourceUrl;

    try {
        const url = new URL(sourceUrl);
        const currentLimit = Number(url.searchParams.get('limit'));
        if (!Number.isSafeInteger(currentLimit) || currentLimit < 1) return sourceUrl;

        const expandedLimit = Math.min(Number.MAX_SAFE_INTEGER, currentLimit * (2 ** round));
        if (expandedLimit <= currentLimit) return sourceUrl;
        url.searchParams.set('limit', String(expandedLimit));
        return url.toString();
    } catch {
        return sourceUrl;
    }
};

export function ScannerConfig({ cfIps, onScanComplete, onScanProgress }: IpScannerConfigAndControlProps) {
    const [count, setCount] = useState<string>('50');
    const [threads, setThreads] = useState<string>('16');
    const [latencyLimit, setLatencyLimit] = useState<string>('1000');
    const [countError, setCountError] = useState<string>('');
    const [threadsError, setThreadsError] = useState<string>('');
    const [latencyLimitError, setLatencyLimitError] = useState<string>('');
    const [selectedPort, setSelectedPort] = useState<number | 'random'>('random');
    const [ipSource, setIpSource] = useState<ScannerIpSource>('cf');
    const [selectedColos, setSelectedColos] = useState<Set<string>>(new Set());
    const [activeScanColos, setActiveScanColos] = useState<Set<string>>(new Set());
    const [isRegionPickerOpen, setIsRegionPickerOpen] = useState(false);
    const [regionSearch, setRegionSearch] = useState('');
    const [customColo, setCustomColo] = useState('');
    const [isScanning, setIsScanning] = useState(false);
    const [progress, setProgress] = useState(0);
    const [total, setTotal] = useState(0);
    const [successCount, setSuccessCount] = useState(0);
    const [regionMismatchCount, setRegionMismatchCount] = useState(0);
    const [failCount, setFailCount] = useState(0);
    const [isStopping, setIsStopping] = useState(false);
    const [uniqueIpCount, setUniqueIpCount] = useState(0);
    const [grossIpCount, setGrossIpCount] = useState(0);
    const [ipCount, setIpCount] = useState(0);
    const [domainCount, setDomainCount] = useState(0);
    const [isPreparing, setIsPreparing] = useState(false);
    const [prepareDone, setPrepareDone] = useState(0);
    const [prepareTotal, setPrepareTotal] = useState(0);
    const [sourceRows, setSourceRows] = useState<SourceRow[]>([]);
    const [startTime, setStartTime] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());
    const [isPaused, setIsPaused] = useState(false);
    const [pausedAt, setPausedAt] = useState<number | null>(null);
    const regionPickerRef = useRef<HTMLDivElement>(null);

    const scannerRef = useRef<BatchScanner | null>(null);
    const cancelPreparingRef = useRef(false);
    const scanStopRequestedRef = useRef(false);
    const { showToast } = useToast();
    const { confirm } = useConfirm();

    // ---------- 测速方式切换 ----------
    const [activeTab, setActiveTab] = useState<'browser' | 'local'>('browser');

    // ---------- 本地 Agent ----------
    const [agentProbe, setAgentProbe] = useState<AgentProbeResult | null>(null);
    const [agentChecking, setAgentChecking] = useState(false);
    // 本地服务端口：保存在浏览器本地，下次自动带出
    const [agentPort, setAgentPort] = useState<string>(
        () => localStorage.getItem('LOCAL_AGENT_PORT') || String(DEFAULT_AGENT_PORT)
    );
    const agentStopRef = useRef(false);
    const agentModeRef = useRef(false);
    // 当前这一轮是否走本地 Agent（需要触发重渲染以隐藏不支持的暂停按钮）
    const [agentActive, setAgentActive] = useState(false);

    /** 探测本机 127.0.0.1 上的 Agent 服务 */
    const checkAgent = useCallback(async (port: number, silent = false) => {
        setAgentChecking(true);
        try {
            const r = await probeLocalAgent(port);
            setAgentProbe(r);
            if (r.online && !silent) showToast('已连接到本地 Agent 服务', 'success');
        } catch {
            setAgentProbe({ online: false, reason: 'offline' });
        } finally {
            setAgentChecking(false);
        }
    }, [showToast]);

    // 启动 & 端口变更：探测本地服务
    useEffect(() => {
        void checkAgent(Number(agentPort) || DEFAULT_AGENT_PORT, true);
    }, [checkAgent, agentPort]);

    // ---------- 浏览器端测速可用性自检 ----------
    // 浏览器无法为任意 IP 设置 TLS SNI，只能依赖会失效的第三方泛解析域名；
    // 此处用一次真实浏览器测速来验证当前环境是否可用，失败则提示切换到本地测速。
    const [browserHealthy, setBrowserHealthy] = useState<boolean | null>(null);
    const [browserChecking, setBrowserChecking] = useState(false);

    const checkBrowser = useCallback(async () => {
        setBrowserChecking(true);
        setBrowserHealthy(null);
        try {
            // 从同步到的 Cloudflare IP 段中随机取样例 IP（10 个）用于自检，避免依赖写死地址
            const cidrs = ipSource === 'custom'
                ? cfIps?.custom_ipv4_cidrs || []
                : ipSource === 'cm'
                    ? cfIps?.cm_cidrs || []
                    : cfIps?.ipv4_cidrs || [];
            const sampleIps = cidrs.length > 0 ? generateRandomIps(cidrs, 10) : undefined;
            const ok = await probeBrowserAvailable(sampleIps);
            setBrowserHealthy(ok);
        } catch {
            setBrowserHealthy(false);
        } finally {
            setBrowserChecking(false);
        }
    }, [cfIps, ipSource]);

    // 进入「浏览器测速」Tab 时做一次自检
    useEffect(() => {
        if (activeTab === 'browser') void checkBrowser();
    }, [activeTab, checkBrowser]);

    useEffect(() => {
        if (!isRegionPickerOpen) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (regionPickerRef.current && !regionPickerRef.current.contains(event.target as Node)) {
                setIsRegionPickerOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsRegionPickerOpen(false);
        };
        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isRegionPickerOpen]);

    const normalizedRegionSearch = regionSearch.trim().toLocaleLowerCase();
    const visibleRegionGroups = REGION_GROUPS.map(group => {
        const groupMatches = `${group.name} ${group.countryCode}`.toLocaleLowerCase().includes(normalizedRegionSearch);
        const visibleColos = group.colos.filter(colo => groupMatches
            || `${colo} ${getColoText(colo)}`.toLocaleLowerCase().includes(normalizedRegionSearch));
        return { ...group, visibleColos };
    }).filter(group => group.visibleColos.length > 0);

    const selectedColoList = Array.from(selectedColos).sort();
    const selectedRegionLabel = selectedColos.size === 0
        ? '不限地区'
        : selectedColoList.length <= 3
            ? selectedColoList.map(colo => {
                const name = getColoText(colo);
                return name === colo ? colo : `${colo} ${name}`;
            }).join('、')
            : `${selectedColos.size} 个机房`;

    const toggleCountry = (colos: string[]) => {
        setSelectedColos(previous => {
            const next = new Set(previous);
            const shouldSelect = !colos.every(colo => next.has(colo));
            colos.forEach(colo => shouldSelect ? next.add(colo) : next.delete(colo));
            return next;
        });
    };

    const toggleColo = (colo: string) => {
        setSelectedColos(previous => {
            const next = new Set(previous);
            if (next.has(colo)) next.delete(colo);
            else next.add(colo);
            return next;
        });
    };

    const addCustomColo = () => {
        const colo = customColo.trim().toUpperCase();
        if (!/^[A-Z0-9]{3}$/.test(colo) || !isColoSelectable(colo)) return;
        setSelectedColos(previous => new Set([...previous, colo]));
        setCustomColo('');
    };

    const showLocationWarning = async () => {
        const result = await confirm('检测到您目前网络处于代理或VPN环境，请处于直连状态下再开始测试，否则结果没有意义！', {
            confirmText: '坚持测试',
            confirmButtonColor: 'bg-orange-500 hover:bg-orange-600 focus:ring-orange-500',
            cancelText: '取消测试',
            cancelButtonColor: 'bg-green-500 hover:bg-green-600 focus:ring-green-500',
        });
        return result;
    };

    const validateInputs = (): { countNum: number; threadsNum: number; latencyLimitNum: number } | null => {
        const countTrim = count.trim();
        const threadsTrim = threads.trim();
        const latencyLimitTrim = latencyLimit.trim();
        let hasError = false;
        if (!/^\d+$/.test(countTrim) || parseInt(countTrim, 10) < 1) {
            setCountError('请输入有效的正整数');
            hasError = true;
        } else {
            setCountError('');
        }
        if (!/^\d+$/.test(threadsTrim) || parseInt(threadsTrim, 10) < 1) {
            setThreadsError('请输入大于等于1的整数');
            hasError = true;
        } else {
            setThreadsError('');
        }
        if (!/^\d+$/.test(latencyLimitTrim) || parseInt(latencyLimitTrim, 10) < 1 || parseInt(latencyLimitTrim, 10) > BROWSER_LATENCY_TIMEOUT_MS) {
            setLatencyLimitError(`请输入 1 到 ${BROWSER_LATENCY_TIMEOUT_MS} 之间的整数`);
            hasError = true;
        } else {
            setLatencyLimitError('');
        }
        if (hasError) return null;

        return {
            countNum: parseInt(countTrim, 10),
            threadsNum: parseInt(threadsTrim, 10),
            latencyLimitNum: parseInt(latencyLimitTrim, 10),
        };
    };

    const checkGeoLocation = async (): Promise<boolean> => {
        let isCN = true;
        try {
            const response = await fetch('https://api.ip.sb/geoip');
            const data = await response.json() as { country_code: string };
            isCN = data.country_code === 'CN';
        } catch (error) {
            console.error('Failed to determine location:', error);
            isCN = false;
        }
        if (!isCN) {
            return showLocationWarning();
        }
        return true;
    };

    const prepareTargets = async (
        countNum: number,
        excludedIps: ReadonlySet<string> = new Set(),
        sourceExpansionRound = 0,
    ): Promise<{ targets: string[]; resolvedMap?: Record<string, string | null> } | null> => {
        setSourceRows([]);
        setUniqueIpCount(0);
        setGrossIpCount(0);
        setIpCount(0);
        setDomainCount(0);

        if (cancelPreparingRef.current) return null;

        if (ipSource === 'third') {
            setPrepareDone(0);
            setPrepareTotal(0);

            // 先取出完整源列表，立即以"等待中"渲染全部条目
            const configuredSources = await getThirdPartySourceList();
            if (cancelPreparingRef.current) return null;
            if (!Array.isArray(configuredSources) || configuredSources.length === 0) {
                showToast('未配置第三方源，请先到"第三方IP/域名源"中添加', 'warning');
                return null;
            }

            const sources = configuredSources
                .map(source => source.replace(/^\uFEFF/, '').trim())
                .filter(source => source !== '' && !source.startsWith('#'));
            if (sources.length === 0) return null;

            const parsedSources = sources.map(source => ({ source, parsed: parseThirdPartySource(source) }));
            const urlSources = parsedSources.flatMap(({ parsed }, sourceIndex) => parsed.kind === 'url'
                ? [{ sourceIndex, url: getSourceUrlForExpansionRound(parsed.url, sourceExpansionRound) }]
                : []);
            const directTargets = parsedSources.flatMap(({ parsed }) => parsed.kind === 'target'
                ? [{ ip: parsed.ip, port: parsed.port }]
                : []);
            const rows: SourceRow[] = parsedSources.map(({ source, parsed }) => {
                if (parsed.kind === 'url') {
                    return { url: getSourceUrlForExpansionRound(parsed.url, sourceExpansionRound), status: 'pending' };
                }
                if (parsed.kind === 'target') {
                    return { url: source, status: 'done', ipCount: 1, domainCount: 0, ips: [{ ip: parsed.ip, port: parsed.port }] };
                }
                return { url: source, status: 'error', error: '格式无效' };
            });
            setSourceRows(rows);
            setPrepareTotal(urlSources.length);

            // 直接目标绕过源抓取 API；只有 URL 源需要后端拉取 IP 集合。
            const allIps = new Map<string, { ip: string; port: number }>();
            directTargets.forEach(item => allIps.set(`${item.ip}:${item.port}`, item));
            let grossCount = 0;
            let doneCount = 0;

            for (let i = 0; i < urlSources.length; i++) {
                if (cancelPreparingRef.current) return null;
                // 标记当前行为"解析中"
                const { sourceIndex, url } = urlSources[i];
                setSourceRows((prev) => prev.map((r, idx) => idx === sourceIndex ? { ...r, status: 'loading' } : r));
                setPrepareDone(i);

                let stat;
                try {
                    stat = await getThirdPartySourceIps(url);
                } catch (e) {
                    stat = { url, status: 'error', count: 0, ipCount: 0, domainCount: 0, ips: [], error: (e as Error).message };
                }

                // 更新当前行结果
                setSourceRows((prev) => prev.map((r, idx) => idx === sourceIndex ? {
                    url: stat.url,
                    status: stat.status === 'error' ? 'error' : 'done',
                    ipCount: stat.ipCount,
                    domainCount: stat.domainCount,
                    error: stat.error,
                    ips: stat.ips
                } : r));
                doneCount++;
                setPrepareDone(doneCount);

                if (stat.status !== 'error') {
                    for (const item of stat.ips) {
                        allIps.set(`${item.ip}:${item.port}`, item);
                    }
                }
                grossCount += stat.count;
            }

            if (cancelPreparingRef.current) return null;

            const finalIps = Array.from(allIps.values());
            let dedupIp = 0;
            let dedupDomain = 0;
            for (const item of finalIps) {
                if (isDomainName(item.ip)) dedupDomain++;
                else dedupIp++;
            }

            setUniqueIpCount(finalIps.length);
            setGrossIpCount(grossCount + directTargets.length);
            setIpCount(dedupIp);
            setDomainCount(dedupDomain);

            if (finalIps.length === 0) {
                showToast('未能获取到第三方源IP，请检查配置或后台日志', 'warning');
                return null;
            }

            const targets: string[] = [];
            const domainItems: { key: string; host: string }[] = [];
            for (const item of finalIps) {
                const key = `${item.ip}:${item.port}`;
                if (excludedIps.has(key)) continue;
                targets.push(key);
                // 收集域名源，前端用阿里云 DoH 解析出测速 IP
                if (isDomainName(item.ip)) domainItems.push({ key, host: item.ip });
            }

            const resolvedMap: Record<string, string | null> = {};
            if (domainItems.length > 0) {
                const entries = await Promise.all(
                    domainItems.map(async ({ key, host }) => [key, await resolveDomainToIp(host)] as const)
                );
                for (const [key, ip] of entries) resolvedMap[key] = ip;
            }

            return { targets, resolvedMap };
        }

        const cidrsToUse = ipSource === 'cf'
            ? (cfIps?.ipv4_cidrs?.length ? cfIps.ipv4_cidrs : (CF_CIDR_LIST || []))
            : ipSource === 'cm'
                ? (cfIps?.cm_cidrs?.length ? cfIps.cm_cidrs : (CF_CIDR_LIST || []))
                : (cfIps?.custom_ipv4_cidrs || []);

        if (!cidrsToUse || cidrsToUse.length === 0) {
            showToast(ipSource === 'custom'
                ? '还没有自定义 IP 段，请先到上方 IP 段中添加。'
                : '未找到Cloudflare IP段数据，请先点击上方的"同步IP段"按钮进行同步。', 'error');
            return null;
        }
        return { targets: generateRandomIps(cidrsToUse, countNum, excludedIps) };
    };

    // ---------- 本地 Agent 测速 ----------

    /** Agent 结果 -> 页面统一的 ScanResult，从而复用原有的结果列表与保存逻辑 */
    const toScanResult = (r: AgentResult): ScanResult => ({
        ip: r.host,
        port: r.port,
        isAvailable: r.ok,
        latency: r.ok ? r.latency : -1,
        colo: r.colo || undefined,
        domain: isDomainName(r.host) || undefined,
        tcpMs: r.tcpMs >= 0 ? r.tcpMs : undefined,
        tlsMs: r.tlsMs >= 0 ? r.tlsMs : undefined,
        error: r.error || undefined,
    });

    /**
     * 把页面已有的靶标字符串解析成 Agent 需要的 {host, ip, port}。
     * 域名源用 DoH 已解析出的 IP 去连接，但 host 保留域名，与浏览器端行为一致。
     */
    const buildAgentTargets = (
        rawTargets: string[],
        resolvedMap?: Record<string, string | null>,
        defaultPort = 443
    ) => rawTargets.map((raw) => {
        let host = raw;
        let port = defaultPort;
        const lastColon = raw.lastIndexOf(':');
        const closeBracket = raw.lastIndexOf(']');
        if (lastColon > -1 && lastColon > closeBracket) {
            const p = parseInt(raw.substring(lastColon + 1), 10);
            if (!isNaN(p)) {
                port = p;
                host = raw.substring(0, lastColon);
                if (host.startsWith('[') && host.endsWith(']')) host = host.substring(1, host.length - 1);
            }
        }
        if (port === 0) port = 443;
        const ip = (resolvedMap && resolvedMap[raw]) || host;
        return { host, ip, port };
    });

    /** 通过本地 Agent 执行测速：下发参数 -> 轮询进度 -> 汇总回传 */
    const runAgentScan = async (
        targets: { host: string; ip: string; port: number }[],
        threadsNum: number,
        latencyLimitNum: number,
        onProgress: (r: ScanResult) => void,
    ): Promise<ScanResult[]> => {
        if (!agentProbe?.online) throw new Error('本地 Agent 未连接');
        const base = agentProbe.baseUrl;

        await startAgentScan(base, {
            targets,
            threads: threadsNum,
            timeoutMs: 2500,
            latencyLimit: latencyLimitNum,
            source: ipSource,
        });

        let since = 0;
        let lastDone = -1;
        let stallTicks = 0;
        const acc: ScanResult[] = [];

        while (!agentStopRef.current) {
            const p = await fetchAgentProgress(base, since);
            since += p.count;
            for (const r of p.results) {
                const sr = toScanResult(r);
                acc.push(sr);
                onProgress(sr);
            }

            if (!p.running) break;

            // 卡死保护：连续 60 秒没有任何进展则放弃
            if (p.done === lastDone) {
                if (++stallTicks > 150) throw new Error('本地 Agent 长时间无进展，已放弃等待');
            } else {
                lastDone = p.done;
                stallTicks = 0;
            }
            await new Promise((r) => setTimeout(r, 400));
        }

        return acc.filter((r) => r.isAvailable).sort((a, b) => a.latency - b.latency);
    };

    const handleScan = async () => {
        cancelPreparingRef.current = false;
        scanStopRequestedRef.current = false;
        agentStopRef.current = false;

        const resultsFound: ScanResult[] = [];
        let scanStarted = false;
        const val = validateInputs();
        if (!val) return;

        setIsPreparing(true);
        try {
            const shouldContinue = await checkGeoLocation();
            if (!shouldContinue || cancelPreparingRef.current) {
                setIsPreparing(false);
                return;
            }

            const browserScanWillRun = activeTab !== 'local' || agentProbe?.online !== true;
            const candidateBatchSize = browserScanWillRun && ipSource !== 'third'
                ? val.countNum * RANDOM_CANDIDATES_PER_BATCH
                : val.countNum;
            const prepared = await prepareTargets(candidateBatchSize);
            if (!prepared || prepared.targets.length === 0 || cancelPreparingRef.current) {
                setIsPreparing(false);
                return;
            }

            const scanPort = selectedPort === 'random' ? 0 : selectedPort;
            const targetAvailableCount = val.countNum;
            const scanColos = new Set(selectedColos);
            setActiveScanColos(scanColos);
            const attemptedIps = new Set<string>();
            let candidates = prepared.targets;
            let resolvedMap = prepared.resolvedMap;
            let sourceExpansionRound = 0;

            onScanComplete([]);
            setProgress(0);
            setSuccessCount(0);
            setRegionMismatchCount(0);
            setFailCount(0);
            setTotal(0);
            setIsPreparing(false);
            setIsScanning(true);
            setStartTime(Date.now());
            setNow(Date.now());
            scanStarted = true;

            const agentReady = activeTab === 'local' && agentProbe?.online === true;
            agentModeRef.current = agentReady;
            setAgentActive(agentReady);

            let scanAttemptCount = 0;
            const onProgress = (result: ScanResult) => {
                scanAttemptCount++;
                setProgress(scanAttemptCount);
                if (isRegionQualifiedResult(result, scanColos)) {
                    setSuccessCount(success => success + 1);
                    resultsFound.push(result);
                    resultsFound.sort((a, b) => a.latency - b.latency);
                    onScanProgress([...resultsFound]);
                } else if (result.isAvailable) {
                    setRegionMismatchCount(count => count + 1);
                } else {
                    setFailCount(failures => failures + 1);
                }
            };

            while (candidates.length > 0 && !scanStopRequestedRef.current) {
                const remainingCount = targetAvailableCount - resultsFound.length;
                const batchLimit = agentReady
                    ? remainingCount
                    : candidates.length;
                const batchCandidates = candidates.filter(ip => !attemptedIps.has(ip)).slice(0, batchLimit);

                if (batchCandidates.length === 0) break;
                batchCandidates.forEach(ip => attemptedIps.add(ip));

                const scanTargets = batchCandidates.map(target => {
                    const randomPort = CLOUDFLARE_HTTPS_PORTS[Math.floor(Math.random() * CLOUDFLARE_HTTPS_PORTS.length)];
                    return assignScanPort(target, ipSource, selectedPort, randomPort);
                });
                const originalResolvedMap = resolvedMap;
                const scanResolvedMap = originalResolvedMap
                    ? { ...originalResolvedMap }
                    : undefined;
                if (scanResolvedMap && originalResolvedMap) {
                    batchCandidates.forEach((target, index) => {
                        if (Object.prototype.hasOwnProperty.call(originalResolvedMap, target)) {
                            scanResolvedMap[scanTargets[index]] = originalResolvedMap[target];
                        }
                    });
                }
                setTotal(total => total + scanTargets.length);
                await new Promise(resolve => setTimeout(resolve, 0));

                if (agentReady) {
                    const agentTargets = buildAgentTargets(scanTargets, scanResolvedMap, scanPort);
                    await runAgentScan(agentTargets, val.threadsNum, val.latencyLimitNum, onProgress);
                } else {
                    const scanner = new BatchScanner(
                        scanTargets,
                        scanPort,
                        val.threadsNum,
                        val.latencyLimitNum,
                        onProgress,
                        () => {},
                        scanResolvedMap,
                        remainingCount,
                        result => matchesSelectedColo(result.colo, scanColos),
                    );
                    scannerRef.current = scanner;
                    await scanner.run();
                }

                if (
                    resultsFound.length >= targetAvailableCount ||
                    scanStopRequestedRef.current
                ) break;

                const remainingCountAfterBatch = targetAvailableCount - resultsFound.length;
                const nextBatchSize = browserScanWillRun && ipSource !== 'third'
                    ? Math.max(remainingCountAfterBatch, targetAvailableCount * RANDOM_CANDIDATES_PER_BATCH)
                    : remainingCountAfterBatch;
                if (ipSource === 'third') {
                    const untestedCandidates = candidates.filter(ip => !attemptedIps.has(ip));
                    if (untestedCandidates.length > 0) {
                        candidates = untestedCandidates;
                    } else {
                        sourceExpansionRound++;
                        const expandedSource = await prepareTargets(nextBatchSize, attemptedIps, sourceExpansionRound);
                        candidates = expandedSource?.targets ?? [];
                        resolvedMap = { ...resolvedMap, ...expandedSource?.resolvedMap };
                    }
                } else {
                    const nextBatch = await prepareTargets(nextBatchSize, attemptedIps);
                    candidates = nextBatch?.targets ?? [];
                }
            }

            const sortedResults = resultsFound.sort((a, b) => a.latency - b.latency);
            setTotal(scanAttemptCount);
            setProgress(scanAttemptCount);
            setIsStopping(false);
            setIsPaused(false);
            setAgentActive(false);
            agentModeRef.current = false;
            scannerRef.current?.stop();
            setIsScanning(false);
            setStartTime(null);
            onScanComplete(sortedResults);

            if (resultsFound.length < targetAvailableCount) {
                const reason = scanStopRequestedRef.current
                    ? '已停止'
                    : ipSource === 'third'
                        ? '第三方源没有更多新候选 IP，请确认源支持 limit 扩展或分页'
                        : 'IP 网段没有生成更多未测候选';
                showToast(`${reason}，找到 ${resultsFound.length}/${targetAvailableCount} 个符合筛选条件的 IP`, 'warning');
            } else {
                showToast(`已找到 ${targetAvailableCount} 个符合筛选条件的 IP`, 'success');
            }
        } catch (error) {
            console.error('Scan failed:', error);
            setIsScanning(false);
            setIsPreparing(false);
            setIsPaused(false);
            setIsStopping(false);
            setAgentActive(false);
            agentModeRef.current = false;
            scannerRef.current?.stop();
            setStartTime(null);
            if (scanStarted) onScanComplete(resultsFound.sort((a, b) => a.latency - b.latency));
            showToast('启动测试失败，请检查控制台错误信息', 'error');
        }
    };

    const handleStopScan = () => {
        scanStopRequestedRef.current = true;
        setIsStopping(true);
        setIsPaused(false);
        setStartTime(null);
        if (agentModeRef.current && agentProbe?.online) {
            agentStopRef.current = true;
            void stopAgentScan(agentProbe.baseUrl);
        }
        if (scannerRef.current) {
            scannerRef.current.stop();
        }
    };

    const handlePause = () => {
        if (scannerRef.current) {
            scannerRef.current.pause();
        }
        setPausedAt(Date.now());
        setIsPaused(true);
    };

    const handleResume = () => {
        if (scannerRef.current && pausedAt !== null) {
            // 将暂停时长补偿到 startTime，使已用时连续、预计剩余准确
            setStartTime((prev) => (prev !== null ? prev + (Date.now() - pausedAt) : prev));
        }
        setPausedAt(null);
        if (scannerRef.current) {
            scannerRef.current.resume();
        }
        setIsPaused(false);
    };

    // 扫描进行中且未暂停时，每 1 秒刷新 now 以更新已用时间
    useEffect(() => {
        if (!isScanning || isPaused) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [isScanning, isPaused]);

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-3 mb-4">
                <Gauge className="w-7 h-7 text-purple-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">IP优选测速</h2>
            </div>
            
            <div className="grid grid-cols-1 gap-4 mb-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                <div>
                    <label htmlFor="ip-source" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">IP来源:</label>
                    <select
                        id="ip-source"
                        value={ipSource}
                        onChange={(e) => setIpSource(e.target.value as ScannerIpSource)}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    >
                        <option value="cf">CF官方IP</option>
                        <option value="cm">CM整理IP</option>
                        <option value="custom">自定义IP段</option>
                        <option value="third">第三方IP/域名源</option>
                    </select>
                </div>
                <div>
                    <label htmlFor="ip-count" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">目标可用IP数量:</label>
                    <input
                        id="ip-count"
                        type="text"
                        value={count}
                        onChange={(e) => { setCount(e.target.value); if (countError) setCountError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {countError && <p className="text-red-500 text-xs mt-1">{countError}</p>}
                </div>
                <div>
                    <label htmlFor="port-select" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">端口:</label>
                    {ipSource === 'third' ? (
                        <div className="flex h-10 items-center rounded border border-gray-200 bg-gray-50 px-3 text-sm text-gray-600 dark:border-gray-600 dark:bg-gray-700/60 dark:text-gray-300">
                            使用源内端口，缺省 443
                        </div>
                    ) : (
                        <select id="port-select" value={selectedPort} onChange={(e) => setSelectedPort(e.target.value === 'random' ? 'random' : Number(e.target.value))} className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50" disabled={isScanning || isPreparing}>
                            <option value="random">随机</option>
                            {CLOUDFLARE_HTTPS_PORTS.map(port => (
                                <option key={port} value={port}>{port}</option>
                            ))}
                        </select>
                    )}
                </div>
                <div>
                    <label htmlFor="threads-count" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">线程数:</label>
                    <input
                        id="threads-count"
                        type="text"
                        value={threads}
                        onChange={(e) => { setThreads(e.target.value); if (threadsError) setThreadsError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {threadsError && <p className="text-red-500 text-xs mt-1">{threadsError}</p>}
                </div>
                <div>
                    <label htmlFor="latency-limit" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">延迟限制(ms):</label>
                    <input
                        id="latency-limit"
                        type="text"
                        inputMode="numeric"
                        maxLength={4}
                        value={latencyLimit}
                        onChange={(e) => {
                            const value = e.target.value;
                            setLatencyLimit(
                                /^\d+$/.test(value) && Number(value) > BROWSER_LATENCY_TIMEOUT_MS
                                    ? String(BROWSER_LATENCY_TIMEOUT_MS)
                                    : value
                            );
                            if (latencyLimitError) setLatencyLimitError('');
                        }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {latencyLimitError && <p className="text-red-500 text-xs mt-1">{latencyLimitError}</p>}
                </div>
            </div>

            <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <div>
                <label id="scan-region-label" className="mb-1 block text-sm font-semibold text-gray-700 dark:text-gray-300">扫描地区:</label>
                <div className="relative" ref={regionPickerRef}>
                    <button
                        type="button"
                        aria-labelledby="scan-region-label"
                        aria-expanded={isRegionPickerOpen}
                        aria-controls="scan-region-picker"
                        onClick={() => setIsRegionPickerOpen(open => !open)}
                        disabled={isScanning || isPreparing}
                        className="flex h-10 w-full items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-left text-sm text-gray-700 transition-colors hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                    >
                        <MapPin className="h-4 w-4 flex-none text-purple-600 dark:text-purple-300" />
                        <span className="min-w-0 flex-1 truncate">{selectedRegionLabel}</span>
                        {selectedColos.size > 0 && <span className="flex-none text-xs text-gray-500 dark:text-gray-400">{selectedColos.size} 个机房</span>}
                        <ChevronDown className={`h-4 w-4 flex-none text-gray-400 transition-transform ${isRegionPickerOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isRegionPickerOpen && (
                        <div
                            id="scan-region-picker"
                            aria-label="地区筛选选项"
                            className="absolute left-0 z-40 mt-1 w-full max-w-[calc(100vw-3rem)] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-600 dark:bg-gray-800 sm:w-[42rem]"
                        >
                            <div className="space-y-3 border-b border-gray-200 p-3 dark:border-gray-700">
                                <div className="relative">
                                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                                    <input
                                        type="search"
                                        aria-label="搜索国家、机房名称或代码"
                                        value={regionSearch}
                                        onChange={event => setRegionSearch(event.target.value)}
                                        placeholder="搜索国家、机房名称或代码"
                                        className="w-full rounded border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-800 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                                    />
                                </div>
                                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                    <button
                                        type="button"
                                        onClick={() => setSelectedColos(new Set())}
                                        disabled={selectedColos.size === 0}
                                        className="rounded px-2.5 py-1.5 font-medium text-purple-700 hover:bg-purple-50 disabled:cursor-not-allowed disabled:text-gray-400 dark:text-purple-300 dark:hover:bg-purple-900/30 dark:disabled:text-gray-500"
                                    >
                                        不限地区
                                    </button>
                                    <span className="text-xs text-gray-500 dark:text-gray-400">已选 {selectedColos.size} 个机房</span>
                                </div>
                            </div>

                            <div className="max-h-64 overflow-y-auto p-3">
                                {visibleRegionGroups.length > 0 ? (
                                    <div className="space-y-3">
                                        {visibleRegionGroups.map(group => {
                                            const allSelected = group.colos.every(colo => selectedColos.has(colo));
                                            const someSelected = group.colos.some(colo => selectedColos.has(colo));
                                            return (
                                                <section key={group.countryCode} className="border-b border-gray-100 pb-3 last:border-0 last:pb-0 dark:border-gray-700">
                                                    <label className="mb-2 flex cursor-pointer items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                                                        <input
                                                            type="checkbox"
                                                            checked={allSelected}
                                                            ref={element => { if (element) element.indeterminate = someSelected && !allSelected; }}
                                                            onChange={() => toggleCountry(group.colos)}
                                                            className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                                        />
                                                        <span>{group.name}</span>
                                                        <span className="font-normal text-gray-400">{group.colos.length}</span>
                                                    </label>
                                                    <div className="grid grid-cols-1 gap-x-4 gap-y-1 pl-6 sm:grid-cols-2">
                                                        {group.visibleColos.map(colo => (
                                                            <label key={colo} className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/70">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={selectedColos.has(colo)}
                                                                    onChange={() => toggleColo(colo)}
                                                                    className="h-4 w-4 flex-none rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                                                />
                                                                <span className="min-w-0 truncate">{getColoText(colo)}</span>
                                                                <code className="ml-auto flex-none text-xs text-gray-400">{colo}</code>
                                                            </label>
                                                        ))}
                                                    </div>
                                                </section>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">没有匹配的地区</p>
                                )}
                            </div>

                            <div className="flex flex-wrap items-end gap-2 border-t border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/30">
                                <label className="min-w-36 flex-1 text-xs font-medium text-gray-600 dark:text-gray-300">
                                    添加机房代码
                                    <input
                                        type="text"
                                        value={customColo}
                                        onChange={event => setCustomColo(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3))}
                                        onKeyDown={event => { if (event.key === 'Enter') addCustomColo(); }}
                                        placeholder="例如 NRT"
                                        className="mt-1 block w-full rounded border border-gray-300 bg-white px-2.5 py-2 font-mono text-sm text-gray-800 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                                    />
                                </label>
                                <button
                                    type="button"
                                    onClick={addCustomColo}
                                    disabled={!/^[A-Z0-9]{3}$/.test(customColo) || !isColoSelectable(customColo)}
                                    className="inline-flex h-9 items-center gap-1 rounded border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                                >
                                    <Plus className="h-4 w-4" />
                                    添加
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setIsRegionPickerOpen(false)}
                                    className="h-9 rounded bg-purple-600 px-4 text-sm font-medium text-white hover:bg-purple-700"
                                >
                                    完成
                                </button>
                            </div>
                        </div>
                    )}
                </div>
                </div>
                <div className="flex w-fit max-w-full items-center rounded-md border border-gray-200 bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-700" role="group" aria-label="测速方式">
                    <button
                        type="button"
                        onClick={() => setActiveTab('browser')}
                        disabled={isScanning || isPreparing}
                        className={`rounded px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${activeTab === 'browser'
                            ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white'
                            : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
                            }`}
                    >
                        浏览器测速
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('local')}
                        disabled={isScanning || isPreparing}
                        className={`rounded px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${activeTab === 'local'
                            ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white'
                            : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
                            }`}
                    >
                        本地测速
                    </button>
                </div>
            </div>

            {/* ============ 测速方式：浏览器测速 / 本地测速 ============ */}
            <div className="mb-4">
                {activeTab === 'browser' ? (
                    /* ---------- 浏览器测速面板 ---------- */
                    <div className="space-y-3">
                        {browserChecking && (
                            <p className="text-sm text-gray-500 dark:text-gray-400">正在检测浏览器测速是否可用…</p>
                        )}
                        {!browserChecking && browserHealthy === true && (
                            <div className="flex items-start gap-2.5 rounded-lg border border-green-200 dark:border-green-700/50 bg-green-50 dark:bg-green-900/20 px-4 py-3">
                                <CheckCircle2 className="w-4 h-4 text-green-500 flex-none mt-0.5" />
                                <div className="text-sm text-green-800 dark:text-green-300">
                                    <p>当前环境的浏览器测速可用。</p>
                                    <p className="mt-1">可直接点击下方「开始测试（浏览器）」进行测速。</p>
                                </div>
                            </div>
                        )}
                        {!browserChecking && browserHealthy === false && (
                            <div className="flex items-start gap-2.5 rounded-lg border border-orange-200 dark:border-orange-700/50 bg-orange-50 dark:bg-orange-900/20 px-4 py-3">
                                <AlertTriangle className="w-4 h-4 text-orange-500 flex-none mt-0.5" />
                                <div className="text-sm text-orange-800 dark:text-orange-300">
                                    <p>当前环境的浏览器测速不可用（测速地址无法解析或连接失败）。</p>
                                    <p className="mt-1">
                                        建议使用「本地测速」：在本机运行 Agent 后，页面参数会原样下发到本机执行，结果更稳定。
                                        <button
                                            onClick={() => setActiveTab('local')}
                                            className="ml-1 inline-flex items-center gap-1 text-orange-700 dark:text-orange-200 font-medium underline underline-offset-2 hover:opacity-80"
                                        >
                                            切换到本地测速 →
                                        </button>
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    /* ---------- 本地 Agent 测速面板 ---------- */
                    <div className={'rounded-lg border overflow-hidden ' + (agentProbe?.online ? 'border-green-500 dark:border-green-500' : 'border-red-500 dark:border-red-500')}>
                        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-900/40">
                            <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                <Cpu className="w-5 h-5 text-teal-500 flex-none" />
                                <span className="font-medium text-gray-700 dark:text-gray-200">本地 Agent 测速</span>
                                {agentProbe === null && (
                                    <span className="px-2 py-0.5 text-xs rounded-full bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">未检测</span>
                                )}
                                {agentProbe && !agentProbe.online && agentProbe.reason === 'offline' && (
                                    <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">未启动</span>
                                )}
                                {agentProbe?.online && (
                                    <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                                        已连接 {agentProbe.baseUrl}
                                        {agentProbe.status.running && agentProbe.status.task
                                            ? ` · 忙（${agentProbe.status.task.done}/${agentProbe.status.task.total}）`
                                            : ''}
                                    </span>
                                )}
                            </div>

                            <button
                                onClick={() => void checkAgent(Number(agentPort) || DEFAULT_AGENT_PORT)}
                                disabled={agentChecking || isScanning}
                                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-teal-600 text-white hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-none"
                            >
                                <RefreshCw className={`w-3 h-3 ${agentChecking ? 'animate-spin' : ''}`} />
                                {agentChecking ? '检测中' : '检测服务'}
                            </button>
                        </div>

                        <div className="px-4 py-3">
                            {/* 本地服务端口设置（保存在浏览器本地） */}
                            <div className="flex items-center gap-2 mb-3">
                                <label htmlFor="agent-port" className="text-xs text-gray-600 dark:text-gray-400 flex-none">本地服务端口</label>
                                <input
                                    id="agent-port"
                                    type="text"
                                    inputMode="numeric"
                                    value={agentPort}
                                    onChange={(e) => {
                                        const v = e.target.value.replace(/[^\d]/g, '').slice(0, 5);
                                        setAgentPort(v);
                                        localStorage.setItem('LOCAL_AGENT_PORT', v);
                                    }}
                                    placeholder={String(DEFAULT_AGENT_PORT)}
                                    className="w-24 px-2.5 py-1.5 text-xs font-mono rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none disabled:opacity-50"
                                    disabled={isScanning || agentChecking}
                                />
                                <span className="text-xs text-gray-400 dark:text-gray-500">默认 {DEFAULT_AGENT_PORT}</span>
                            </div>

                            {!agentProbe?.online && (
                                <>
                                    <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                                        本机 Agent 未运行，请按以下步骤启动：
                                    </p>
                                    <ol className="list-decimal list-inside space-y-1.5 text-sm text-gray-600 dark:text-gray-400 mb-3">
                                        <li>
                                            下载并解压 <a href="/local-agent.zip" download className="text-teal-600 dark:text-teal-400 hover:underline font-medium">local-agent.zip</a>（需先安装
                                            <a href="https://nodejs.org/" target="_blank" rel="noreferrer" className="text-teal-600 dark:text-teal-400 hover:underline"> Node.js</a>，16 及以上版本）
                                        </li>
                                        <li>
                                            进入解压后的文件夹，执行 <code className="px-1 rounded bg-gray-100 dark:bg-gray-700 text-xs">node agent.js</code>
                                            （Windows 双击 <code className="px-1 rounded bg-gray-100 dark:bg-gray-700 text-xs">start.bat</code>即可启动）
                                        </li>
                                        <li>确认端口与本地 <code className="px-1 rounded bg-gray-100 dark:bg-gray-700 text-xs">config.json</code> 的 listenPort 一致，再点「检测服务」</li>
                                    </ol>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className="mb-4 flex justify-center" >
                <button onClick={handleScan} disabled={isScanning || isPreparing || (activeTab === 'local' && !agentProbe?.online)} className="flex items-center bg-purple-600 text-white font-bold py-2 px-4 rounded-md hover:bg-purple-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed">
                    {isPreparing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                    {isPreparing
                        ? (ipSource === 'third' && prepareTotal > 0
                            ? `解析源 ${prepareDone}/${prepareTotal}`
                            : '准备中...')
                            : isScanning
                                ? `测试中... (${progress}/${total})`
                                : (activeTab === 'local'
                                    ? (agentProbe?.online ? '开始测试（本地 Agent）' : '本地 Agent 未连接')
                                    : '开始测试（浏览器）')}
                </button>
                {isPreparing && (
                    <button onClick={() => { cancelPreparingRef.current = true; setIsPreparing(false); }} style={{ marginLeft: "8px" }}
                            className="flex items-center bg-red-600 text-white font-bold py-2 px-4 rounded-md hover:bg-red-700 transition-colors">
                        <StopCircle className="w-4 h-4 mr-2" />
                        取消准备
                    </button>
                )}
                {isScanning && (
                    <button onClick={handleStopScan} style={{ marginLeft: "8px" }} disabled={isStopping}
                            className="flex items-center bg-red-600 text-white font-bold py-2 px-4 rounded-md hover:bg-red-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed">
                        <StopCircle className="w-4 h-4 mr-2" />
                        {isStopping ? '停止中...' : '停止测试'}
                    </button>
                )}
            </div >

            {isScanning && (() => {
                const endRef = isPaused && pausedAt !== null ? pausedAt : now;
                const elapsedSec = startTime ? Math.floor((endRef - startTime) / 1000) : 0;
                const requestedCount = Math.max(1, parseInt(count, 10) || 1);
                const percent = Math.min(100, Math.round((successCount / requestedCount) * 100));
                const fmt = (s: number) => {
                    const m = Math.floor(s / 60);
                    const sec = s % 60;
                    return `${m}:${sec.toString().padStart(2, '0')}`;
                };
                return (
                    <div className="mb-4 w-full border-y border-gray-200 py-4 dark:border-gray-700">
                        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                            <div className="flex min-w-0 items-center gap-3">
                                <span className="text-xl font-semibold tabular-nums text-purple-700 dark:text-purple-300">{percent}%</span>
                                <div className="text-sm">
                                    <div className="font-semibold text-gray-800 dark:text-gray-100">测速进度</div>
                                    <div className="text-gray-500 dark:text-gray-400">已测 {progress} / {total}，合格 {successCount} / {requestedCount}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                {isPaused ? (
                                    <button
                                        type="button"
                                        onClick={handleResume}
                                        aria-label="继续测试"
                                        title="继续测试"
                                        className="flex h-9 w-9 items-center justify-center rounded-md bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/50 dark:text-green-300 dark:hover:bg-green-800/50"
                                    >
                                        <Play className="w-4 h-4" />
                                    </button>
                                ) : agentActive ? (
                                    <span
                                        aria-label="本地 Agent 模式不支持暂停"
                                        title="本地 Agent 模式暂不支持暂停，可使用「停止测试」"
                                        className="flex h-9 w-9 cursor-not-allowed items-center justify-center rounded-md bg-gray-100 text-gray-300 dark:bg-gray-700 dark:text-gray-500"
                                    >
                                        <Pause className="w-4 h-4" />
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={handlePause}
                                        aria-label="暂停测试"
                                        title="暂停测试"
                                        className="flex h-9 w-9 items-center justify-center rounded-md bg-yellow-100 text-yellow-700 hover:bg-yellow-200 dark:bg-yellow-900/50 dark:text-yellow-300 dark:hover:bg-yellow-800/50"
                                    >
                                        <Pause className="w-4 h-4" />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={handleStopScan}
                                    disabled={isStopping}
                                    aria-label="停止测试"
                                    title="停止测试"
                                    className="flex h-9 w-9 items-center justify-center rounded-md bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-800/50 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Square className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        <div
                            className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
                            role="progressbar"
                            aria-label="测速进度"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percent}
                        >
                            <div className="h-full rounded-full bg-green-500 transition-all duration-300" style={{ width: `${percent}%` }} />
                        </div>
                        <div className={`mt-2 grid gap-2 text-xs sm:text-sm ${activeScanColos.size > 0 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
                            <span className="text-green-700 dark:text-green-400">成功 {successCount}</span>
                            {activeScanColos.size > 0 && (
                                <span className="text-center text-amber-700 dark:text-amber-400">地区不符 {regionMismatchCount}</span>
                            )}
                            <span className="text-center text-gray-600 dark:text-gray-400">已用 {fmt(elapsedSec)}</span>
                            <span className="text-right text-red-700 dark:text-red-400">失败 {failCount}</span>
                        </div>
                    </div>
                );
            })()}

            {/* 第三方源逐条解析展示区 */}
            {ipSource === 'third' && sourceRows.length > 0 && (
                <div className="mb-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 border border-gray-100 dark:border-gray-700">
                    <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                        第三方IP/域名获取详情 {isPreparing && `(${prepareDone}/${prepareTotal})`}
                    </h3>

                    {/* 解析完成后的总览信息 */}
                    {!isPreparing && (
                        <div className="mb-3 text-sm text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800/50 p-2 rounded-md text-center">
                            共发现 <strong className="text-blue-500 font-semibold">{grossIpCount}</strong> 个记录，
                            去重后剩余 <strong className="text-purple-500 font-semibold">{uniqueIpCount}</strong> 个，
                            其中 IP <strong className="text-green-500 font-semibold">{ipCount}</strong> 个、
                            域名 <strong className="text-orange-500 font-semibold">{domainCount}</strong> 个。
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {sourceRows.map((row, idx) => (
                            <div key={idx} className="flex items-center justify-between bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-600 shadow-sm text-xs transition-colors hover:border-purple-200 dark:hover:border-purple-800">
                                <div className="truncate flex-1 mr-2 text-gray-600 dark:text-gray-300 font-mono" title={row.url}>
                                    {row.url.replace(/^https?:\/\//, '')}
                                </div>
                                <span className="flex items-center gap-1 shrink-0">
                                    {row.status === 'pending' && (
                                        <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                                            等待中
                                        </span>
                                    )}
                                    {row.status === 'loading' && (
                                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full font-bold shadow-sm bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            解析中
                                        </span>
                                    )}
                                    {row.status === 'done' && (
                                        <>
                                            {row.ipCount! > 0 && (
                                                <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" title="IP 个数">
                                                    IP {row.ipCount}
                                                </span>
                                            )}
                                            {row.domainCount! > 0 && (
                                                <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" title="域名个数">
                                                    域名 {row.domainCount}
                                                </span>
                                            )}
                                            {row.ipCount === 0 && row.domainCount === 0 && (
                                                <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400" title="该源未返回有效条目">
                                                    未解析出
                                                </span>
                                            )}
                                        </>
                                    )}
                                    {row.status === 'error' && (
                                        <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" title={row.error || '请求失败'}>
                                            失败
                                        </span>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

        </div >
    );
}
