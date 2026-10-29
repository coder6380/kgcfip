import { useState, useEffect, useRef } from 'react';
import { saveResults, getScenes } from '../api';
import {
  ScanResult,
  BROWSER_LATENCY_TIMEOUT_MS,
  getLatencyColor,
  measureIpDownloadSpeed,
  measureIpLatency,
} from '../utils/scanner';
import { useToast } from './Toast';
import { Gauge, ListFilter, RefreshCw, Save, StopCircle } from 'lucide-react';
import { RegionDisplay } from './RegionDisplay';

interface IpScannerResultsAndSaveProps {
    scanResults: ScanResult[];
    onSaveSuccess?: () => void;
}

const DEFAULT_IPS_PER_REGION = 20;
type DownloadMeasurement = {
    status: 'pending' | 'testing' | 'done' | 'error';
    speed?: number;
    error?: string;
};
type LatencyMeasurement = {
    status: 'pending' | 'testing' | 'done';
    latency?: number;
    colo?: string;
    error?: string;
};

const getResultKey = (result: Pick<ScanResult, 'ip' | 'port'>) => `${result.ip}:${result.port}`;
const uniqueResultsByEndpoint = (results: ScanResult[]) =>
    Array.from(new Map(results.map(result => [getResultKey(result), result])).values());

