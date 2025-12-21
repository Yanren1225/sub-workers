import clashTemplate from './clash.yaml';

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

    if (path === AllowedPaths.CLASH) {
      config = clashTemplate;
      contextType = 'application/x-yaml; charset=utf-8';
    } else {
      return new Response(`Path ${url.pathname} not found, Use ${Object.values(AllowedPaths).join(', ')}`, { status: 404 });
    }

    config = config.replace('__SUB_URL__', REAL_SUB_URL);

    const headers: Record<string, string> = {
      'Content-Type': isBrowser ? 'text/plain; charset=utf-8' : contextType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    /// 浏览器的话就直接浏览了
    if (!isBrowser) {
      headers['Content-Disposition'] = `attachment; filename=${path}`;
    }

    const subResponse = await fetch(REAL_SUB_URL, {
      headers: {
        'User-Agent': 'clash-verge',
      },
    });

    /// 处理剩余流量等信息
    const trafficHeaders = ['subscription-userinfo', 'content-disposition', 'profile-update-interval', 'profile-web-page-url'];

    trafficHeaders.forEach((header) => {
      const value = subResponse.headers.get(header);
      if (value) {
        headers[header] = value;
      }
    });

    return new Response(config, { headers });
  },
} satisfies ExportedHandler<Env>;
