import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const TEXT_EXT = new Set([".css", ".html", ".js", ".mjs", ".json", ".svg", ".txt", ".xml"]);
const SKIP_EXT = new Set([".map"]);
// Sites preview does not provide an ASSETS binding. Its Worker must carry the
// frontend scripts, including the Supabase client bundle (~230 KB).
const MAX_EMBED_BYTES = 1_000_000;

const root = process.cwd();
const distDir = resolve(root, "dist");
const serverEntry = resolve(root, "dist/server/index.js");
const hostingConfig = resolve(root, "dist/.openai/hosting.json");
const staticAssets = collectStaticAssets(distDir);

mkdirSync(dirname(serverEntry), { recursive: true });
mkdirSync(dirname(hostingConfig), { recursive: true });
cpSync(resolve(root, "server"), resolve(root, "dist/server"), { recursive: true });
writeFileSync(
  serverEntry,
  readFileSync(resolve(root, "server/sites-worker.js"), "utf8")
    .replace(
      "const STATIC_ASSETS = {};",
      () => `const STATIC_ASSETS = ${JSON.stringify(staticAssets)};`
    )
    .replace(
      'import { supabaseSecret, supabaseReady } from "./supabase-env.js";',
      'import { supabaseSecret, supabaseReady } from "./supabase-env.js";\nimport { serveStatic as serveStaticRouted } from "./static-routes.js";'
    )
    .replace(
      "return serveStatic(url.pathname, request, env);",
      "return serveStaticRouted(url.pathname, request, env, STATIC_ASSETS);"
    )
);
if (existsSync(resolve(root, ".openai/hosting.json"))) {
  copyFileSync(resolve(root, ".openai/hosting.json"), hostingConfig);
}
writeFileSync(
  resolve(root, "dist/_worker.js"),
  'import worker from "./server/index.js";\n\nexport default worker;\n'
);

function collectStaticAssets(dir, prefix = "") {
  const assets = {};

  for (const entry of readdirSync(dir)) {
    if (entry === "server" || entry === ".openai" || entry === "_worker.js") continue;

    const fullPath = join(dir, entry);
    const route = `${prefix}/${entry}`;
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      Object.assign(assets, collectStaticAssets(fullPath, route));
      continue;
    }

    const ext = extname(entry).toLowerCase();
    if (SKIP_EXT.has(ext) || stat.size > MAX_EMBED_BYTES) continue;

    if (TEXT_EXT.has(ext)) {
      assets[route] = {
        body: readFileSync(fullPath, "utf8"),
        contentType: contentTypeFor(entry)
      };
    } else {
      assets[route] = {
        body: readFileSync(fullPath).toString("base64"),
        encoding: "base64",
        contentType: contentTypeFor(entry)
      };
    }
  }

  return assets;
}

function contentTypeFor(file) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
  }[extname(file).toLowerCase()] || "application/octet-stream";
}
