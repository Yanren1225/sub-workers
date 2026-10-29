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

/** 单个上游订阅：节点原样保留，响应头用于聚合流量信息 */
export interface UpstreamSubscription {
  proxies: unknown[];
  headers: Headers;
}

// REAL_SUB_URL 支持换行或逗号分隔的多个上游；URL 内字面逗号需编码为 %2C
export const parseSubscriptionUrls = (raw: string): string[] => {
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

/** 并行拉取所有上游；部分失败只告警，全部失败才抛错 */
export const fetchSubscriptions = async (urls: string[]): Promise<UpstreamSubscription[]> => {
  if (urls.length === 0) {
    throw new Error('REAL_SUB_URL is empty');
  }

  const results = await Promise.allSettled(urls.map((url) => fetchUpstreamSubscription(url)));
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

  return successful;
};
