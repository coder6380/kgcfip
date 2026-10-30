import { normalizeIpv4Cidr } from '../../src/utils/ipRange.ts';

interface Env {
    IP_KV: KVNamespace;
}

// Define types for better safety
interface CloudflareIPsResponse {
    result: {
        ipv4_cidrs: string[];
        ipv6_cidrs: string[];
        etag: string;
    };
    success: boolean;
    errors: any[];
    messages: any[];
}

interface StoredCloudflareIPs {
    ipv4_cidrs: string[];
    cm_cidrs: string[];
    custom_ipv4_cidrs?: string[];
    etag: string;
}

// Helper for JSON responses
const jsonResponse = (data: any, status = 200, headers: HeadersInit = {}) => {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...headers, 'Content-Type': 'application/json' },
    });
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { env } = context;
    try {
        const cached = await env.IP_KV.get<StoredCloudflareIPs>("CF_IPS_DATA", "json");
        return jsonResponse(cached ? {
            ...cached,
            custom_ipv4_cidrs: cached.custom_ipv4_cidrs || [],
        } : null);
    } catch (e) {
        return jsonResponse({ message: (e as Error).message }, 500);
    }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { env } = context;
    try {
        const cached = await env.IP_KV.get<StoredCloudflareIPs>("CF_IPS_DATA", "json");

        const headers: HeadersInit = {};
        if (cached?.etag) {
            headers['If-None-Match'] = cached.etag;
        }

        const [cfResp, cmResp] = await Promise.all([
            fetch("https://api.cloudflare.com/client/v4/ips", { headers }),
            fetch("https://raw.githubusercontent.com/cmliu/cmliu/main/CF-CIDR.txt")
        ]);

        if (!cfResp.ok) throw new Error(`Cloudflare API request failed with status ${cfResp.status}`);

        const data = await cfResp.json<CloudflareIPsResponse>();
        
        let cmCidrs: string[] = [];
        if (cmResp.ok) {
            const text = await cmResp.text();
            cmCidrs = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        }

        if (data.success) {
            const result = {
                ipv4_cidrs: data.result.ipv4_cidrs,
                cm_cidrs: cmCidrs,
                custom_ipv4_cidrs: cached?.custom_ipv4_cidrs || [],
                etag: data.result.etag
            };
            await env.IP_KV.put("CF_IPS_DATA", JSON.stringify(result));
            return jsonResponse(result);
        }
        return jsonResponse({ message: "Failed to fetch from Cloudflare API", errors: data.errors }, 500);
    } catch (e) {
        return jsonResponse({ message: (e as Error).message }, 500);
    }
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
    const { request, env } = context;
    try {
        const body = await request.json() as { custom_ipv4_cidrs?: unknown };
        if (!Array.isArray(body.custom_ipv4_cidrs) || body.custom_ipv4_cidrs.length > 500) {
            return jsonResponse({ message: '自定义网段格式无效' }, 400);
        }

        const normalized: string[] = [];
        for (const value of body.custom_ipv4_cidrs) {
            if (typeof value !== 'string') return jsonResponse({ message: '自定义网段必须是 IPv4 或 CIDR 文本' }, 400);
            const cidr = normalizeIpv4Cidr(value);
            if (!cidr) return jsonResponse({ message: `无效的 IPv4/CIDR: ${value}` }, 400);
            normalized.push(cidr);
        }

        const cached = await env.IP_KV.get<StoredCloudflareIPs>('CF_IPS_DATA', 'json');
        const updated: StoredCloudflareIPs = {
            ipv4_cidrs: cached?.ipv4_cidrs || [],
            cm_cidrs: cached?.cm_cidrs || [],
            etag: cached?.etag || '',
            custom_ipv4_cidrs: Array.from(new Set(normalized)),
        };
        await env.IP_KV.put('CF_IPS_DATA', JSON.stringify(updated));
        return jsonResponse(updated);
    } catch (error) {
        return jsonResponse({ message: (error as Error).message }, 500);
    }
};
