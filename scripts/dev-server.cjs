const fs = require('fs');
const path = require('path');
const express = require('express');

const args = process.argv.slice(2);

const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const next = args[index + 1];
  return typeof next === 'string' && !next.startsWith('--') ? next : fallback;
};

const rootArg = readArg('--root', '.');
const portArg = Number.parseInt(readArg('--port', '5173'), 10);

const ROOT_DIR = path.resolve(process.cwd(), rootArg);
const PORT = Number.isFinite(portArg) ? portArg : 5173;

const app = express();

const routeMap = {
  '/': 'index.html',
  '/episodes': 'src/episodes.html',
  '/about': 'src/about.html',
  '/login': 'src/login.html',
  '/register': 'src/register.html',
  '/account': 'src/account.html'
};

const normalizePath = (value) => String(value || '').replace(/\\/g, '/');

const sendFileIfExists = (res, relFilePath, next) => {
  const normalized = normalizePath(relFilePath).replace(/^\/+/, '');
  const absolutePath = path.resolve(ROOT_DIR, normalized);

  if (!absolutePath.startsWith(ROOT_DIR)) {
    next();
    return;
  }

  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    next();
    return;
  }

  res.sendFile(absolutePath);
};

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static(ROOT_DIR, {
  extensions: ['html']
}));

app.get(['/index.html', '/src/index.html'], (_req, res) => {
  res.redirect(301, '/');
});

for (const [routePath, relFilePath] of Object.entries(routeMap)) {
  app.get(routePath, (_req, res, next) => {
    sendFileIfExists(res, relFilePath, next);
  });

  app.get(`${routePath}/`, (_req, res) => {
    res.redirect(301, routePath);
  });
}

for (const routePath of Object.keys(routeMap)) {
  if (routePath === '/') continue;

  app.get(`${routePath}.html`, (_req, res) => {
    res.redirect(301, routePath);
  });
}

app.use((req, res, next) => {
  if (path.extname(req.path)) {
    next();
    return;
  }

  const cleanPath = req.path.replace(/^\/+/, '');
  if (!cleanPath) {
    next();
    return;
  }

  sendFileIfExists(res, `${cleanPath}.html`, next);
});

app.use((_req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

app.listen(PORT, () => {
  console.log(`Serving ${ROOT_DIR} on http://localhost:${PORT}`);
});
