/** Canonical public routes. Keep these independent of the Pages asset lookup. */
export const PAGE_ROUTES = Object.freeze({
  '/': '/index.html', '/signup': '/signup.html', '/signin': '/signin.html',
  '/reset-password': '/reset-password.html',
  '/client/dashboard': '/dashboard-client.html', '/client/projects': '/dashboard-client.html',
  '/client/rfqs': '/dashboard-client.html', '/client/quotations': '/dashboard-client.html',
  '/client/messages': '/dashboard-client.html', '/client/settings': '/dashboard-client.html',
  '/vendor/dashboard': '/dashboard-vendor.html', '/vendor/invitations': '/dashboard-vendor.html',
  '/vendor/quotations': '/dashboard-vendor.html', '/vendor/awards': '/dashboard-vendor.html',
  '/vendor/messages': '/dashboard-vendor.html', '/vendor/settings': '/dashboard-vendor.html',
  '/admin/dashboard': '/dashboard-admin.html', '/admin/vendors': '/dashboard-admin.html',
  '/admin/users': '/dashboard-admin.html', '/admin/rfqs': '/dashboard-admin.html',
  '/admin/awards': '/dashboard-admin.html', '/admin/invoices': '/dashboard-admin.html',
  '/admin/stats': '/dashboard-admin.html', '/admin/settings': '/dashboard-admin.html',
  '/rfq/new': '/public-rfq.html', '/how': '/how.html', '/vendors': '/vendors.html',
  '/client': '/client.html', '/about': '/about.html', '/contact': '/contact.html',
  '/privacy': '/privacy.html', '/cookies': '/cookies.html',
  '/terms/client': '/terms-client.html', '/terms/vendor': '/terms-vendor.html'
});

const LEGACY = Object.freeze({
  '/index.html': '/', '/signup.html': '/signup', '/signin.html': '/signin',
  '/reset-password.html': '/reset-password', '/dashboard-client.html': '/client/dashboard',
  '/dashboard-vendor.html': '/vendor/dashboard', '/dashboard-admin.html': '/admin/dashboard',
  '/public-rfq.html': '/rfq/new', '/how.html': '/how', '/vendors.html': '/vendors',
  '/client.html': '/client', '/about.html': '/about', '/contact.html': '/contact',
  '/privacy.html': '/privacy', '/cookies.html': '/cookies',
  '/terms-client.html': '/terms/client', '/terms-vendor.html': '/terms/vendor',
  '/login': '/signin', '/login.html': '/signin', '/register': '/signup', '/register.html': '/signup',
  '/join': '/signup', '/join.html': '/signup', '/contractor': '/signup', '/contractor.html': '/signup',
  '/app': '/', '/app.html': '/', '/desk': '/signin', '/desk.html': '/signin',
  '/dashboard': '/signin', '/dashboard.html': '/signin', '/admin': '/admin/dashboard',
  '/admin.html': '/admin/dashboard', '/vendor.html': '/vendor/dashboard',
  '/rfq': '/rfq/new', '/rfq.html': '/rfq/new', '/quote': '/rfq/new', '/quote.html': '/rfq/new',
  '/get-quotes': '/rfq/new', '/get-quotes.html': '/rfq/new',
  '/terms': '/terms/client', '/terms.html': '/terms/client',
  '/vendor-terms.html': '/terms/vendor', '/client-terms.html': '/terms/client',
  '/legal/terms.html': '/terms/client', '/legal/vendor-terms.html': '/terms/vendor',
  '/legal/client-terms.html': '/terms/client', '/favicon.ico': '/assets/favicon.png'
});

function redirect(url, path) {
  return new Response(null, { status: 308, headers: { Location: path + url.search } });
}

function embedded(asset, cache, status = 200) {
  const body = asset.encoding === 'base64'
    ? Uint8Array.from(atob(asset.body), c => c.charCodeAt(0)) : asset.body;
  return new Response(body, { status, headers: {
    'Content-Type': asset.contentType || 'application/octet-stream',
    'Cache-Control': cache
  }});
}

function missing(path, assets) {
  const isPage = path === '/' || !/\.[a-z\d]+$/i.test(path) || /\.html?$/i.test(path);
  if (isPage && assets['/404.html']) return embedded(assets['/404.html'], 'no-store', 404);
  return new Response(isPage ? '<!doctype html><title>Page not found | Urban Procures</title><h1>Page not found</h1><a href="/">Home</a>' : 'Not found', {
    status: 404, headers: { 'Content-Type': isPage ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export async function serveStatic(pathname, request, env = {}, assets = {}) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  if (pathname.startsWith('/api/')) return missing(pathname, assets);
  const path = pathname !== '/' ? pathname.replace(/\/+$/, '') : '/';
  if (path !== pathname) return redirect(url, path);
  const legacy = LEGACY[path];
  if (legacy) return redirect(url, legacy);

  const assetPath = PAGE_ROUTES[path] || (path.startsWith('/assets/') || /^\/(?:css|js)\//.test(path) ||
    ['/robots.txt', '/sitemap.xml', '/build-stamp.json', '/.well-known/webmcp.json'].includes(path) ? path : null);
  if (!assetPath) return missing(path, assets);
  const asset = assets[assetPath];
  const cache = assetPath.endsWith('.html') ? 'no-store' : 'public, max-age=3600';
  if (asset) return embedded(asset, cache);
  if (env.ASSETS?.fetch) {
    const response = await env.ASSETS.fetch(new Request(new URL(assetPath + url.search, url.origin), request));
    if (response.ok && (assetPath.endsWith('.html') || !String(response.headers.get('content-type')).toLowerCase().includes('text/html'))) {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', cache);
      return new Response(response.body, { status: response.status, headers });
    }
  }
  return missing(path, assets);
}
