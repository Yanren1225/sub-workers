import type { UpstreamSubscription } from './subscription';

export interface AggregatedSubscription {
  proxies: unknown[];
  proxyNames: string[];
  headers: Record<string, string>;
}

// 机场塞进节点列表的展示用伪节点（官网/流量/到期），实际指向 192.0.2.1:1
const INFO_PROXY_PATTERN = /^(?:官网|已用流量|剩余流量|套餐到期)\s*[:：]/;

/** 同名节点依次加 " 2"、" 3" 后缀；返回改名后的最终名称，供 filter 分组使用 */
const renameDuplicateProxyNames = (proxies: unknown[]): string[] => {
  // 先收集所有原始名称，避免后缀恰好撞上后面才出现的原始名称
  const originals = new Set<string>();
  for (const proxy of proxies) {
    if (typeof proxy === 'object' && proxy !== null && 'name' in proxy && typeof proxy.name === 'string') {
      originals.add(proxy.name);
    }
  }

  const used = new Set<string>();
  const names: string[] = [];

  for (const proxy of proxies) {
    if (typeof proxy !== 'object' || proxy === null || !('name' in proxy) || typeof proxy.name !== 'string') {
      continue;
    }

    const original = proxy.name;
    let name = original;

    if (used.has(original)) {
      let suffix = 2;
      while (used.has(`${original} ${suffix}`) || originals.has(`${original} ${suffix}`)) {
        suffix += 1;
      }
      name = `${original} ${suffix}`;
    }

    used.add(name);
    originals.add(name);
    proxy.name = name;
    names.push(name);
  }

  return names;
};

const TRAFFIC_HEADERS = ['subscription-userinfo', 'profile-update-interval', 'profile-web-page-url'] as const;

const pickSubscriptionHeaders = (headers: Headers): Record<string, string> => {
  const picked: Record<string, string> = {};

  for (const key of TRAFFIC_HEADERS) {
    const value = headers.get(key);
    if (value) picked[key] = value;
  }

  return picked;
};

type SubscriptionUserInfo = Partial<Record<'upload' | 'download' | 'total' | 'expire', number>>;

const USER_INFO_FIELDS = ['upload', 'download', 'total', 'expire'] as const;

const parseSubscriptionUserInfo = (headers: Headers): SubscriptionUserInfo | null => {
  const raw = headers.get('subscription-userinfo');
  if (!raw) return null;

  const info: SubscriptionUserInfo = {};

  for (const segment of raw.split(';')) {
    const separator = segment.indexOf('=');
    if (separator === -1) continue;

    const key = segment.slice(0, separator).trim();
    const rawValue = segment.slice(separator + 1).trim();
    if (rawValue === '' || !(USER_INFO_FIELDS as readonly string[]).includes(key)) continue;

    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) continue;

    info[key as keyof SubscriptionUserInfo] = value;
  }

  return info;
};

/** 只成功一个来源时原样转发；多个来源时聚合流量信息 */
const mergeSubscriptionHeaders = (sources: Headers[]): Record<string, string> => {
  if (sources.length === 0) return {};
  if (sources.length === 1) return pickSubscriptionHeaders(sources[0]);

  const merged: Record<string, string> = {};

  const infos = sources
    .map((source) => parseSubscriptionUserInfo(source))
    .filter((info): info is SubscriptionUserInfo => info !== null);

  // 任一来源缺失或无法解析该头时，省略整个 subscription-userinfo
  if (infos.length === sources.length) {
    const fields: string[] = [];

    for (const field of ['upload', 'download'] as const) {
      if (infos.every((info) => info[field] !== undefined)) {
        fields.push(`${field}=${infos.reduce((sum, info) => sum + (info[field] ?? 0), 0)}`);
      }
    }

    // total 为 0 表示不限量，无法相加
    if (infos.every((info) => (info.total ?? 0) > 0)) {
      fields.push(`total=${infos.reduce((sum, info) => sum + (info.total ?? 0), 0)}`);
    }

    // 取最晚到期的来源
    if (infos.every((info) => (info.expire ?? 0) > 0)) {
      fields.push(`expire=${Math.max(...infos.map((info) => info.expire ?? 0))}`);
    }

    if (fields.length > 0) {
      merged['subscription-userinfo'] = fields.join('; ');
    }
  }

  const intervals = sources
    .map((source) => source.get('profile-update-interval'))
    .flatMap((value) => {
      const trimmed = value?.trim();
      if (!trimmed) return [];
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? [parsed] : [];
    });
  if (intervals.length > 0) {
    merged['profile-update-interval'] = String(Math.min(...intervals));
  }

  const pageUrl = sources.map((source) => source.get('profile-web-page-url')).find((value) => value);
  if (pageUrl) {
    merged['profile-web-page-url'] = pageUrl;
  }

  return merged;
};

/** 合并多个上游：按输入顺序拼接节点、剔除伪节点、同名加后缀，并聚合流量头 */
export const aggregateSubscriptions = (sources: UpstreamSubscription[]): AggregatedSubscription => {
  const proxies = sources
    .flatMap((source) => source.proxies)
    .filter((proxy) => {
      if (typeof proxy !== 'object' || proxy === null || !('name' in proxy)) return true;
      return typeof proxy.name !== 'string' || !INFO_PROXY_PATTERN.test(proxy.name);
    });
  const proxyNames = renameDuplicateProxyNames(proxies);
  const headers = mergeSubscriptionHeaders(sources.map((source) => source.headers));

  return { proxies, proxyNames, headers };
};
