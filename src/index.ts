import { aggregateSubscriptions } from './aggregate';
import { buildClashConfig } from './build-config';
import { fetchSubscriptions, parseSubscriptionUrls } from './subscription';

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
        const sources = await fetchSubscriptions(REAL_SUB_URLS);
        const { proxies, proxyNames, headers: subHeaders } = aggregateSubscriptions(sources);
        config = buildClashConfig(proxies, proxyNames);
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
