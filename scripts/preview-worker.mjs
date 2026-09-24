/** Local read-only preview of the built Worker and its asset routing. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import worker from '../dist/server/index.js';
const root = resolve('dist');
const mime = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.png':'image/png', '.svg':'image/svg+xml', '.xml':'application/xml', '.txt':'text/plain' };
const env = { ASSETS: { async fetch(request) {
  const path = new URL(request.url).pathname;
  try {
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '/')) throw Error('invalid path');
    const bytes = await readFile(file);
    return new Response(bytes, { headers: { 'Content-Type': mime[extname(file)] || 'application/octet-stream' } });
  } catch { return new Response('Not found', { status: 404 }); }
} } };
const server = createServer(async (req, res) => {
  try {
    const url = `http://127.0.0.1:${process.env.PORT || 8080}${req.url}`;
    const response = await worker.fetch(new Request(url, { method:req.method, headers:req.headers }), env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500);res.end('Preview failed'); }
});
server.listen(Number(process.env.PORT || 8080), '127.0.0.1');
