import test from 'node:test';
import assert from 'node:assert/strict';
import { serveStatic } from './static-routes.js';

test('html aliases redirect instead of serving the homepage', async () => {
  const response = await serveStatic('/login.html', new Request('https://app.test/login.html'), {});
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('Location'), '/signin');
});

test('legacy dashboard paths preserve query parameters and reach canonical routes', async () => {
  const response = await serveStatic('/dashboard-client.html', new Request('https://app.test/dashboard-client.html?view=quotes'), {});
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('Location'), '/client/dashboard?view=quotes');
});

test('role-specific deep links render and can be refreshed', async () => {
  const response = await serveStatic('/vendor/quotations', new Request('https://app.test/vendor/quotations'), {}, {
    '/dashboard-vendor.html': { body: '<title>Vendor workspace</title>', contentType: 'text/html; charset=utf-8' }
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Vendor workspace/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('pretty paths rewrite to the real html page', async () => {
  const env = {
    ASSETS: {
      fetch: async (request) => {
        const url = new URL(request.url);
        return new Response(`served:${url.pathname}`, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    }
  };
  const response = await serveStatic('/privacy', new Request('https://app.test/privacy'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'served:/privacy.html');
});

test('missing javascript does not fall back to the homepage html', async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response('<!DOCTYPE html><title>Urban Procures | Construction RFQ & Vendor Sourcing Platform UAE</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    }
  };
  const response = await serveStatic('/js/missing-app.js', new Request('https://app.test/js/missing-app.js'), env);
  assert.equal(response.status, 404);
  assert.equal(String(response.headers.get('content-type')).includes('text/html'), false);
});

test('unknown nested workspace route returns genuine 404', async () => {
  const response = await serveStatic('/client/not-a-page', new Request('https://app.test/client/not-a-page'), {});
  assert.equal(response.status, 404);
});

test('unknown html pages return 404 instead of the homepage', async () => {
  const response = await serveStatic('/not-a-real-page.html', new Request('https://app.test/not-a-real-page.html'), {});
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.match(body, /not found/i);
  assert.equal(body.includes('Stop chasing quotes'), false);
});
