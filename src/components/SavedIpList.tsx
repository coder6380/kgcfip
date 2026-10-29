import { useState, useEffect, useRef } from 'react';
import { getScenes, getSceneResults, saveResults } from '../api';
import { BROWSER_LATENCY_TIMEOUT_MS, getLatencyColor, measureIpDownloadSpeed, measureIpLatency, ScanResult } from '../utils/scanner';
import { getColoName } from '../utils/colo';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog'; // Import Trash2 and RotateCw
import { Gauge, ListChecks, Trash2, RotateCw, FileText, File, Copy, StopCircle } from 'lucide-react';
import { RegionDisplay } from './RegionDisplay';

// Type for data stored in KV, which does not include `isAvailable`
interface SavedIpData {
    ip: string;
    port: number;
    latency: number;
    colo?: string;
    domain?: boolean; // 是否为域名源
    error?: string;
    downloadSpeedMBps?: number | null;
    downloadSpeedError?: string | null;
}
interface FlatIpItem extends SavedIpData {
    sceneName: string;
}

type SavedMeasurement = {
    status: 'pending' | 'testing' | 'done' | 'error';
    speed?: number;
    error?: string;
};

type SavedLatencyMeasurement = {
    status: 'pending' | 'testing' | 'done';
    latency?: number;
    colo?: string;
    error?: string;
};

const getSavedResultKey = (item: Pick<FlatIpItem, 'ip' | 'port' | 'sceneName'>) =>
    `${item.ip}:${item.port}#${item.sceneName}`;

