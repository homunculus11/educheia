"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

// ── ANSI (inline, no shared dep so this file stays standalone) ───────────────
const isTTY = process.stdout.isTTY !== false;
const c = (code, s) => (isTTY ? `${code}${s}\x1b[0m` : s);
const D = isTTY ? "\x1b[2m" : "";
const B = isTTY ? "\x1b[1m" : "";
const R = isTTY ? "\x1b[0m" : "";
const GRN = isTTY ? "\x1b[32m" : "";
const YLW = isTTY ? "\x1b[33m" : "";
const RED = isTTY ? "\x1b[31m" : "";
const CYN = isTTY ? "\x1b[36m" : "";

const ts = () => c(D, new Date().toTimeString().slice(0, 8));
const log = (msg) => console.log(`${ts()}  ${msg}`);

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const readArg = (name, fb) => {
  const i = argv.indexOf(name);
  if (i === -1) return fb;
  const v = argv[i + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : fb;
};

const rootArg = readArg("--root", ".");
const portArg = Number.parseInt(readArg("--port", "5173"), 10);
const ROOT_DIR = path.resolve(process.cwd(), rootArg);
const PORT = Number.isFinite(portArg) ? portArg : 5173;
const LIVE_RELOAD_ROUTE = "/__dev/livereload";
const LIVE_RELOAD_EXTS = new Set([".html", ".js", ".css"]);
const LIVE_RELOAD_IGNORED_DIRS = new Set([".git", "node_modules"]);

// ── Route map ────────────────────────────────────────────────────────────────
const ROUTE_MAP = {
  "/": "index.html",
  "/episodes": "src/episodes.html",
  "/about": "src/about.html",
  "/forum": "src/forum.html",
  "/forum/thread": "src/forum-thread.html",
  "/login": "src/login.html",
  "/register": "src/register.html",
  "/account": "src/account.html",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const normPath = (v) => String(v || "").replace(/\\/g, "/");
const statusColor = (sc) =>
  sc >= 500 ? RED
  : sc >= 400 ? YLW
  : sc >= 300 ? CYN
  : GRN;
const liveReloadClients = new Set();
const LIVE_RELOAD_SNIPPET = `<script>
(() => {
  if (window.__EDUCHEIA_LIVE_RELOAD__) return;
  window.__EDUCHEIA_LIVE_RELOAD__ = true;
  let hadConnection = false;
  let lostConnection = false;
  const connect = () => {
    const es = new EventSource("${LIVE_RELOAD_ROUTE}");
    es.onopen = () => {
      if (hadConnection && lostConnection) {
        location.reload();
        return;
      }
      hadConnection = true;
      lostConnection = false;
    };
    es.addEventListener("reload", () => location.reload());
    es.onerror = () => {
      lostConnection = hadConnection || lostConnection;
      es.close();
      setTimeout(connect, 400);
    };
  };
  connect();
})();
</script>`;

function injectLiveReload(html) {
  if (html.includes("window.__EDUCHEIA_LIVE_RELOAD__")) return html;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${LIVE_RELOAD_SNIPPET}\n</body>`);
  }
  return `${html}\n${LIVE_RELOAD_SNIPPET}\n`;
}

function sendHtml(res, abs) {
  const source = fs.readFileSync(abs, "utf8");
  res.type("html").send(injectLiveReload(source));
}

function sendIfExists(res, rel, next) {
  const abs = path.resolve(ROOT_DIR, normPath(rel).replace(/^\/+/, ""));
  if (!abs.startsWith(ROOT_DIR)) {
    next();
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    next();
    return;
  }
  if (path.extname(abs).toLowerCase() === ".html") {
    sendHtml(res, abs);
    return;
  }
  res.sendFile(abs);
}

function watchPathAllowed(relPath) {
  if (!relPath) return false;
  const normalized = normPath(relPath);
  const parts = normalized.split("/");
  if (parts.some((part) => LIVE_RELOAD_IGNORED_DIRS.has(part))) return false;
  return LIVE_RELOAD_EXTS.has(path.extname(normalized).toLowerCase());
}

function broadcastReload(relPath) {
  if (!liveReloadClients.size) return;
  const payload = `event: reload\ndata: ${normPath(relPath)}\n\n`;
  for (const client of liveReloadClients) client.write(payload);
}

function startLiveReloadWatcher() {
  let debounceTimer = null;
  let lastChangedPath = null;

  const scheduleReload = (relPath) => {
    lastChangedPath = relPath || lastChangedPath || "(unknown)";
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const changed = lastChangedPath || "(unknown)";
      lastChangedPath = null;
      broadcastReload(changed);
      log(`${c(CYN, "↻")}  reloading browser (${changed})`);
    }, 80);
  };

  let watcher;
  try {
    watcher = fs.watch(
      ROOT_DIR,
      { recursive: true },
      (_eventType, filename) => {
        const rel = filename ? String(filename) : null;
        if (!watchPathAllowed(rel)) return;
        scheduleReload(rel);
      },
    );
  } catch (err) {
    log(`${c(YLW, "!")}  live reload disabled: ${err.message}`);
    return;
  }

  watcher.on("error", (err) => {
    log(`${c(YLW, "!")}  live reload watcher error: ${err.message}`);
  });

  process.on("exit", () => watcher.close());
}

// ── 404 page ─────────────────────────────────────────────────────────────────
const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>404 — Not Found</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0c0c0c;
      color: #d4d4d4;
    }
    .wrap { text-align: center; padding: 2rem; }
    .code {
      font-size: clamp(5rem, 20vw, 9rem);
      font-weight: 900;
      line-height: 1;
      color: #fff;
      letter-spacing: -0.04em;
    }
    .msg  { font-size: 1.125rem; color: #6b6b6b; margin-top: 0.5rem; }
    .path { font-family: monospace; color: #4a9eff; font-size: 0.9rem; margin-top: 0.25rem; }
    .home {
      display: inline-block;
      margin-top: 2rem;
      padding: 0.55rem 1.5rem;
      border: 1px solid #333;
      border-radius: 6px;
      color: #d4d4d4;
      text-decoration: none;
      font-size: 0.875rem;
      transition: border-color 0.15s, color 0.15s;
    }
    .home:hover { border-color: #666; color: #fff; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="code">404</div>
    <p class="msg">Page not found</p>
    <p class="path" id="p"></p>
    <a class="home" href="/">Go home</a>
  </div>
  <script>document.getElementById('p').textContent = location.pathname;</script>
</body>
</html>`;

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");

// No-cache in dev
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Request logger
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    const sc = res.statusCode;
    const col = statusColor(sc);
    const dur = Date.now() - t0;
    const method = req.method.padEnd(6);
    log(
      `${c(col, String(sc))}  ${c(B, method)}${req.path}  ${c(D, `${dur}ms`)}`,
    );
  });
  next();
});

