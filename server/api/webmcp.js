import { handleDeskApi } from './desk.js';
import { requireIdentity } from '../auth/identity.js';

const MANIFEST = Object.freeze({
  name: 'urban-procure',
  version: '1.0',
  endpoint: '/api/webmcp',
  authentication: { type: 'bearer', source: 'supabase-session' },
  security: {
    sameAuthorizationBoundaryAsUi: true,
    privateDocumentsExcluded: true,
    materialActionsRequireHumanApproval: true
  },
  actions: [
    {
      name: 'get_desk',
      description: 'Read the authenticated user procurement desk.',
      readOnly: true
    }
  ]
});

/** WebMCP exposes only allow-listed high-level actions through existing APIs. */
export async function handleWebMcp(request, env) {
  if (request.method === 'GET') return json(MANIFEST);
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const actor = await requireIdentity(request, env);
  if (!actor.ok) return json({ ok: false, error: actor.error }, actor.status);

  const payload = await request.json().catch(() => ({}));
  if (payload.action !== 'get_desk') {
    return json({ ok: false, error: 'Unsupported WebMCP action' }, 400);
  }

  const url = new URL(request.url);
  url.pathname = '/api/desk/bootstrap';
  url.search = '';
  const delegated = new Request(url, {
    method: 'GET',
    headers: request.headers
  });
  return handleDeskApi(delegated, env);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