export function SavedIpList() {
    const [items, setItems] = useState<FlatIpItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedScenes, setSelectedScenes] = useState<Set<string>>(new Set());
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const [downloadDuration, setDownloadDuration] = useState('3000');
    const [isDownloadTesting, setIsDownloadTesting] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState({ completed: 0, total: 0, currentIp: '' });
    const [downloadTestMessage, setDownloadTestMessage] = useState('');
    const [downloadMeasurements, setDownloadMeasurements] = useState<Record<string, SavedMeasurement>>({});
    const [isLatencyTesting, setIsLatencyTesting] = useState(false);
    const [latencyProgress, setLatencyProgress] = useState({ completed: 0, total: 0, currentIp: '' });
    const [latencyTestMessage, setLatencyTestMessage] = useState('');
    const [latencyMeasurements, setLatencyMeasurements] = useState<Record<string, SavedLatencyMeasurement>>({});
    const downloadControllerRef = useRef<AbortController | null>(null);
    const latencyControllerRef = useRef<AbortController | null>(null);
    const { showToast } = useToast();
    const { confirm } = useConfirm();

    const loadData = async () => {
        setLoading(true);
        setItems([]); // Clear items before loading to avoid confusion
        try {
            // 1. 获取所有场景名
            const scenes = await getScenes();
            
            // 2. 并行获取所有场景的详细数据
            const promises = scenes.map(async (scene) => {
                try {
                    const results = await getSceneResults(scene.name);
                    return results.map(r => ({ ...r, sceneName: scene.name }));
                } catch (e) {
                    console.error(`Failed to load scene ${scene.name}`, e);
                    return [];
                }
            });

            const resultsArray = await Promise.all(promises);
            // 3. 扁平化数组
            const allItems = resultsArray.flat();
            setItems(allItems);
            setSelectedScenes(new Set(allItems.map(i => i.sceneName)));
        } catch (e) {
            console.error('Failed to load saved IPs', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, []);

    useEffect(() => () => {
        downloadControllerRef.current?.abort();
        latencyControllerRef.current?.abort();
    }, []);

    const uniqueScenes = Array.from(new Set(items.map(i => i.sceneName))).sort();
    const filteredItems = items.filter(i => selectedScenes.has(i.sceneName));
    const filteredItemsSorted = [...filteredItems].sort((a, b) => {
        return a.latency - b.latency;
    });
    const selectedTestItems = filteredItemsSorted.filter(item => selectedItems.has(getSavedResultKey(item)));
    const testTargets = selectedTestItems.length > 0 ? selectedTestItems : filteredItemsSorted;
    const isAnyTesting = isDownloadTesting || isLatencyTesting;

    const handleDownloadSpeedTest = async () => {
        if (isAnyTesting) return;
        const targets = [...testTargets];
        if (targets.length === 0) {
            showToast('当前场景筛选没有可测速的 IP', 'warning');
            return;
        }

        const controller = new AbortController();
        downloadControllerRef.current = controller;
        setIsDownloadTesting(true);
        setDownloadTestMessage('');
        setDownloadProgress({ completed: 0, total: targets.length, currentIp: '' });
        setDownloadMeasurements(previous => {
            const next = { ...previous };
            targets.forEach(item => { next[getSavedResultKey(item)] = { status: 'pending' }; });
            return next;
        });

        const completedMeasurements = new Map<string, SavedMeasurement>();
        let completed = 0;
        try {
            for (const item of targets) {
                if (controller.signal.aborted) break;
                const key = getSavedResultKey(item);
                setDownloadProgress({ completed, total: targets.length, currentIp: item.ip });
                setDownloadMeasurements(previous => ({ ...previous, [key]: { status: 'testing' } }));

                try {
                    const speed = await measureIpDownloadSpeed(
                        item.ip,
                        item.port,
                        Number(downloadDuration),
                        controller.signal,
                    );
                    const measurement: SavedMeasurement = { status: 'done', speed };
                    completedMeasurements.set(key, measurement);
                    setDownloadMeasurements(previous => ({ ...previous, [key]: measurement }));
                } catch (error) {
                    if (controller.signal.aborted) {
                        setDownloadMeasurements(previous => ({ ...previous, [key]: { status: 'pending' } }));
                        break;
                    }
                    const measurement: SavedMeasurement = {
                        status: 'error',
                        error: error instanceof Error ? error.message : '测速失败',
                    };
                    completedMeasurements.set(key, measurement);
                    setDownloadMeasurements(previous => ({ ...previous, [key]: measurement }));
                }

                completed++;
                setDownloadProgress({ completed, total: targets.length, currentIp: '' });
            }

            if (controller.signal.aborted) {
                setDownloadMeasurements(previous => {
                    const next = { ...previous };
                    targets.forEach(item => {
                        const key = getSavedResultKey(item);
                        if (next[key]?.status === 'pending') delete next[key];
                    });
                    return next;
                });
            }

            const scenesToUpdate = new Set(
                targets.filter(item => completedMeasurements.has(getSavedResultKey(item))).map(item => item.sceneName),
            );
            let updatedItems = items;
            let savedCount = 0;
            let failedScenes = 0;

            for (const scene of scenesToUpdate) {
                const sceneResults = items.filter(item => item.sceneName === scene).map(item => {
                    const { sceneName, ...result } = item;
                    const measurement = completedMeasurements.get(getSavedResultKey(item));
                    if (!measurement) return result;
                    if (measurement.status === 'done') {
                        return {
                            ...result,
                            downloadSpeedMBps: measurement.speed,
                            downloadSpeedError: null,
                        };
                    }
                    return {
                        ...result,
                        downloadSpeedMBps: null,
                        downloadSpeedError: measurement.error || '测速失败',
                    };
                });

                try {
                    await saveResults(scene, sceneResults as ScanResult[], 'overwrite');
                    const sceneUpdates = new Map(sceneResults.map(result => [`${result.ip}:${result.port}`, result]));
                    updatedItems = updatedItems.map(item => {
                        if (item.sceneName !== scene) return item;
                        const result = sceneUpdates.get(`${item.ip}:${item.port}`);
                        return result ? { ...result, sceneName: scene } : item;
                    });
                    savedCount += items.filter(item =>
                        item.sceneName === scene && completedMeasurements.has(getSavedResultKey(item)),
                    ).length;
                } catch (error) {
                    failedScenes++;
                    console.error(`Failed to save download measurements for scene ${scene}`, error);
                }
            }

            if (scenesToUpdate.size > 0) setItems(updatedItems);
            setDownloadProgress({ completed, total: targets.length, currentIp: '' });
            const stoppedMessage = controller.signal.aborted ? `已停止，完成 ${completed}/${targets.length}` : '';
            if (failedScenes > 0) {
                setDownloadTestMessage(`${stoppedMessage ? `${stoppedMessage}；` : ''}有 ${failedScenes} 个场景保存失败`);
                showToast(`测速完成，部分场景未能保存`, 'error');
            } else if (savedCount > 0) {
                setDownloadTestMessage(stoppedMessage || `测速完成，已保存 ${savedCount} 个结果`);
                showToast(`下载测速完成，已保存 ${savedCount} 个结果`, 'success');
            } else {
                setDownloadTestMessage(stoppedMessage || '测速未产生可保存结果');
            }
        } finally {
            downloadControllerRef.current = null;
            setIsDownloadTesting(false);
        }
    };

    const handleLatencyTest = async () => {
        if (isAnyTesting) return;
        const targets = [...testTargets];
        if (targets.length === 0) {
            showToast('当前场景筛选没有可测速的 IP', 'warning');
            return;
        }

        const controller = new AbortController();
        latencyControllerRef.current = controller;
        setIsLatencyTesting(true);
        setLatencyTestMessage('');
        setLatencyProgress({ completed: 0, total: targets.length, currentIp: '' });
        setLatencyMeasurements(previous => {
            const next = { ...previous };
            targets.forEach(item => { next[getSavedResultKey(item)] = { status: 'pending' }; });
            return next;
        });

        const completedMeasurements = new Map<string, SavedLatencyMeasurement>();
        let cursor = 0;
        let completed = 0;

        try {
            const worker = async () => {
                while (!controller.signal.aborted) {
                    const item = targets[cursor++];
                    if (!item) return;

                    const key = getSavedResultKey(item);
                    setLatencyProgress(previous => ({ ...previous, currentIp: item.ip }));
                    setLatencyMeasurements(previous => ({ ...previous, [key]: { status: 'testing' } }));

                    let result: SavedLatencyMeasurement;
                    try {
                        const measurement = await measureIpLatency(
                            item.ip,
                            item.port,
                            BROWSER_LATENCY_TIMEOUT_MS,
                            controller.signal,
                        );
                        if (controller.signal.aborted) return;
                        result = { status: 'done', ...measurement };
                    } catch (error) {
                        if (controller.signal.aborted) return;
                        result = {
                            status: 'done',
                            latency: -1,
                            error: error instanceof Error ? error.message : '测速失败',
                        };
                    }

                    completedMeasurements.set(key, result);
                    setLatencyMeasurements(previous => ({ ...previous, [key]: result }));
                    completed++;
                    setLatencyProgress({ completed, total: targets.length, currentIp: '' });
                }
            };

            await Promise.all(Array.from({ length: Math.min(8, targets.length) }, () => worker()));

            if (controller.signal.aborted) {
                setLatencyMeasurements(previous => {
                    const next = { ...previous };
                    targets.forEach(item => {
                        const key = getSavedResultKey(item);
                        if (next[key]?.status === 'pending' || next[key]?.status === 'testing') delete next[key];
                    });
                    return next;
                });
            }

            const scenesToUpdate = new Set(
                targets.filter(item => completedMeasurements.has(getSavedResultKey(item))).map(item => item.sceneName),
            );
            let updatedItems = items;
            let savedCount = 0;
            let failedScenes = 0;

            for (const scene of scenesToUpdate) {
                const sceneResults = items.filter(item => item.sceneName === scene).map(item => {
                    const { sceneName, ...result } = item;
                    const measurement = completedMeasurements.get(getSavedResultKey(item));
                    if (!measurement) return result;
                    const latency = measurement.latency ?? -1;
                    return {
                        ...result,
                        latency,
                        colo: latency > 0 && measurement.colo && measurement.colo !== '-'
                            ? measurement.colo
                            : result.colo,
                        error: measurement.error || undefined,
                    };
                });

                try {
                    await saveResults(scene, sceneResults as ScanResult[], 'overwrite');
                    const sceneUpdates = new Map(sceneResults.map(result => [`${result.ip}:${result.port}`, result]));
                    updatedItems = updatedItems.map(item => {
                        if (item.sceneName !== scene) return item;
                        const result = sceneUpdates.get(`${item.ip}:${item.port}`);
                        return result ? { ...result, sceneName: scene } : item;
                    });
                    savedCount += targets.filter(item =>
                        item.sceneName === scene && completedMeasurements.has(getSavedResultKey(item)),
                    ).length;
                } catch (error) {
                    failedScenes++;
                    console.error(`Failed to save latency measurements for scene ${scene}`, error);
                }
            }

            if (scenesToUpdate.size > 0) setItems(updatedItems);
            setLatencyProgress({ completed, total: targets.length, currentIp: '' });
            const stoppedMessage = controller.signal.aborted ? `已停止，完成 ${completed}/${targets.length}` : '';
            if (failedScenes > 0) {
                setLatencyTestMessage(`${stoppedMessage ? `${stoppedMessage}；` : ''}有 ${failedScenes} 个场景保存失败`);
                showToast('延迟测试完成，部分场景保存失败', 'error');
            } else if (savedCount > 0) {
                setLatencyTestMessage(stoppedMessage || `延迟测试完成，已更新 ${savedCount} 条`);
                showToast(`延迟测试完成，已更新 ${savedCount} 条`, 'success');
            } else {
                setLatencyTestMessage(stoppedMessage || '没有完成的延迟测试结果');
            }
        } finally {
            latencyControllerRef.current = null;
            setIsLatencyTesting(false);
        }
    };

    const handleStopDownloadTest = () => downloadControllerRef.current?.abort();
    const handleStopLatencyTest = () => latencyControllerRef.current?.abort();

    const handleCheckboxChange = (id: string, checked: boolean) => {
        const newSet = new Set(selectedItems);
        if (checked) newSet.add(id);
        else newSet.delete(id);
        setSelectedItems(newSet);
    };

    const handleSelectAll = (checked: boolean) => {
        const newSet = new Set(selectedItems);
        filteredItems.forEach(item => {
            const id = `${item.ip}:${item.port}#${item.sceneName}`;
            if (checked) newSet.add(id);
            else newSet.delete(id);
        });
        setSelectedItems(newSet);
    };

    const handleDeleteSelected = async () => {
        if (selectedItems.size === 0 || isAnyTesting) return;
        const isConfirmed = await confirm(`确定要删除选中的 ${selectedItems.size} 个IP/域名吗？`, {
            confirmText: '确定删除',
        });
        if (!isConfirmed) return;

        setLoading(true);
        try {
            const scenesToUpdate = new Set<string>();
            items.forEach(item => {
                if (selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`)) {
                    scenesToUpdate.add(item.sceneName);
                }
            });

            for (const scene of scenesToUpdate) {
                const sceneItems = items.filter(i => i.sceneName === scene);
                const keepItems = sceneItems.filter(item => !selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`));

                const resultsToSave = keepItems.map(({ sceneName, ...rest }) => rest);
                await saveResults(scene, resultsToSave as ScanResult[], 'overwrite');
            }
            setSelectedItems(new Set());
            await loadData();
        } catch (e) {
            showToast('删除失败', 'error');
            setLoading(false);
        }
    };

    const handleExportCsv = () => {
        if (filteredItemsSorted.length === 0) {
            showToast('没有可导出的数据', 'warning');
            return;
        }

        const headers = ['IP地址', '端口', '延迟(ms)', '下载速度(MB/s)', '测速失败原因', '地区代码', '地区名称', '场景'];
        const csvContent = [
            headers.join(','),
            ...filteredItemsSorted.map(item => [
                item.ip,
                item.port,
                item.latency,
                typeof item.downloadSpeedMBps === 'number' ? item.downloadSpeedMBps.toFixed(2) : '',
                item.downloadSpeedError || '',
                item.colo || '',
                getColoName(item.colo || ''),
                item.sceneName,
            ].map(field => {
                const stringField = String(field);
                // Escape quotes and wrap in quotes if contains comma, quote or newline
                if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
                    return `"${stringField.replace(/"/g, '""')}"`;
                }
                return stringField;
            }).join(','))
        ].join('\n');

        // Add BOM for Excel compatibility
        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `ip_list_export_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleExportTxt = async () => {
        if (filteredItemsSorted.length === 0) {
            showToast('没有可导出的数据', 'warning');
            return;
        }

        try {
            let txtContent = '';
            for (const item of filteredItemsSorted) {
                const regionName = getColoName(item.colo || '');
                const sceneName = item.sceneName;
                const latency = `${item.latency}ms`;
                const comment = `${regionName}|${sceneName}|${latency}`;
                txtContent += `${item.ip}:${item.port}#${comment}\n`;
            }

            // Create a new file with the TXT data.
            const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', `ip_list_export_${new Date().toISOString().slice(0, 10)}.txt`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

        } catch (error) {
            console.error('Failed to export to TXT:', error);
            showToast(`导出TXT失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error');
        }
    };

    const handleCopyToClipboard = () => {
        if (filteredItemsSorted.length === 0) {
            showToast('没有可复制的数据', 'warning');
            return;
        }

        let txtContent = '';
        for (const item of filteredItemsSorted) {
            const regionName = getColoName(item.colo || '').replace(/^(\p{Regional_Indicator}+)\s+/u, '$1');
            const sceneName = item.sceneName;
            const latency = `${item.latency}ms`;
            const comment = `${regionName}|${sceneName}|${latency}`;
            txtContent += `${item.ip}:${item.port}#${comment}\n`;
        }

        navigator.clipboard.writeText(txtContent).then(() => {
            showToast('已复制到剪贴板', 'success');
        }).catch(err => {
            console.error('Failed to copy to clipboard:', err);
            showToast('复制失败，请检查浏览器权限', 'error');
        });
    };


    const isAllSelected = filteredItems.length > 0 && filteredItems.every(item => selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`));

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex flex-col gap-4 mb-4">
                <div className="flex items-center justify-between flex-wrap gap-4">
                    <div className="flex items-center gap-3">
                        <ListChecks className="w-7 h-7 text-green-500" />
                        <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">已保存的 IP/域名 列表</h2>
                        <span className="px-2.5 py-0.5 bg-green-100 text-green-800 text-sm font-semibold rounded-full dark:bg-green-900 dark:text-green-300">{items.length} 个IP/域名</span>
                    </div>
                    <div className="flex items-center gap-4">
                        <button
                            onClick={loadData}
                            disabled={loading || isAnyTesting}
                            className="px-4 py-1.5 text-sm font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <RotateCw className="w-4 h-4 mr-1 inline-block" />
                            刷新
                        </button>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">场景过滤:</span>
                    <div className="flex flex-wrap items-center gap-2">
                        {uniqueScenes.map(scene => {
                            const isSelected = selectedScenes.has(scene);
                            return (
                                <button
                                    key={scene}
                                    type="button"
                                    onClick={() => {
                                        const newSet = new Set(selectedScenes);
                                        if (newSet.has(scene)) newSet.delete(scene);
                                        else newSet.add(scene);
                                        setSelectedScenes(newSet);
                                    }}
                                    disabled={isAnyTesting}
                                    className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                                        isSelected
                                            ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                            : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                    }`}
                                >
                                        {scene}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex items-center gap-3 ml-auto">
                            <button
                                type="button"
                                onClick={() => setSelectedScenes(new Set(uniqueScenes))}
                                disabled={isAnyTesting}
                                className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                            >
                                全选
                            </button>
                            <button
                                type="button"
                                onClick={() => setSelectedScenes(new Set())}
                                disabled={isAnyTesting}
                                className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                            >
                                清空
                            </button>
                        </div>
                </div>
            </div>

            <div className="mb-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2.5">
                    <label htmlFor="saved-download-duration" className="text-sm text-gray-600 dark:text-gray-300">单 IP 取样</label>
                    <select
                        id="saved-download-duration"
                        value={downloadDuration}
                        onChange={(e) => setDownloadDuration(e.target.value)}
                        disabled={isAnyTesting}
                        className="p-1.5 border rounded-md text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white disabled:opacity-60"
                    >
                        <option value="3000">3 秒</option>
                        <option value="5000">5 秒</option>
                        <option value="10000">10 秒</option>
                    </select>
                    {selectedItems.size > 0 && (
                        <button
                            type="button"
                            onClick={handleDeleteSelected}
                            disabled={isAnyTesting}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-800 bg-red-100 rounded hover:bg-red-200 dark:bg-red-900 dark:text-red-300 dark:hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <Trash2 className="w-4 h-4" />
                            删除选中 ({selectedItems.size})
                        </button>
                    )}
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
                            disabled={loading || isLatencyTesting || testTargets.length === 0}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                        >
                            <Gauge className="w-4 h-4" />
                            下载测速 ({testTargets.length})
                        </button>
                    )}
                    {isLatencyTesting ? (
                        <button
                            type="button"
                            onClick={handleStopLatencyTest}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-700 bg-red-100 rounded hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900"
                        >
                            <StopCircle className="w-4 h-4" />
                            停止延迟测试
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={handleLatencyTest}
                            disabled={loading || isDownloadTesting || testTargets.length === 0}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-teal-600 rounded hover:bg-teal-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                        >
                            <Gauge className="w-4 h-4" />
                            测延迟 ({testTargets.length})
                        </button>
                    )}
                </div>
                {(isDownloadTesting || downloadTestMessage || isLatencyTesting || latencyTestMessage) && (
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-gray-600 dark:text-gray-300" aria-live="polite">
                        {(isDownloadTesting || downloadTestMessage) && (
                            <span role="status">
                                {isDownloadTesting
                                    ? `测速 ${downloadProgress.completed}/${downloadProgress.total}${downloadProgress.currentIp ? ` · ${downloadProgress.currentIp}` : ''}`
                                    : downloadTestMessage}
                            </span>
                        )}
                        {(isLatencyTesting || latencyTestMessage) && (
                            <span role="status">
                                {isLatencyTesting
                                    ? `延迟 ${latencyProgress.completed}/${latencyProgress.total}${latencyProgress.currentIp ? ` · ${latencyProgress.currentIp}` : ''}`
                                    : latencyTestMessage}
                            </span>
                        )}
                    </div>
                )}
            </div>

            <div className="overflow-auto" style={{ maxHeight: '600px' }}>
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0 z-10">
                        <tr>
                            <th className="px-4 py-3 text-left">
                                <input 
                                    type="checkbox" 
                                    checked={isAllSelected}
                                    onChange={(e) => handleSelectAll(e.target.checked)}
                                    className="rounded text-purple-600 focus:ring-purple-500 h-4 w-4"
                                />
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">IP/域名</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">端口</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">延迟</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">下载速度 (MB/s)</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区代码</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">场景</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                        {loading ? (
                            <tr><td colSpan={8} className="px-4 py-4 text-center text-gray-500">加载中...</td></tr>
                        ) : filteredItems.length === 0 ? (
                            <tr><td colSpan={8} className="px-4 py-4 text-center text-gray-500">暂无数据</td></tr>
                        ) : (
                            filteredItemsSorted.map((item) => (
                                <tr key={`${item.ip}-${item.port}-${item.sceneName}`} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                    <td className="px-4 py-2">
                                        <input 
                                            type="checkbox"
                                            checked={selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`)}
                                            onChange={(e) => handleCheckboxChange(`${item.ip}:${item.port}#${item.sceneName}`, e.target.checked)}
                                            className="rounded text-purple-600 focus:ring-purple-500 h-4 w-4"
                                        />
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-white">
                                        {item.ip}
                                        {item.domain && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">域名</span>}
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.port}</td>
                                    <td className={`px-4 py-2 whitespace-nowrap text-sm font-semibold ${getLatencyColor(latencyMeasurements[getSavedResultKey(item)]?.latency ?? item.latency)}`}>
                                        {(() => {
                                            const measurement = latencyMeasurements[getSavedResultKey(item)];
                                            if (measurement?.status === 'testing') return '测速中...';
                                            if (measurement?.status === 'pending') return '待测速';
                                            const latency = measurement?.latency ?? item.latency;
                                            if (latency > -1) return `${latency}ms`;
                                            const error = measurement?.error || item.error;
                                            return error ? <span title={error}>失败</span> : 'N/A';
                                        })()}
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700 dark:text-gray-200">
                                        {(() => {
                                            const measurement = downloadMeasurements[getSavedResultKey(item)];
                                            if (measurement?.status === 'testing') return '测速中...';
                                            if (measurement?.status === 'pending') return '待测速';
                                            if (measurement?.status === 'error') {
                                                return <span title={measurement.error}>测速失败</span>;
                                            }
                                            if (typeof measurement?.speed === 'number') return `${measurement.speed.toFixed(2)} MB/s`;
                                            if (item.downloadSpeedError) return <span title={item.downloadSpeedError}>测速失败</span>;
                                            return typeof item.downloadSpeedMBps === 'number'
                                                ? `${item.downloadSpeedMBps.toFixed(2)} MB/s`
                                                : '-';
                                        })()}
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.colo || '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.colo ? <RegionDisplay colo={item.colo} flagSize="sm" /> : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.sceneName}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>

            </div>
            <div className="mt-8 flex justify-center gap-4">
                    <button onClick={handleExportCsv} className="flex items-center px-4 py-2 font-bold text-white bg-green-600 rounded hover:bg-green-700 transition-colors">
                        <File className="w-4 h-4 mr-2" />
                        导出 CSV
                    </button>
                    <button onClick={handleExportTxt} className="flex items-center px-4 py-2 font-bold text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors">
                         <FileText className="w-4 h-4 mr-2" />
                        导出 TXT
                    </button>
                    <button onClick={handleCopyToClipboard} className="flex items-center px-4 py-2 font-bold text-white bg-purple-600 rounded hover:bg-purple-700 transition-colors">
                        <Copy className="w-4 h-4 mr-2" />
                        复制
                    </button>
            </div>
        </div>
    );
}
