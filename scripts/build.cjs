"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { minify: minifyJs } = require("terser");
const { minify: minifyHtml } = require("html-minifier-terser");
const {
  log,
  warn,
  error,
  info,
  step,
  divider,
  elapsed,
  bytes,
  summary,
  c,
  B,
  D,
  GRN,
  YLW,
  CYN,
  R,
} = require("./_logger.cjs");

// ── Config ───────────────────────────────────────────────────────────────────
const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, "dist");
const COPY_ITEMS = [
  "images",
  "js",
  "src",
  "index.html",
  "robots.txt",
  "sitemap.xml",
];
const FINGERPRINT_EXTS = new Set([".js", ".css"]);
const REFERENCE_EXTS = new Set([".html", ".js"]);
const TOTAL_STEPS = 6;
const HTML_MINIFY_OPTIONS = {
  collapseWhitespace: true,
  removeComments: true,
  removeRedundantAttributes: true,
  removeEmptyAttributes: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  useShortDoctype: true,
  keepClosingSlash: true,
  minifyCSS: true,
};
const JS_MINIFY_OPTIONS = {
  ecma: 2020,
  compress: { passes: 2 },
  mangle: true,
  format: { comments: false },
};

// ── Flags ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const SKIP_IMAGES = argv.includes("--no-images") || argv.includes("--fast");

// ── Utilities ────────────────────────────────────────────────────────────────
function toPosix(p) {
  return p.split(path.sep).join("/");
}

function toModuleRelative(fromDir, toFile) {
  const rel = toPosix(path.relative(fromDir, toFile));
  return rel && !rel.startsWith(".") && !rel.startsWith("/") ? `./${rel}` : rel;
}

function walk(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  const recurse = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      entry.isDirectory() ? recurse(full) : files.push(full);
    }
  };
  recurse(dir);
  return files;
}

function isEsmSource(code) {
  return /(^|[\r\n])\s*(import|export)\s/m.test(code);
}

function getJsMinifyOptions(isModule) {
  const compress = { ...JS_MINIFY_OPTIONS.compress };
  if (!isModule) {
    // Keep top-level bindings for cross-file globals (e.g. getEpisodes).
    compress.unused = false;
    compress.toplevel = false;
  }
  return {
    ...JS_MINIFY_OPTIONS,
    compress,
    module: isModule,
  };
}

async function minifyInlineScripts(html, label) {
  const scriptTag = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let lastIndex = 0;
  let output = "";
  let match;

  while ((match = scriptTag.exec(html))) {
    const [full, attrs, body] = match;
    output += html.slice(lastIndex, match.index);
    lastIndex = match.index + full.length;

    if (/\bsrc\s*=\s*/i.test(attrs)) {
      output += full;
      continue;
    }

    const typeMatch = attrs.match(
      /\btype\s*=\s*["']?([^"'\s>]+)["']?/i,
    );
    const type = (typeMatch ? typeMatch[1] : "text/javascript").toLowerCase();
    if (type === "application/ld+json" || type === "application/json") {
      output += full;
      continue;
    }

    if (!body.trim()) {
      output += full;
      continue;
    }

    const isModule = type === "module" || isEsmSource(body);
    const result = await minifyJs(body, getJsMinifyOptions(isModule));
    if (!result || !result.code) {
      throw new Error(`Inline JS minification failed for ${label}`);
    }
    output += `<script${attrs}>${result.code}</script>`;
  }

  output += html.slice(lastIndex);
  return output;
}

