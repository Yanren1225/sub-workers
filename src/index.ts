import clashTemplate from './clash.yaml';
import yaml from 'js-yaml';

enum AllowedPaths {
  CLASH = 'clash',
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const SECRET_KEY = env.SECRET_KEY;
    const REAL_SUB_URL = env.REAL_SUB_URL;
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
        const { config: parsedConfig, headers: subHeaders } = await parseClashConfig(REAL_SUB_URL);
        config = parsedConfig;
        contextType = 'application/x-yaml; charset=utf-8';

        /// 处理剩余流量等信息
        const trafficHeaders = ['subscription-userinfo', 'profile-update-interval', 'profile-web-page-url'];

        trafficHeaders.forEach((header) => {
          const value = subHeaders.get(header);
          if (value) {
            headers[header] = value;
          }
        });
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

const parseClashConfig = async (REAL_SUB_URL: string) => {
  const subResponse = await fetch(REAL_SUB_URL, {
    headers: {
      'User-Agent': 'clash-verge',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!subResponse.ok) {
    throw new Error(`upstream subscription responded with ${subResponse.status}`);
  }

  const subContent = await subResponse.text();
  const parsedSubscription = yaml.load(subContent);

  // 订阅内容来自网络：只读取用到的字段，形状不符时按空处理
  const rawProxies =
    typeof parsedSubscription === 'object' && parsedSubscription !== null && 'proxies' in parsedSubscription
      ? parsedSubscription.proxies
      : undefined;
  const upstreamProxies: unknown[] = Array.isArray(rawProxies) ? rawProxies : [];

  if (upstreamProxies.length === 0) {
    throw new Error('upstream subscription contains no proxies');
  }

  // clashTemplate 是本仓库内的固定文件，按已知结构使用
  const templateConfig = yaml.load(clashTemplate) as TemplateConfig;

  templateConfig.proxies = upstreamProxies;

  const proxyNames: string[] = [];
  for (const proxy of upstreamProxies) {
    if (typeof proxy === 'object' && proxy !== null && 'name' in proxy && typeof proxy.name === 'string') {
      proxyNames.push(proxy.name);
    }
  }

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

  return { config: yaml.dump(templateConfig), headers: subResponse.headers };
};
