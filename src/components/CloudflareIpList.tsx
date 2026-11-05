import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CloudflareIps, getCloudflareIps, saveCustomIpCidrs, syncCloudflareIps } from '../api';
import { Cloud, RotateCw, Save } from 'lucide-react';
import { parseIpv4CidrList } from '../utils/ipRange';
import { toggleLineComments } from '../utils/textEditor';
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
                if (cfData) {
                    setCustomCidrInput(cfData.custom_ipv4_cidr_text ?? (cfData.custom_ipv4_cidrs || []).join('\n'));
                    onDataLoaded(cfData);
                }
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

    const persistCustomCidrs = async (nextCidrs: string[], sourceText: string) => {
        setIsSavingCustom(true);
        try {
            const data = await saveCustomIpCidrs(nextCidrs, sourceText);
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

    const handleSaveCustomCidrs = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const { cidrs, invalidEntries, duplicateCount } = parseIpv4CidrList(customCidrInput);

        if (invalidEntries.length > 0) {
            showToast(`有 ${invalidEntries.length} 项格式无效，请修正后再保存`, 'warning');
            return;
        }

        if (cidrs.length > 500) {
            showToast('自定义网段最多保存 500 段', 'warning');
            return;
        }

        if (!await persistCustomCidrs(cidrs, customCidrInput)) return;

        const message = duplicateCount
            ? `已保存 ${cidrs.length} 段，跳过重复 ${duplicateCount} 项`
            : `已保存 ${cidrs.length} 段`;
        showToast(message, 'success');
    };

    const handleCustomCidrKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        const isSlashKey = event.code === 'Slash' || event.key === '/' || event.key === '?';
        if (!event.ctrlKey || !isSlashKey || event.repeat) return;

        event.preventDefault();
        const textarea = event.currentTarget;
        const result = toggleLineComments(customCidrInput, textarea.selectionStart, textarea.selectionEnd);
        if (!result) return;

        setCustomCidrInput(result.text);
        requestAnimationFrame(() => {
            textarea.setSelectionRange(result.selectionStart, result.selectionEnd, textarea.selectionDirection || 'none');
        });
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
                    <form onSubmit={handleSaveCustomCidrs} className="mb-4 space-y-3">
                        <label htmlFor="custom-ip-cidr" className="sr-only">编辑自定义 IPv4 网段</label>
                        <textarea
                            id="custom-ip-cidr"
                            value={customCidrInput}
                            onChange={event => setCustomCidrInput(event.target.value)}
                            onKeyDown={handleCustomCidrKeyDown}
                            placeholder={'每行一个 IPv4 地址或 CIDR，例如：\n203.0.113.0/24\n198.51.100.0/24\n# 以 # 开头的行不会扫描'}
                            disabled={loading || isSavingCustom}
                            rows={12}
                            className="block max-h-96 min-h-60 w-full resize-y rounded-md border border-gray-300 bg-white px-3 py-2.5 font-mono text-sm leading-6 text-gray-800 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="min-w-0 flex-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
                                已保存 {customCidrs.length} 段。删除行后保存即可批量删除；# 注释行不会扫描。选中多行按 Ctrl + / 注释或恢复。
                            </p>
                            <button
                                type="submit"
                                disabled={loading || isSavingCustom}
                                className="inline-flex h-10 flex-none items-center justify-center gap-2 rounded-md bg-sky-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500"
                            >
                                <Save className="h-4 w-4" />
                                {isSavingCustom ? '保存中' : '保存网段'}
                            </button>
                        </div>
                    </form>
                )}

                {activeTab !== 'custom' && visibleCidrs.length > 0 ? (
                    <ul className="max-h-52 divide-y divide-gray-100 overflow-y-auto pr-1 dark:divide-gray-700">
                        {visibleCidrs.map(cidr => (
                            <li key={cidr} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
                                <code className="min-w-0 break-all text-sm text-gray-700 dark:text-gray-200">{cidr}</code>
                            </li>
                        ))}
                    </ul>
                ) : activeTab !== 'custom' ? (
                    <p className="py-5 text-center text-sm text-gray-500 dark:text-gray-400">
                        {loading ? '正在加载网段…' : '暂无网段数据'}
                    </p>
                ) : null}
            </div>
        </section>
    );
}