function runScript(scriptName) {
  const t0 = Date.now();
  info(`Running script: ${c(B, scriptName)}`);

  const useExecpath = Boolean(process.env.npm_execpath);
  const command =
    useExecpath ? process.execPath
    : process.platform === "win32" ? "npm.cmd"
    : "npm";
  const args =
    useExecpath ?
      [process.env.npm_execpath, "run", scriptName]
    : ["run", scriptName];

  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: ROOT_DIR,
    shell: !useExecpath && process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Script "${scriptName}" exited with code ${result.status}`);

  log(`${scriptName} finished in ${elapsed(t0)}`);
}

// ── Steps ────────────────────────────────────────────────────────────────────
function cleanDist() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  log("dist/ cleaned and recreated");
}

function copyItems() {
  const results = [];
  for (const item of COPY_ITEMS) {
    const src = path.join(ROOT_DIR, item);
    const dest = path.join(DIST_DIR, item);
    if (!fs.existsSync(src)) {
      console.log(
        `  ${c(YLW, "─")}  skipped ${c(D, item)} ${c(D, "(not found)")}`,
      );
      results.push(false);
    } else {
      fs.cpSync(src, dest, { recursive: true });
      console.log(`  ${c(GRN, "+")}  ${item}`);
      results.push(true);
    }
  }
  return results.filter(Boolean).length;
}

function copyBuiltCss() {
  const cssDir = path.join(ROOT_DIR, "css");
  const destDir = path.join(DIST_DIR, "css");
  if (!fs.existsSync(cssDir)) {
    warn("css/ not found — skipping");
    return 0;
  }

  fs.mkdirSync(destDir, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(cssDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".css") || entry.name.endsWith(".tailwind.css"))
      continue;
    fs.copyFileSync(
      path.join(cssDir, entry.name),
      path.join(destDir, entry.name),
    );
    console.log(`  ${c(GRN, "+")}  css/${entry.name}`);
    n++;
  }
  return n;
}

async function minifyDistAssets() {
  const files = walk(DIST_DIR);
  const jsFiles = files.filter((f) => path.extname(f).toLowerCase() === ".js");
  const htmlFiles = files.filter(
    (f) => path.extname(f).toLowerCase() === ".html",
  );

  let bytesSaved = 0;
  let jsMinified = 0;
  let htmlMinified = 0;

  for (const filePath of jsFiles) {
    const original = fs.readFileSync(filePath, "utf8");
    const isModule = isEsmSource(original);
    const result = await minifyJs(original, getJsMinifyOptions(isModule));
    if (!result || !result.code) {
      throw new Error(
        `Terser failed to minify ${toPosix(path.relative(DIST_DIR, filePath))}`,
      );
    }
    if (result.code !== original) {
      fs.writeFileSync(filePath, result.code, "utf8");
      bytesSaved +=
        Buffer.byteLength(original, "utf8") -
        Buffer.byteLength(result.code, "utf8");
      jsMinified++;
    }
  }

  for (const filePath of htmlFiles) {
    const original = fs.readFileSync(filePath, "utf8");
    const withMinifiedScripts = await minifyInlineScripts(
      original,
      toPosix(path.relative(DIST_DIR, filePath)),
    );
    const result = await minifyHtml(withMinifiedScripts, HTML_MINIFY_OPTIONS);
    if (typeof result !== "string") {
      throw new Error(
        `HTML minifier failed for ${toPosix(path.relative(DIST_DIR, filePath))}`,
      );
    }
    if (result !== original) {
      fs.writeFileSync(filePath, result, "utf8");
      bytesSaved +=
        Buffer.byteLength(original, "utf8") - Buffer.byteLength(result, "utf8");
      htmlMinified++;
    }
  }

  return {
    js: { scanned: jsFiles.length, minified: jsMinified },
    html: { scanned: htmlFiles.length, minified: htmlMinified },
    bytesSaved,
  };
}

function buildFingerprintName(name, buf) {
  const { name: base, ext } = path.parse(name);
  const hash = crypto
    .createHash("sha256")
    .update(buf)
    .digest("hex")
    .slice(0, 10);
  return `${base}.${hash}${ext}`;
}

function fingerprintAssets() {
  const entries = walk(DIST_DIR)
    .filter((f) => FINGERPRINT_EXTS.has(path.extname(f).toLowerCase()))
    .map((f) => ({ abs: f, rel: toPosix(path.relative(DIST_DIR, f)) }))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const manifest = {};
  for (const { abs, rel } of entries) {
    const buf = fs.readFileSync(abs);
    const newName = buildFingerprintName(path.basename(abs), buf);
    const newAbs = path.join(path.dirname(abs), newName);
    const newRel = toPosix(path.relative(DIST_DIR, newAbs));
    fs.renameSync(abs, newAbs);
    manifest[rel] = newRel;
    console.log(`  ${c(CYN, "⟳")}  ${c(D, rel)} → ${newName}`);
  }

  fs.writeFileSync(
    path.join(DIST_DIR, "asset-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function rewriteReferences(manifest) {
  if (!Object.keys(manifest).length) return { scanned: 0, rewritten: 0 };

  const targets = walk(DIST_DIR).filter((f) =>
    REFERENCE_EXTS.has(path.extname(f).toLowerCase()),
  );
  const tokenRegex =
    /(["'])([^"'#?]+\.(?:js|css))((?:\?[^"'#]*)?)(#[^"']*)?\1/g;
  let rewritten = 0;

  for (const filePath of targets) {
    const original = fs.readFileSync(filePath, "utf8");
    const fileDir = path.dirname(filePath);

    const updated = original.replace(
      tokenRegex,
      (full, q, target, query = "", hash = "") => {
        if (/^(?:https?:)?\/\//i.test(target) || target.startsWith("data:"))
          return full;

        const absResolved =
          target.startsWith("/") ?
            path.join(DIST_DIR, target.replace(/^\/+/, ""))
          : path.resolve(fileDir, target);

        const relResolved = toPosix(path.relative(DIST_DIR, absResolved));
        const mapped = manifest[relResolved];
        if (!mapped) return full;

        const mappedAbs = path.join(DIST_DIR, mapped);
        let next;
        if (target.startsWith("/")) {
          next = `/${mapped}`;
        } else {
          const mod = toModuleRelative(fileDir, mappedAbs);
          if (
            target.startsWith("./") &&
            !mod.startsWith("./") &&
            !mod.startsWith("../")
          )
            next = `./${mod}`;
          else if (
            !target.startsWith("./") &&
            !target.startsWith("../") &&
            !target.startsWith("/") &&
            mod.startsWith("./")
          )
            next = mod.slice(2);
          else next = mod;
        }
        return `${q}${next}${query}${hash}${q}`;
      },
    );

    if (updated !== original) {
      fs.writeFileSync(filePath, updated, "utf8");
      console.log(
        `  ${c(GRN, "↺")}  ${toPosix(path.relative(DIST_DIR, filePath))}`,
      );
      rewritten++;
    }
  }

  return { scanned: targets.length, rewritten };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  divider("Educheia Build");
  if (SKIP_IMAGES) warn("--no-images: skipping image generation");

  let stepN = 0;
  const next = (title) =>
    step(++stepN, TOTAL_STEPS - (SKIP_IMAGES ? 1 : 0), title);

  // ── 1. Images (optional) ──────────────────────────────────────────────────
  if (!SKIP_IMAGES) {
    const t = Date.now();
    next("Generating responsive images");
    runScript("build:images");
    log(`Images done in ${elapsed(t)}`);
  }

  // ── 2. CSS ────────────────────────────────────────────────────────────────
  const tCss = Date.now();
  next("Building CSS");
  runScript("build:css");
  log(`CSS done in ${elapsed(tCss)}`);

  // ── 3. Dist scaffold ──────────────────────────────────────────────────────
  next("Preparing dist/");
  cleanDist();
  const copiedPaths = copyItems();
  const copiedCss = copyBuiltCss();

  // ── 4. Minify assets ──────────────────────────────────────────────────────
  const tMin = Date.now();
  next("Minifying assets");
  const minified = await minifyDistAssets();
  log(
    `Minified JS ${minified.js.minified}/${minified.js.scanned}, HTML ${minified.html.minified}/${minified.html.scanned} in ${elapsed(tMin)}`,
  );

  // ── 5. Fingerprint ────────────────────────────────────────────────────────
  const tFp = Date.now();
  next("Fingerprinting assets");
  const manifest = fingerprintAssets();
  log(
    `Fingerprinted ${Object.keys(manifest).length} asset(s) in ${elapsed(tFp)}`,
  );

  // ── 6. Rewrite references ─────────────────────────────────────────────────
  const tRw = Date.now();
  next("Rewriting asset references");
  const rw = rewriteReferences(manifest);
  log(`Rewrote ${rw.rewritten}/${rw.scanned} file(s) in ${elapsed(tRw)}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  divider("Build Summary");
  summary([
    ["Copied paths", `${copiedPaths}/${COPY_ITEMS.length}`],
    ["Compiled CSS files", String(copiedCss)],
    ["Minified JS", `${minified.js.minified}/${minified.js.scanned}`],
    ["Minified HTML", `${minified.html.minified}/${minified.html.scanned}`],
    ["Minify savings", bytes(minified.bytesSaved)],
    ["Fingerprinted", String(Object.keys(manifest).length)],
    ["References rewritten", `${rw.rewritten}/${rw.scanned}`],
    ["Total duration", elapsed(t0)],
  ]);
  console.log();
}

main().catch((e) => {
  error(e.message || String(e));
  process.exit(1);
});