export function ScannerResults({ scanResults, onSaveSuccess }: IpScannerResultsAndSaveProps) {
    const [ipsPerRegion, setIpsPerRegion] = useState<string>(String(DEFAULT_IPS_PER_REGION));
    const [ipsPerRegionError, setIpsPerRegionError] = useState<string>('');
    const [isLatencyFilterEnabled, setIsLatencyFilterEnabled] = useState(false);
    const [isRegionLimitEnabled, setIsRegionLimitEnabled] = useState(false);
    const [latencyFilterValue, setLatencyFilterValue] = useState<string>('300');
    const [latencyFilterError, setLatencyFilterError] = useState<string>('');
    const [isSaving, setIsSaving] = useState(false);
    const [sceneName, setSceneName] = useState('');
    const [scenes, setScenes] = useState<string[]>([]);
    const [sceneDropdownOpen, setSceneDropdownOpen] = useState(false);
    const sceneInputRef = useRef<HTMLDivElement>(null);
    const [saveMode, setSaveMode] = useState<'overwrite' | 'append'>('overwrite');
    const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
    const [selectedPorts, setSelectedPorts] = useState<Set<string>>(new Set());
    const [selectedResults, setSelectedResults] = useState<Set<string>>(new Set());
    const [isDownloadSpeedFilterEnabled, setIsDownloadSpeedFilterEnabled] = useState(false);
    const [minimumDownloadSpeed, setMinimumDownloadSpeed] = useState('5');
    const [downloadDuration, setDownloadDuration] = useState('3000');
    const [isDownloadTesting, setIsDownloadTesting] = useState(false);
    const [resultSortMode, setResultSortMode] = useState<'latency' | 'downloadSpeed'>('latency');
    const [downloadProgress, setDownloadProgress] = useState({ completed: 0, total: 0, currentIp: '' });
    const [downloadTestMessage, setDownloadTestMessage] = useState('');
    const [downloadMeasurements, setDownloadMeasurements] = useState<Record<string, DownloadMeasurement>>({});
    const [isLatencyTesting, setIsLatencyTesting] = useState(false);
    const [latencyProgress, setLatencyProgress] = useState({ completed: 0, total: 0, currentIp: '' });
    const [latencyTestMessage, setLatencyTestMessage] = useState('');
    const [latencyMeasurements, setLatencyMeasurements] = useState<Record<string, LatencyMeasurement>>({});
    const downloadControllerRef = useRef<AbortController | null>(null);
    const latencyControllerRef = useRef<AbortController | null>(null);
    const filterInitialized = useRef(false);
    const regionFilterTouched = useRef(false);
    const portFilterTouched = useRef(false);
    const knownRegionsRef = useRef(new Set<string>());
    const knownPortsRef = useRef(new Set<string>());

    const resultsWithLatency = scanResults.map(result => {
        const measurement = latencyMeasurements[getResultKey(result)];
        if (measurement?.status !== 'done') return result;
        return {
            ...result,
            latency: measurement.latency ?? -1,
            colo: measurement.latency && measurement.latency > 0 && measurement.colo && measurement.colo !== '-'
                ? measurement.colo
                : result.colo,
            error: measurement.error,
        };
    });
    const uniqueRegions: string[] = Array.from(new Set(resultsWithLatency.map(r => r.colo))).filter((r): r is string => !!r).sort();
    const uniquePorts: number[] = Array.from(new Set(resultsWithLatency.map(r => r.port))).sort((a, b) => a - b);

    const regionOptionsKey = uniqueRegions.join('\0');
    const portOptionsKey = uniquePorts.map(String).join('\0');

    // Keep newly discovered options selected while each filter remains in its default all-selected mode.
    useEffect(() => {
        if (scanResults.length === 0) return;

        const availablePorts = uniquePorts.map(String);
        const newRegions = uniqueRegions.filter(region => !knownRegionsRef.current.has(region));
        const newPorts = availablePorts.filter(port => !knownPortsRef.current.has(port));

        if (!filterInitialized.current && (uniqueRegions.length > 0 || availablePorts.length > 0)) {
            setSelectedRegions(new Set(uniqueRegions));
            setSelectedPorts(new Set(availablePorts));
            filterInitialized.current = true;
        } else {
            if (!regionFilterTouched.current && newRegions.length > 0) {
                setSelectedRegions(previous => new Set([...previous, ...newRegions]));
            }
            if (!portFilterTouched.current && newPorts.length > 0) {
                setSelectedPorts(previous => new Set([...previous, ...newPorts]));
            }
        }

        knownRegionsRef.current = new Set(uniqueRegions);
        knownPortsRef.current = new Set(availablePorts);
    }, [scanResults.length, regionOptionsKey, portOptionsKey]);

    // 加载已保存场景名列表，供场景录入框快速选择
    useEffect(() => {
        const load = async () => {
            try {
                const data = await getScenes();
                setScenes(data.map((s) => s.name));
            } catch {
                // 加载失败不影响录入
            }
        };
        load();
    }, []);

    // 点击下拉外部时关闭场景选择浮层
    useEffect(() => {
        if (!sceneDropdownOpen) return;
        const handler = (e: MouseEvent) => {
            if (sceneInputRef.current && !sceneInputRef.current.contains(e.target as Node)) {
                setSceneDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [sceneDropdownOpen]);

    // 已保存场景列表，不进行过滤，全部展示为标签
    const sceneOptions = scenes;

    const latencyTrim = latencyFilterValue.trim();
    const isLatencyFormatValid = /^\d+$/.test(latencyTrim);
    const effectiveLatencyValue = isLatencyFormatValid ? parseInt(latencyTrim, 10) : 0;

    const ipsPerRegionTrim = ipsPerRegion.trim();
    const isIpsPerRegionFormatValid = /^\d+$/.test(ipsPerRegionTrim) && parseInt(ipsPerRegionTrim, 10) >= 1;
    const effectiveIpsPerRegion = isIpsPerRegionFormatValid ? parseInt(ipsPerRegionTrim, 10) : DEFAULT_IPS_PER_REGION;
    const minimumDownloadSpeedValue = Number(minimumDownloadSpeed);
    const isMinimumDownloadSpeedValid = minimumDownloadSpeed.trim() !== ''
        && Number.isFinite(minimumDownloadSpeedValue)
        && minimumDownloadSpeedValue >= 0;

    const baseFilteredResults = resultsWithLatency.filter(r => isLatencyFilterEnabled
        ? (isLatencyFormatValid && r.latency > -1 && r.latency <= effectiveLatencyValue)
        : true
    );

    const portCounts = baseFilteredResults.reduce((acc, r) => {
        const key = String(r.port);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    // 按端口筛选：仅保留 selectedPorts 中的端口
    const portFilteredResults = baseFilteredResults.filter(r =>
        selectedPorts.has(String(r.port))
    );

  const regionCounts = portFilteredResults.reduce((acc, r) => {
        if (r.colo) {
            acc[r.colo] = (acc[r.colo] || 0) + 1;
        }
        return acc;
    }, {} as Record<string, number>);

    const filteredResults = portFilteredResults.filter(r =>
        r.colo ? selectedRegions.has(r.colo) : true
    );

    let regionLimitedResults = [...filteredResults];
    if (isRegionLimitEnabled) {
        const regionCountsForLimit: { [key: string]: number } = {};
        regionLimitedResults = filteredResults.filter(r => {
            const colo = r.colo || 'Unknown';
            regionCountsForLimit[colo] = (regionCountsForLimit[colo] || 0) + 1;
            return regionCountsForLimit[colo] <= effectiveIpsPerRegion;
        });
    }

    const getResultDownloadSpeed = (result: ScanResult) => {
        const measurement = downloadMeasurements[getResultKey(result)];
        if (measurement?.status === 'done') return measurement.speed;
        if (measurement?.status === 'pending' || measurement?.status === 'error' || measurement?.status === 'testing') {
            return undefined;
        }
        if (result.downloadSpeedError) return undefined;
        return typeof result.downloadSpeedMBps === 'number' ? result.downloadSpeedMBps : undefined;
    };

    const limitedResults = regionLimitedResults.filter(result => {
        if (!isDownloadSpeedFilterEnabled) return true;
        const speed = getResultDownloadSpeed(result);
        return isMinimumDownloadSpeedValid && typeof speed === 'number' && speed >= minimumDownloadSpeedValue;
    });
    const sortedResults = [...limitedResults].sort((left, right) => {
        const leftLatency = left.latency > 0 ? left.latency : Number.POSITIVE_INFINITY;
        const rightLatency = right.latency > 0 ? right.latency : Number.POSITIVE_INFINITY;
        if (resultSortMode === 'downloadSpeed') {
            const leftSpeed = getResultDownloadSpeed(left);
            const rightSpeed = getResultDownloadSpeed(right);
            if (leftSpeed === undefined && rightSpeed !== undefined) return 1;
            if (leftSpeed !== undefined && rightSpeed === undefined) return -1;
            if (leftSpeed !== undefined && rightSpeed !== undefined && leftSpeed !== rightSpeed) {
                return rightSpeed - leftSpeed;
            }
        }
        return leftLatency - rightLatency;
    });
    const rowOccurrences = new Map<string, number>();
    const sortedResultsWithKeys = sortedResults.map(result => {
        const resultKey = getResultKey(result);
        const occurrence = rowOccurrences.get(resultKey) ?? 0;
        rowOccurrences.set(resultKey, occurrence + 1);
        return { result, resultKey, rowKey: `${resultKey}#${occurrence}` };
    });
    const selectedVisibleResults = limitedResults.filter(result => selectedResults.has(getResultKey(result)));
    const downloadSpeedTestTargets = selectedVisibleResults.length > 0 ? selectedVisibleResults : regionLimitedResults;
    const latencyTestTargets = uniqueResultsByEndpoint(selectedVisibleResults.length > 0 ? selectedVisibleResults : limitedResults);
    const areAllVisibleResultsSelected = limitedResults.length > 0
        && limitedResults.every(result => selectedResults.has(getResultKey(result)));

    const { showToast } = useToast();

    useEffect(() => () => {
        downloadControllerRef.current?.abort();
        latencyControllerRef.current?.abort();
    }, []);
    useEffect(() => {
        if (scanResults.length > 0) return;
        setSelectedResults(new Set());
        setSelectedRegions(new Set());
        setSelectedPorts(new Set());
        setLatencyMeasurements({});
        setDownloadMeasurements({});
        setResultSortMode('latency');
        filterInitialized.current = false;
        regionFilterTouched.current = false;
        portFilterTouched.current = false;
        knownRegionsRef.current.clear();
        knownPortsRef.current.clear();
        downloadControllerRef.current?.abort();
        latencyControllerRef.current?.abort();
    }, [scanResults]);

    const handleDownloadSpeedTest = async () => {
        const targets = [...downloadSpeedTestTargets];
        if (targets.length === 0) {
            showToast('当前筛选列表没有可测速的 IP', 'warning');
            return;
        }

        setResultSortMode('downloadSpeed');
        const controller = new AbortController();
        downloadControllerRef.current = controller;
        setIsDownloadTesting(true);
        setDownloadTestMessage('');
        setDownloadProgress({ completed: 0, total: targets.length, currentIp: '' });
        setDownloadMeasurements(previous => {
            const next = { ...previous };
            targets.forEach(result => { next[getResultKey(result)] = { status: 'pending' }; });
            return next;
        });

        let completed = 0;
        try {
            for (const result of targets) {
                if (controller.signal.aborted) break;
                const key = getResultKey(result);
                setDownloadProgress({ completed, total: targets.length, currentIp: result.ip });
                setDownloadMeasurements(previous => ({ ...previous, [key]: { status: 'testing' } }));

                try {
                    const speed = await measureIpDownloadSpeed(
                        result.ip,
                        result.port,
                        Number(downloadDuration),
                        controller.signal,
                    );
                    setDownloadMeasurements(previous => ({ ...previous, [key]: { status: 'done', speed } }));
                } catch (error) {
                    if (controller.signal.aborted) {
                        setDownloadMeasurements(previous => ({ ...previous, [key]: { status: 'pending' } }));
                        break;
                    }
                    setDownloadMeasurements(previous => ({
                        ...previous,
                        [key]: {
                            status: 'error',
                            error: error instanceof Error ? error.message : '测速失败',
                        },
                    }));
                }

                completed++;
                setDownloadProgress({ completed, total: targets.length, currentIp: '' });
            }
            if (controller.signal.aborted) {
                setDownloadMeasurements(previous => {
                    const next = { ...previous };
                    targets.forEach(result => {
                        const key = getResultKey(result);
                        if (next[key]?.status === 'pending') delete next[key];
                    });
                    return next;
                });
            }
            setDownloadProgress({ completed, total: targets.length, currentIp: '' });
            setDownloadTestMessage(controller.signal.aborted
                ? `已停止，完成 ${completed}/${targets.length}`
                : `测速完成，处理 ${completed}/${targets.length}`);
        } finally {
            downloadControllerRef.current = null;
            setIsDownloadTesting(false);
        }
    };

    const handleStopDownloadTest = () => downloadControllerRef.current?.abort();
    const handleStopLatencyTest = () => latencyControllerRef.current?.abort();

    const handleLatencyTest = async () => {
        if (isDownloadTesting || isLatencyTesting) return;
        const targets = [...latencyTestTargets];
        if (targets.length === 0) {
            showToast('当前筛选列表没有可复测的 IP', 'warning');
            return;
        }

        setResultSortMode('latency');
        const controller = new AbortController();
        latencyControllerRef.current = controller;
        setIsLatencyTesting(true);
        setLatencyTestMessage('');
        setLatencyProgress({ completed: 0, total: targets.length, currentIp: '' });
        setLatencyMeasurements(previous => {
            const next = { ...previous };
            targets.forEach(result => { next[getResultKey(result)] = { status: 'pending' }; });
            return next;
        });

        const completedMeasurements = new Map<string, LatencyMeasurement>();
        let cursor = 0;
        let completed = 0;
        try {
            const worker = async () => {
                while (!controller.signal.aborted) {
                    const result = targets[cursor++];
                    if (!result) return;

                    const key = getResultKey(result);
                    setLatencyProgress(previous => ({ ...previous, currentIp: result.ip }));
                    setLatencyMeasurements(previous => ({ ...previous, [key]: { status: 'testing' } }));

                    try {
                        const measurement = await measureIpLatency(
                            result.ip,
                            result.port,
                            BROWSER_LATENCY_TIMEOUT_MS,
                            controller.signal,
                        );
                        if (controller.signal.aborted) return;
                        const value: LatencyMeasurement = { status: 'done', ...measurement };
                        completedMeasurements.set(key, value);
                        setLatencyMeasurements(previous => ({ ...previous, [key]: value }));
                    } catch (error) {
                        if (controller.signal.aborted) return;
                        const value: LatencyMeasurement = {
                            status: 'done',
                            latency: -1,
                            error: error instanceof Error ? error.message : '测速失败',
                        };
                        completedMeasurements.set(key, value);
                        setLatencyMeasurements(previous => ({ ...previous, [key]: value }));
                    }

                    completed++;
                    setLatencyProgress({ completed, total: targets.length, currentIp: '' });
                }
            };

            await Promise.all(Array.from({ length: Math.min(8, targets.length) }, () => worker()));
            if (controller.signal.aborted) {
                setLatencyMeasurements(previous => {
                    const next = { ...previous };
                    targets.forEach(result => {
                        const key = getResultKey(result);
                        if (next[key]?.status === 'pending' || next[key]?.status === 'testing') delete next[key];
                    });
                    return next;
                });
            }

            setLatencyProgress({ completed, total: targets.length, currentIp: '' });
            const stoppedMessage = controller.signal.aborted ? `已停止，完成 ${completed}/${targets.length}` : '';
            const completedCount = completedMeasurements.size;
            setLatencyTestMessage(stoppedMessage || `延迟复测完成，更新 ${completedCount} 条`);
            if (completedCount > 0) {
                showToast(stoppedMessage || `延迟复测完成，更新 ${completedCount} 条`, 'success');
            }
        } finally {
            latencyControllerRef.current = null;
            setIsLatencyTesting(false);
        }
    };

    const handleSave = async () => {
        if (selectedVisibleResults.length === 0) {
            showToast('请先选择要保存的结果。', 'warning');
            return;
        }

        if (!sceneName.trim()) {
            showToast('请输入场景名称', 'warning');
            return;
        }

        setIsSaving(true);
        try{
            const dataToSave = selectedVisibleResults.map(({ isAvailable, ...rest }) => {
                const measurement = downloadMeasurements[getResultKey(rest)];
                if (measurement?.status === 'done') {
                    return { ...rest, downloadSpeedMBps: measurement.speed, downloadSpeedError: null };
                }
                if (measurement?.status === 'error') {
                    return { ...rest, downloadSpeedMBps: null, downloadSpeedError: measurement.error };
                }
                return rest;
            });
            await saveResults(sceneName.trim(), dataToSave as ScanResult[], saveMode);
            showToast(`场景 "${sceneName.trim()}" 保存成功！\n共 ${dataToSave.length} 个IP/域名\n模式: ${saveMode === 'overwrite' ? '覆盖' : '追加'}`, 'success');
            setSelectedResults(previous => {
                const next = new Set(previous);
                selectedVisibleResults.forEach(result => next.delete(getResultKey(result)));
                return next;
            });
            if (onSaveSuccess) onSaveSuccess();
        } catch (error) {
            console.error('Failed to save results:', error);
            showToast(`保存失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-3 mb-4">
                <ListFilter className="w-7 h-7 text-purple-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">IP/域名优选测速结果</h2>
            </div>
            {scanResults.length > 0 ? (
                <>
                    <div className="p-3 mb-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
                        <div className="flex items-center gap-4 mb-4 pb-3 border-b border-gray-200 dark:border-gray-600">
                            <div className="flex items-center gap-4 flex-wrap">
                                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">筛选与操作:</h3>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="latency-filter-enable"
                                        type="checkbox"
                                        checked={isLatencyFilterEnabled}
                                        onChange={(e) => {
                                            if (e.target.checked && !isLatencyFormatValid) {
                                                setLatencyFilterError('请输入有效的正整数');
                                                return;
                                            }
                                            setLatencyFilterError('');
                                            setIsLatencyFilterEnabled(e.target.checked);
                                        }}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                    <label htmlFor="latency-filter-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">延迟 ≤</label>
                                </div>                                
                                 <div className="flex items-center gap-2">
                                    <input
                                        id="latency-filter-value"
                                        type="text"
                                        value={latencyFilterValue}
                                        onChange={(e) => { setLatencyFilterValue(e.target.value); if (latencyFilterError) setLatencyFilterError(''); }}
                                        className="p-1 border rounded-md w-20 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white disabled:bg-gray-200 dark:disabled:bg-gray-800"
                                        disabled={!isLatencyFilterEnabled}
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">ms</span>
                                    {latencyFilterError && <span className="text-red-500 text-xs">{latencyFilterError}</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="region-limit-enable"
                                        type="checkbox"
                                        checked={isRegionLimitEnabled}
                                        onChange={(e) => {
                                            if (e.target.checked && !isIpsPerRegionFormatValid) {
                                                setIpsPerRegionError('请输入大于等于1的整数');
                                                return;
                                            }
                                            setIpsPerRegionError('');
                                            setIsRegionLimitEnabled(e.target.checked);
                                        }}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                    <label htmlFor="region-limit-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">每个地区保留</label>
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="ips-per-region"
                                        type="text"
                                        value={ipsPerRegion}
                                        onChange={(e) => { setIpsPerRegion(e.target.value); if (ipsPerRegionError) setIpsPerRegionError(''); }}
                                        className="p-1 border rounded-md w-20 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white disabled:bg-gray-200 dark:disabled:bg-gray-800"
                                        disabled={!isRegionLimitEnabled}
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">个</span>
                                    {ipsPerRegionError && <span className="text-red-500 text-xs">{ipsPerRegionError}</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="download-speed-filter-enable"
                                        type="checkbox"
                                        checked={isDownloadSpeedFilterEnabled}
                                        onChange={(e) => setIsDownloadSpeedFilterEnabled(e.target.checked)}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                    <label htmlFor="download-speed-filter-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">下载速度 ≥</label>
                                    <input
                                        id="minimum-download-speed"
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={minimumDownloadSpeed}
                                        onChange={(e) => setMinimumDownloadSpeed(e.target.value)}
                                        disabled={!isDownloadSpeedFilterEnabled}
                                        className="p-1 border rounded-md w-24 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white disabled:bg-gray-200 dark:disabled:bg-gray-800"
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">MB/s</span>
                                    {isDownloadSpeedFilterEnabled && !isMinimumDownloadSpeedValid && (
                                        <span className="text-xs text-red-500">请输入不小于 0 的速度值</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">按地区筛选</h3>
                            <div className="flex items-center gap-3">
                                <button 
                                    onClick={() => {
                                        regionFilterTouched.current = false;
                                        setSelectedRegions(new Set(uniqueRegions));
                                    }}
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                                >
                                    全选
                                </button>
                                <button 
                                    onClick={() => {
                                        regionFilterTouched.current = true;
                                        setSelectedRegions(new Set());
                                    }}
                                    className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                                >
                                    清空
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {uniqueRegions.map(region => {
                                const countForRegion = regionCounts[region] || 0;
                                const displayCount = isRegionLimitEnabled ? Math.min(countForRegion, effectiveIpsPerRegion) : countForRegion;
                                const isSelected = selectedRegions.has(region);
                                return (
                                    <button
                                        key={region}
                                        type="button"
                                        onClick={() => {
                                            regionFilterTouched.current = true;
                                            const newSet = new Set(selectedRegions);
                                            if (newSet.has(region)) {
                                                newSet.delete(region);
                                            } else {
                                                newSet.add(region);
                                            }
                                            setSelectedRegions(newSet);
                                        }}
                                        className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                                            isSelected
                                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                                : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                        }`}
                                    >
                                        <RegionDisplay colo={region} flagSize="xs" /> <span>({displayCount})</span>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="flex items-center justify-between mb-2 mt-4">
                            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">按端口筛选</h3>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => {
                                        portFilterTouched.current = false;
                                        setSelectedPorts(new Set(uniquePorts.map(String)));
                                    }}
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                                >
                                    全选
                                </button>
                                <button
                                    onClick={() => {
                                        portFilterTouched.current = true;
                                        setSelectedPorts(new Set());
                                    }}
                                    className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                                >
                                    清空
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {uniquePorts.map((port) => {
                                const portStr = String(port);
                                const isSelected = selectedPorts.has(portStr);
                                return (
                                    <button
                                        key={port}
                                        type="button"
                                        onClick={() => {
                                            portFilterTouched.current = true;
                                            const newSet = new Set(selectedPorts);
                                            if (newSet.has(portStr)) {
                                                newSet.delete(portStr);
                                            } else {
                                                newSet.add(portStr);
                                            }
                                            setSelectedPorts(newSet);
                                        }}
                                        className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                                            isSelected
                                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                                : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                        }`}
                                    >
                                        {port} <span className="opacity-60">({portCounts[portStr] || 0})</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="mb-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-3">
                            <label htmlFor="download-test-duration" className="text-sm text-gray-600 dark:text-gray-300">单 IP 取样</label>
                            <select
                                id="download-test-duration"
                                value={downloadDuration}
                                onChange={(e) => setDownloadDuration(e.target.value)}
                                disabled={isDownloadTesting || isLatencyTesting}
                                className="p-1.5 border rounded-md text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white disabled:opacity-60"
                            >
                                <option value="3000">3 秒</option>
                                <option value="5000">5 秒</option>
                                <option value="10000">10 秒</option>
                            </select>
                            {isDownloadTesting ? (
                                <button
                                    type="button"
                                    onClick={handleStopDownloadTest}
                                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-700 bg-red-100 rounded hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900"
                                >
                                    <StopCircle className="w-4 h-4" />
                                    停止测速
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleDownloadSpeedTest}
                                    disabled={isLatencyTesting || downloadSpeedTestTargets.length === 0}
                                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                                >
                                    <Gauge className="w-4 h-4" />
                                    下载测速 ({downloadSpeedTestTargets.length})
                                </button>
                            )}
                            {isLatencyTesting ? (
                                <button
                                    type="button"
                                    onClick={handleStopLatencyTest}
                                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-700 bg-red-100 rounded hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900"
                                >
                                    <StopCircle className="w-4 h-4" />
                                    停止测延迟
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleLatencyTest}
                                    disabled={isDownloadTesting || isSaving || latencyTestTargets.length === 0}
                                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-teal-600 rounded hover:bg-teal-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                                >
                                    <RefreshCw className="w-4 h-4" />
                                    测延迟 ({latencyTestTargets.length})
                                </button>
                            )}
                        </div>
                        {(isDownloadTesting || downloadTestMessage || isLatencyTesting || latencyTestMessage) && (
                            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-gray-600 dark:text-gray-300" aria-live="polite">
                                {(isDownloadTesting || downloadTestMessage) && (
                                    <span role="status">
                                        {isDownloadTesting
                                            ? `下载测速 ${downloadProgress.completed}/${downloadProgress.total}${downloadProgress.currentIp ? ` · ${downloadProgress.currentIp}` : ''}`
                                            : downloadTestMessage}
                                    </span>
                                )}
                                {(isLatencyTesting || latencyTestMessage) && (
                                    <span role="status">
                                        {isLatencyTesting
                                            ? `延迟复测 ${latencyProgress.completed}/${latencyProgress.total}${latencyProgress.currentIp ? ` · ${latencyProgress.currentIp}` : ''}`
                                            : latencyTestMessage}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0">
                            <tr>
                                <th className="px-4 py-3 text-left">
                                    <input
                                        type="checkbox"
                                        aria-label="全选当前筛选结果"
                                        checked={areAllVisibleResultsSelected}
                                        disabled={limitedResults.length === 0}
                                        onChange={(e) => {
                                            const checked = e.target.checked;
                                            setSelectedResults(previous => {
                                                const next = new Set(previous);
                                                limitedResults.forEach(result => {
                                                    const key = getResultKey(result);
                                                    if (checked) next.add(key);
                                                    else next.delete(key);
                                                });
                                                return next;
                                            });
                                        }}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">IP/域名</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">端口</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">延迟 (ms)</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">下载速度 (MB/s)</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {sortedResultsWithKeys.map(({ result, resultKey, rowKey }) => {
                                const { ip, port, latency, colo, domain, downloadSpeedMBps, downloadSpeedError } = result;
                                const measurement = downloadMeasurements[resultKey];
                                const latencyMeasurement = latencyMeasurements[resultKey];
                                const measuredSpeed = measurement?.status === 'done'
                                    ? measurement.speed
                                    : measurement?.status === 'error'
                                        ? undefined
                                        : (typeof downloadSpeedMBps === 'number' ? downloadSpeedMBps : undefined);
                                return (
                                <tr key={rowKey} className="hover:bg-gray-100 dark:hover:bg-gray-700">
                                    <td className="px-4 py-2">
                                        <input
                                            type="checkbox"
                                            aria-label={`选择 ${ip}:${port}`}
                                            checked={selectedResults.has(getResultKey({ ip, port }))}
                                            onChange={(e) => {
                                                const checked = e.target.checked;
                                                setSelectedResults(previous => {
                                                    const next = new Set(previous);
                                                    const key = getResultKey({ ip, port });
                                                    if (checked) next.add(key);
                                                    else next.delete(key);
                                                    return next;
                                                });
                                            }}
                                            className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                        />
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-white">
                                        {ip}
                                        {domain && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">域名</span>}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{port}</td>
                                    <td className={`px-6 py-4 whitespace-nowrap text-sm font-bold ${getLatencyColor(latency)}`}>
                                        {latencyMeasurement?.status === 'testing'
                                            ? '复测中...'
                                            : latencyMeasurement?.status === 'pending'
                                                ? '待复测'
                                                : latency > -1
                                                    ? `${latency}ms`
                                                    : <span title={latencyMeasurement?.error || '延迟测试失败'}>N/A</span>}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-700 dark:text-gray-200">
                                        {measurement?.status === 'testing' ? '测速中...' :
                                                    measurement?.status === 'error' ? <span title={measurement.error}>测速失败</span> :
                                                measurement?.status === 'pending' ? '待测速' :
                                                    typeof measuredSpeed === 'number' ? `${measuredSpeed.toFixed(2)} MB/s` :
                                                        (downloadSpeedError ? <span title={downloadSpeedError}>测速失败</span> : '-')}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{colo ? <RegionDisplay colo={colo} flagSize="sm" /> : '-'}</td>
                                </tr>
                            );
                            })}
                        </tbody>
                    </table>
                </div>
           
                <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center gap-3 mb-4">
                        <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200">保存结果</h3>
                        <span className="px-2.5 py-0.5 bg-green-100 text-green-800 text-sm font-semibold rounded-full dark:bg-green-900 dark:text-green-300">IP {limitedResults.filter(r => !r.domain).length} 个</span>
                        <span className="px-2.5 py-0.5 bg-indigo-100 text-indigo-800 text-sm font-semibold rounded-full dark:bg-indigo-900 dark:text-indigo-300">域名 {limitedResults.filter(r => r.domain).length} 个</span>
                        <span className="text-sm text-gray-600 dark:text-gray-300">已选 {selectedVisibleResults.length} 个</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="relative" ref={sceneInputRef}>
                            <input 
                                id="scene-name"
                                type="text" 
                                value={sceneName}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    setSceneName(v);
                                    // 自行输入内容后隐藏下拉，清空则重新展开
                                    setSceneDropdownOpen(v.trim() === '');
                                }}
                                onFocus={() => setSceneDropdownOpen(true)}
                                placeholder="场景名称，例如: 家庭电信"
                                className="p-2 border rounded-md w-64 dark:bg-gray-600 dark:border-gray-500 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                            {sceneDropdownOpen && (
                                <div className="absolute z-30 mt-1 w-64 max-h-56 overflow-auto rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg p-2">
                                    {sceneOptions.length > 0 ? (
                                        <div className="flex flex-wrap gap-1.5">
                                            {sceneOptions.map((name) => (
                                                <button
                                                    key={name}
                                                    type="button"
                                                    onClick={() => { setSceneName(name); setSceneDropdownOpen(false); }}
                                                    className="px-2.5 py-1 text-xs font-medium rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60 transition-colors"
                                                >
                                                    {name}
                                                </button>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="px-1 py-2 text-xs text-gray-400 dark:text-gray-500">
                                            暂无已保存场景
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        
                        <div className="relative flex w-fit items-center rounded-lg bg-gray-100 p-1 dark:bg-gray-700 border border-gray-200 dark:border-gray-600">
                            <button
                                onClick={() => setSaveMode('overwrite')}
                                className={`relative z-10 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                                    saveMode === 'overwrite'
                                        ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                        : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                                }`}
                            >
                                覆盖同场景数据
                            </button>
                            <button
                                onClick={() => setSaveMode('append')}
                                className={`relative z-10 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                                    saveMode === 'append'
                                        ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                        : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                                }`}
                            >
                                追加到旧数据
                            </button>
                        </div>

                        <button
                            onClick={handleSave}
                            disabled={isSaving || isDownloadTesting || isLatencyTesting || selectedVisibleResults.length === 0 || !sceneName.trim()}
                            className="flex items-center bg-blue-600 text-white font-bold py-2 px-6 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                        >
                            <Save className="w-4 h-4 mr-2" />
                            {isSaving ? '保存中...' : `保存选中 (${selectedVisibleResults.length})`}
                        </button>
                    </div>
                </div>
                </>
            ) : (
                <p className="text-gray-500 dark:text-gray-400 text-center">暂无测试结果数据</p>
            )}
        </div>
    );
}
