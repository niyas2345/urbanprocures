import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import worker from '../dist/_worker.js';

const dist = resolve('dist');
const routes = new Set(['/js/routes.js', '/signup', '/signin', '/how']);
for (const file of readdirSync(dist).filter(name => name.endsWith('.html'))) {
  const html = readFileSync(resolve(dist, file), 'utf8');
  for (const [, path] of html.matchAll(/(?:src|href)=["'](\/(?:assets|js|css)\/[^"'?]+)["']/g)) {
    routes.add(path);
  }
}
for (const directory of ['assets', 'js']) {
  for (const name of readdirSync(resolve(dist, directory))) {
    if (/\.m?js$/.test(name) && statSync(resolve(dist, directory, name)).isFile()) {
      routes.add(`/${directory}/${name}`);
    }
  }
}

let failures = 0;
for (const path of routes) {
  const response = await worker.fetch(new Request(`https://preview.test${path}`), {});
  const body = await response.text();
  if (response.status !== 200 || !body ||
    (/\.(?:m?js)$/.test(path) && !response.headers.get('content-type')?.includes('javascript'))) {
    console.error(`Missing preview asset: ${path} (${response.status})`);
    failures++;
  }
}
const unknown = await worker.fetch(new Request('https://preview.test/no-such-page'), {});
if (unknown.status !== 404) failures++;
if (failures) process.exitCode = 1;
else console.log(`Preview Worker served ${routes.size} referenced assets and routes; unknown page returned 404.`);
