import { useEffect, useState, type FormEvent } from 'react';
import { CloudflareIps, getCloudflareIps, saveCustomIpCidrs, syncCloudflareIps } from '../api';
import { Cloud, RotateCw, Plus, Trash2 } from 'lucide-react';
import { normalizeIpv4Cidr } from '../utils/ipRange';
import { useToast } from './Toast';

interface CloudflareIpListProps {
    onDataLoaded: (data: CloudflareIps) => void;
}

type RangeTab = 'cf' | 'cm' | 'custom';

export function CloudflareIpList({ onDataLoaded }: CloudflareIpListProps) {
    const [cfIps, setCfIps] = useState<CloudflareIps | null>(null);
    const [loading, setLoading] = useState(false);
    const [customCidrInput, setCustomCidrInput] = useState('');
    const [isSavingCustom, setIsSavingCustom] = useState(false);
    const [activeTab, setActiveTab] = useState<RangeTab>('cf');
    const { showToast } = useToast();

    const loadData = async (retryCount = 3) => {
        setLoading(true);
        for (let attempt = 1; attempt <= retryCount; attempt++) {
            try {
                const cfData = await getCloudflareIps();
                setCfIps(cfData);
                if (cfData) onDataLoaded(cfData);
                setLoading(false);
                return;
            } catch (err) {
                console.error(`Failed to fetch Cloudflare IPs (attempt ${attempt}/${retryCount})`, err);
                if (attempt < retryCount) {
                    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
                } else {
                    showToast('获取 IP 段失败，可点击同步按钮重试', 'error');
                }
            } finally {
                if (attempt === retryCount) setLoading(false);
            }
        }
    };

    const handleSync = async () => {
        setLoading(true);
        try {
            const data = await syncCloudflareIps();
            setCfIps(data);
            onDataLoaded(data);
            showToast('IP 段同步完成', 'success');
        } catch (err) {
            showToast('同步 IP 段失败', 'error');
        } finally {
            setLoading(false);
        }
    };

    const persistCustomCidrs = async (nextCidrs: string[]) => {
        setIsSavingCustom(true);
        try {
            const data = await saveCustomIpCidrs(nextCidrs);
            setCfIps(data);
            onDataLoaded(data);
            return true;
        } catch (error) {
            console.error('Failed to save custom IP ranges:', error);
            showToast('保存自定义 IP 段失败', 'error');
            return false;
        } finally {
            setIsSavingCustom(false);
        }
    };

    const handleAddCustomCidr = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const cidr = normalizeIpv4Cidr(customCidrInput);
        if (!cidr) {
            showToast('请输入有效 IPv4 地址或 CIDR，例如 203.0.113.0/24', 'warning');
            return;
        }

        const customCidrs = cfIps?.custom_ipv4_cidrs || [];
        if (customCidrs.includes(cidr)) {
            showToast('该 IP 段已经添加', 'warning');
            return;
        }
        if (await persistCustomCidrs([...customCidrs, cidr])) setCustomCidrInput('');
    };

    const handleDeleteCustomCidr = async (cidr: string) => {
        const customCidrs = cfIps?.custom_ipv4_cidrs || [];
        await persistCustomCidrs(customCidrs.filter(item => item !== cidr));
    };

    useEffect(() => {
        void loadData();
    }, []);

    const customCidrs = cfIps?.custom_ipv4_cidrs || [];
    const tabItems: { id: RangeTab; label: string; count: number }[] = [
        { id: 'cf', label: 'CF 官方', count: cfIps?.ipv4_cidrs?.length || 0 },
        { id: 'cm', label: 'CM 整理', count: cfIps?.cm_cidrs?.length || 0 },
        { id: 'custom', label: '自定义', count: customCidrs.length },
    ];
    const visibleCidrs = activeTab === 'cf'
        ? cfIps?.ipv4_cidrs || []
        : activeTab === 'cm'
            ? cfIps?.cm_cidrs || []
            : customCidrs;

    return (
        <section className="mb-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800 sm:p-6">
            <header className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                        <Cloud className="h-5 w-5" />
                    </span>
                    <div>
                        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">IP 段</h2>
                        <p className="text-xs text-gray-500 dark:text-gray-400">管理测速使用的 IPv4 网段</p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => void handleSync()}
                    disabled={loading || isSavingCustom}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-gray-300 px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    title="同步 CF 官方和 CM 整理网段"
                >
                    <RotateCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    {loading ? '同步中' : '同步网段'}
                </button>
            </header>

            <div className="mt-5 border-b border-gray-200 dark:border-gray-700">
                <div className="flex gap-5 overflow-x-auto" role="tablist" aria-label="IP 段来源">
                    {tabItems.map(tab => (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`-mb-px flex-none border-b-2 px-1 pb-2.5 text-sm transition-colors ${activeTab === tab.id
                                ? 'border-sky-600 font-semibold text-sky-700 dark:border-sky-400 dark:text-sky-300'
                                : 'border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'
                                }`}
                        >
                            {tab.label}<span className="ml-2 text-xs tabular-nums text-gray-400">{tab.count}</span>
                        </button>
                    ))}
                </div>
            </div>

            <div className="pt-4" role="tabpanel">
                {activeTab === 'custom' && (
                    <form onSubmit={handleAddCustomCidr} className="mb-4 flex flex-col gap-2 sm:flex-row">
                        <label htmlFor="custom-ip-cidr" className="sr-only">自定义 IPv4 或 CIDR</label>
                        <input
                            id="custom-ip-cidr"
                            type="text"
                            value={customCidrInput}
                            onChange={event => setCustomCidrInput(event.target.value)}
                            placeholder="203.0.113.0/24 或 203.0.113.10"
                            disabled={loading || isSavingCustom}
                            className="h-10 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 font-mono text-sm text-gray-800 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                        />
                        <button
                            type="submit"
                            disabled={loading || isSavingCustom || !customCidrInput.trim()}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-sky-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500"
                        >
                            <Plus className="h-4 w-4" />
                            添加网段
                        </button>
                    </form>
                )}

                {visibleCidrs.length > 0 ? (
                    <ul className="max-h-52 divide-y divide-gray-100 overflow-y-auto pr-1 dark:divide-gray-700">
                        {visibleCidrs.map(cidr => (
                            <li key={cidr} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
                                <code className="min-w-0 break-all text-sm text-gray-700 dark:text-gray-200">{cidr}</code>
                                {activeTab === 'custom' && (
                                    <button
                                        type="button"
                                        onClick={() => void handleDeleteCustomCidr(cidr)}
                                        disabled={loading || isSavingCustom}
                                        aria-label={`删除 ${cidr}`}
                                        title={`删除 ${cidr}`}
                                        className="flex h-8 w-8 flex-none items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-red-900/30 dark:hover:text-red-300"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="py-5 text-center text-sm text-gray-500 dark:text-gray-400">
                        {activeTab === 'custom' ? '还没有自定义网段' : loading ? '正在加载网段…' : '暂无网段数据'}
                    </p>
                )}
            </div>
        </section>
    );
}