app.get(LIVE_RELOAD_ROUTE, (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write("retry: 400\n\n");
  liveReloadClients.add(res);
  res.on("close", () => liveReloadClients.delete(res));
});

// Root redirect aliases
app.get(["/index.html", "/src/index.html"], (_req, res) =>
  res.redirect(301, "/"),
);

// Named routes
for (const [routePath, relFile] of Object.entries(ROUTE_MAP)) {
  app.get(routePath, (_req, res, next) => sendIfExists(res, relFile, next));
  app.get(`${routePath}/`, (_req, res) => res.redirect(301, routePath));
}

// Forum thread SEO routes
app.get(
  ["/forum/thread/:threadId", "/forum/thread/:threadId/:threadSlug"],
  (_req, res, next) => sendIfExists(res, "src/forum-thread.html", next),
);
app.get("/forum/thread/:threadId/", (req, res) =>
  res.redirect(301, `/forum/thread/${encodeURIComponent(req.params.threadId)}`),
);
app.get("/forum/thread/:threadId/:threadSlug/", (req, res) =>
  res.redirect(
    301,
    `/forum/thread/${encodeURIComponent(req.params.threadId)}/${encodeURIComponent(req.params.threadSlug)}`,
  ),
);

// Strip .html extension redirects
for (const routePath of Object.keys(ROUTE_MAP)) {
  if (routePath === "/") continue;
  app.get(`${routePath}.html`, (_req, res) => res.redirect(301, routePath));
}

// Direct HTML file requests
app.get(/\.html$/i, (req, res, next) => {
  const rel = req.path.replace(/^\/+/, "");
  sendIfExists(res, rel, next);
});

// Extension-less fallback (try <path>.html)
app.use((req, res, next) => {
  if (path.extname(req.path)) {
    next();
    return;
  }
  const clean = req.path.replace(/^\/+/, "");
  if (!clean) {
    next();
    return;
  }
  sendIfExists(res, `${clean}.html`, next);
});

// Static assets
app.use(express.static(ROOT_DIR, { index: false }));

// 404
app.use((req, res) => {
  res.status(404).type("text/html").send(injectLiveReload(NOT_FOUND_HTML));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  startLiveReloadWatcher();
  console.log();
  console.log(`  ${c(B + GRN, "▶")}  ${c(B, `http://localhost:${PORT}`)}`);
  console.log(`  ${c(D, "root")}   ${ROOT_DIR}`);
  console.log(`  ${c(D, "routes")} ${Object.keys(ROUTE_MAP).join("  ")}`);
  console.log(
    `  ${c(D, "reload")} ${LIVE_RELOAD_EXTS.size} extensions watched`,
  );
  console.log();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  ${RED}✖${R}  Port ${PORT} is already in use.\n`);
    console.error(
      `     Stop the process using it, or pass --port <n> to use a different port.\n`,
    );
  } else {
    console.error(`\n  ${RED}✖${R}  Server error: ${err.message}\n`);
  }
  process.exit(1);
});
