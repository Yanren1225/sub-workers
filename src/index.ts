import clashTemplate from './clash.yaml';
import loonTemplate from './loon.conf';
import yaml from 'js-yaml';

enum AllowedPaths {
  CLASH = 'clash',
  LOON = 'loon',
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
    } else if (path === AllowedPaths.LOON) {
      config = await parseLoonConfig(REAL_SUB_URL);
      contextType = 'text/plain; charset=utf-8';
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

const parseClashConfig = async (REAL_SUB_URL: string) => {
  const subResponse = await fetch(REAL_SUB_URL, {
    headers: {
      'User-Agent': 'clash-verge',
    },
  });

  const subContent = await subResponse.text();
  const subConfig = yaml.load(subContent) as any;

  const templateConfig = yaml.load(clashTemplate) as any;

  templateConfig['proxies'] = subConfig['proxies'] || [];

  const proxyNames = templateConfig['proxies'].map((proxy: any) => proxy.name);

  const updatedProxyGroups = templateConfig['proxy-groups'].map((group: any) => {
    if (group.use) {
      delete group.use;

      // 根据 filter 过滤节点
      if (group.filter) {
        const pattern = group.filter.replace(/\(\?i\)/g, '');
        const regex = new RegExp(pattern);
        group.proxies = proxyNames.filter((name: string) => regex.test(name));
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

const parseLoonConfig = async (REAL_SUB_URL: string) => {
  // 构建 Loon 配置
  let config = loonTemplate;

  config = config.replace('__SUB__', REAL_SUB_URL);

  return config;
};
