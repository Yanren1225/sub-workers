import clashTemplate from './clash.yaml';
import yaml from 'js-yaml';

/**
 * 上游配置里像 `7e833397` 这样的标量是字符串（REALITY short-id、密码等），mihomo 的
 * yaml.v3 也把它当字符串。js-yaml 默认会解析成 Infinity，再 dump 就变成 `.inf`，
 * 内核会以 "invalid REALITY short ID" 拒绝整个配置；超出安全整数范围的数字同样会被
 * 静默改写。这里只接受能无损往返的数字，其余标量保持字符串（dump 时自动加引号）。
 */
const DECIMAL_INT_PATTERN = /^[-+]?[0-9]+$/;
const DECIMAL_FLOAT_PATTERN =
  /^(?:[-+]?(?:[0-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?)$/;

const upstreamSchema = yaml.DEFAULT_SCHEMA.extend({
  implicit: [
    new yaml.Type('tag:yaml.org,2002:int', {
      kind: 'scalar',
      resolve: (data) => {
        if (data === null) return false;
        const normalized = data.replace(/_/g, '');
        if (!DECIMAL_INT_PATTERN.test(normalized)) return false;
        const value = Number(normalized);
        return Number.isSafeInteger(value) && String(value) === normalized.replace(/^\+/, '');
      },
      construct: (data) => Number(data.replace(/_/g, '')),
    }),
    new yaml.Type('tag:yaml.org,2002:float', {
      kind: 'scalar',
      resolve: (data) => {
        if (data === null) return false;
        const normalized = data.replace(/_/g, '');
        // 整数形态交给 int 类型处理，避免无损检查失败的整数又被 float 兜底转换
        if (DECIMAL_INT_PATTERN.test(normalized) || !DECIMAL_FLOAT_PATTERN.test(normalized)) return false;
        const value = Number(normalized);
        return Number.isFinite(value) && String(value) === normalized.replace(/^\+/, '');
      },
      construct: (data) => Number(data.replace(/_/g, '')),
    }),
    // Clash 配置里日期样式的标量（节点名、密码等）不是时间戳
    new yaml.Type('tag:yaml.org,2002:timestamp', {
      kind: 'scalar',
      resolve: () => false,
      construct: () => null,
    }),
  ],
});

enum AllowedPaths {
  CLASH = 'clash',
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const SECRET_KEY = env.SECRET_KEY;
    const REAL_SUB_URLS = parseSubscriptionUrls(env.REAL_SUB_URL);
    const userAgent = request.headers.get('User-Agent') || '';
    const isBrowser = /Mozilla|Chrome|Safari|Firefox|Edge/i.test(userAgent);

    if (url.searchParams.get('key') !== SECRET_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    const path = url.pathname.replace('/', '').toLowerCase();

    let config = '';
    let contextType = 'text/plain; charset=utf-8';
    let headers: Record<string, string> = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    if (path === AllowedPaths.CLASH) {
      try {
        const { config: parsedConfig, headers: subHeaders } = await parseClashConfig(REAL_SUB_URLS);
        config = parsedConfig;
        contextType = 'application/x-yaml; charset=utf-8';

        /// 处理剩余流量等信息
        headers = { ...headers, ...subHeaders };
      } catch (error) {
        // 返回非 2xx，客户端（Clash Verge / mihomo）会保留旧配置而不是写入空节点配置
        const message = error instanceof Error ? error.message : String(error);
        return new Response(`Failed to build clash config: ${message}`, { status: 502 });
      }
    } else {
      return new Response(`Path ${url.pathname} not found, Use ${Object.values(AllowedPaths).join(', ')}`, { status: 404 });
    }

    headers['Content-Type'] = isBrowser ? 'text/plain; charset=utf-8' : contextType;

    // 浏览器的话就直接浏览了
    if (!isBrowser) {
      headers['Content-Disposition'] = `attachment; filename=${path}`;
    }

    return new Response(config, { headers });
  },
} satisfies ExportedHandler<Env>;

/** 模板里的代理组：本流程只读写 use / filter / proxies */
interface TemplateProxyGroup {
  name?: string;
  use?: string[];
  filter?: string;
  proxies?: string[];
}

interface TemplateConfig {
  /** 上游节点原样透传，只有 name 会被读取 */
  proxies?: unknown[];
  'proxy-groups'?: TemplateProxyGroup[];
  'proxy-providers'?: unknown;
  [key: string]: unknown;
}

// REAL_SUB_URL 支持换行或逗号分隔的多个上游；URL 内字面逗号需编码为 %2C
const parseSubscriptionUrls = (raw: string): string[] => {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const part of raw.split(/[\r\n,]+/)) {
    const url = part.trim();
    if (url === '' || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
};

/** 单个上游订阅：节点原样保留，响应头用于聚合流量信息 */
interface UpstreamSubscription {
  proxies: unknown[];
  headers: Headers;
}

const fetchUpstreamSubscription = async (url: string): Promise<UpstreamSubscription> => {
  const subResponse = await fetch(url, {
    headers: {
      'User-Agent': 'clash-verge',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!subResponse.ok) {
    throw new Error(`upstream subscription responded with ${subResponse.status}`);
  }

  const subContent = await subResponse.text();
  const parsedSubscription = yaml.load(subContent, { schema: upstreamSchema });

  // 订阅内容来自网络：只读取用到的字段，形状不符时按空处理
  const rawProxies =
    typeof parsedSubscription === 'object' && parsedSubscription !== null && 'proxies' in parsedSubscription
      ? parsedSubscription.proxies
      : undefined;
  const proxies: unknown[] = Array.isArray(rawProxies) ? rawProxies : [];

  if (proxies.length === 0) {
    throw new Error('upstream subscription contains no proxies');
  }

  return { proxies, headers: subResponse.headers };
};

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

// 机场塞进节点列表的展示用伪节点（官网/流量/到期），实际指向 192.0.2.1:1
const INFO_PROXY_PATTERN = /^(?:官网|已用流量|剩余流量|套餐到期)\s*[:：]/;

const parseClashConfig = async (REAL_SUB_URLS: string[]) => {
  if (REAL_SUB_URLS.length === 0) {
    throw new Error('REAL_SUB_URL is empty');
  }

  const results = await Promise.allSettled(REAL_SUB_URLS.map((url) => fetchUpstreamSubscription(url)));
  const successful: UpstreamSubscription[] = [];
  const failures: string[] = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successful.push(result.value);
      return;
    }

    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(`#${index + 1}: ${message}`);
    // 不记录 URL：订阅链接里含 token
    console.warn(`upstream subscription #${index + 1} failed: ${message}`);
  });

  if (successful.length === 0) {
    throw new Error(`all upstream subscriptions failed: ${failures.join('; ')}`);
  }

  // 节点顺序：按配置顺序拼接，各来源内部保持上游顺序；剔除展示用伪节点
  const upstreamProxies: unknown[] = successful
    .flatMap((source) => source.proxies)
    .filter((proxy) => {
      if (typeof proxy !== 'object' || proxy === null || !('name' in proxy)) return true;
      return typeof proxy.name !== 'string' || !INFO_PROXY_PATTERN.test(proxy.name);
    });
  const proxyNames = renameDuplicateProxyNames(upstreamProxies);
  const subHeaders = mergeSubscriptionHeaders(successful.map((source) => source.headers));

  // clashTemplate 是本仓库内的固定文件，按已知结构使用
  const templateConfig = yaml.load(clashTemplate) as TemplateConfig;

  templateConfig.proxies = upstreamProxies;

  const groups = templateConfig['proxy-groups'] ?? [];
  const updatedProxyGroups = groups.map((group) => {
    if (group.use) {
      delete group.use;

      // 根据 filter 过滤节点
      if (group.filter) {
        // JS 不支持内联 (?i)，大小写不敏感改用 flags
        const pattern = group.filter.replace(/\(\?i\)/g, '');
        const regex = new RegExp(pattern, 'i');
        const matched = proxyNames.filter((name) => regex.test(name));

        // 过滤后为空会让客户端出现空组，回退为全部节点
        if (matched.length === 0) {
          console.warn(`proxy group "${group.name}" filter matched no node, falling back to all nodes`);
        }
        group.proxies = matched.length > 0 ? matched : [...proxyNames];
      } else {
        // 没有 filter 就使用所有节点
        group.proxies = [...proxyNames];
      }
    }
    return group;
  });

  templateConfig['proxy-groups'] = updatedProxyGroups;

  delete templateConfig['proxy-providers'];

  return { config: yaml.dump(templateConfig), headers: subHeaders };
};
