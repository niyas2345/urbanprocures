import { mkdirSync, existsSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const dist = resolve(root, "dist");
const BUILD_STAMP = "2026-09-24-auth-qa-3";
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const viteBin = resolve(root, "node_modules/vite/bin/vite.js");
if (!existsSync(viteBin)) {
  throw new Error("Vite is not installed. Run npm ci before building.");
}

function walkTextAssets(dir, visit) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) {
      walkTextAssets(file, visit);
      continue;
    }
    if (!/\.(?:html|js|mjs|css)$/i.test(name)) continue;
    const before = readFileSync(file, "utf8");
    const after = visit(before, name);
    if (after !== before) writeFileSync(file, after);
  }
}

function replaceLaunchCopy(dir) {
  walkTextAssets(dir, (before) => before
    .replace(/<span class="demo-badge">[\s\S]*?<\/span>/g, "")
    .replace(/EARLY ACCESS/g, "")
    .replace(/LIVE PLATFORM/g, "")
    .replace(/Early Access/g, "")
    .replace(/Live Platform/g, ""));
}

function hardenProductionUi(dir) {
  const hardenCss = `<style id="prod-harden">[data-reset],[data-owner-unlock]{display:none!important}</style>`;
  walkTextAssets(dir, (before, name) => {
    let after = before
      .replace(/<!-- BUILD [^>]*>/g, `<!-- BUILD ${BUILD_STAMP} -->`)
      .replace(/<button[^>]*data-reset[^>]*>Reset local data<\/button>/gi, "")
      .replace(/<button[^>]*data-owner-unlock[^>]*>Owner portal<\/button>/gi, "");

    if (name.endsWith(".html") && !after.includes('id="prod-harden"')) {
      after = after.replace("</head>", `${hardenCss}</head>`);
    }
    return after;
  });
}

function copyIfExists(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(resolve(dest, ".."), { recursive: true });
  copyFileSync(src, dest);
}

const result = spawnSync(process.execPath, [viteBin, "build"], { stdio: "inherit", cwd: root });
if (result.status !== 0) process.exit(result.status || 1);
const classicScripts = join(dist, "js");
mkdirSync(classicScripts, { recursive: true });
const publicJs = join(root, "public/js");
for (const name of readdirSync(publicJs)) {
  if (name.endsWith(".js")) copyFileSync(join(publicJs, name), join(classicScripts, name));
}
mkdirSync(join(dist, "css"), { recursive: true });
copyIfExists(join(root, "public/css/styles.css"), join(dist, "css/styles.css"));
mkdirSync(join(dist, "assets"), { recursive: true });
const publicAssets = join(root, "public/assets");
if (existsSync(publicAssets)) {
  for (const name of readdirSync(publicAssets)) {
    copyIfExists(join(publicAssets, name), join(dist, "assets", name));
  }
}
copyIfExists(join(root, "public/_redirects"), join(dist, "_redirects"));
copyIfExists(join(root, "public/_headers"), join(dist, "_headers"));
copyIfExists(join(root, "public/robots.txt"), join(dist, "robots.txt"));
copyIfExists(join(root, "public/sitemap.xml"), join(dist, "sitemap.xml"));
replaceLaunchCopy(dist);
hardenProductionUi(dist);
if (process.env.PREVIEW_ONLY === "1") {
  walkTextAssets(dist, (before, name) => name.endsWith(".html")
    ? before.replace(/<body([^>]*)>/i, '<body$1><div role="status" style="position:relative;z-index:100;padding:.8rem 1rem;background:#fff1cf;color:#493a15;text-align:center;font:600 14px/1.5 system-ui">Private design preview · Account actions need an authorised staging backend.</div>')
    : before);
}
writeFileSync(join(dist, "build-stamp.json"), JSON.stringify({
  stamp: BUILD_STAMP,
  builtAt: new Date().toISOString()
}, null, 2));
