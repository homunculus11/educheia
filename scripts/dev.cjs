'use strict';

const path         = require('path');
const { spawn }    = require('child_process');
const { warn, error, info, divider, c, B, D, GRN, YLW, CYN, MGT, R } = require('./_logger.cjs');

const ROOT_DIR = process.cwd();

// ── Process labels & colors ──────────────────────────────────────────────────
const PROC_CSS    = { name: 'css',    color: CYN };
const PROC_SERVER = { name: 'server', color: MGT };
const PORT        = 5173;

// ── Line-prefixer ────────────────────────────────────────────────────────────
// Buffers streaming output and writes each line with a colored process prefix.
function makePrefixer(label, color) {
  let buf    = '';
  const pfx  = `${color}[${label}]${R} `;

  const write = (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) process.stdout.write(`${pfx}${line}\n`);
    }
  };

  const flush = () => {
    if (buf.trim()) { process.stdout.write(`${pfx}${buf}\n`); buf = ''; }
  };

  return { write, flush };
}

// ── Shutdown coordinator ─────────────────────────────────────────────────────
const children     = new Set();
let   shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  info('Shutting down dev processes…');
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ── Spawn helper with restart ────────────────────────────────────────────────
function launch(descriptor, getSpawnArgs, restartOnCrash = true) {
  const { name, color } = descriptor;
  const prefixer = makePrefixer(name, color);
  let   crashCount = 0;
  let   lastCrash  = 0;

  const start = () => {
    const { command, args, options } = getSpawnArgs();

    const child = spawn(command, args, {
      cwd  : ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env  : { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' },
      ...options,
    });

    children.add(child);
    child.stdout.on('data', prefixer.write);
    child.stderr.on('data', prefixer.write);
    child.stdout.on('end',  prefixer.flush);

    child.on('error', (err) => {
      error(`[${name}] failed to start: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      children.delete(child);
      if (shuttingDown) return;
      if (code === 0 || signal === 'SIGTERM') return;

      if (!restartOnCrash) {
        error(`[${name}] exited with code ${code ?? signal} — shutting down`);
        shutdown(1);
        return;
      }

      const now = Date.now();
      if (now - lastCrash > 10_000) crashCount = 0; // reset streak after quiet period
      lastCrash = now;
      crashCount++;

      const delay = Math.min(500 * 2 ** (crashCount - 1), 8_000);
      warn(`[${name}] crashed (exit ${code ?? signal}), restarting in ${c(B, `${delay}ms`)}… (attempt ${crashCount})`);
      setTimeout(start, delay);
    });

    return child;
  };

  return start();
}

// ── Resolve pnpm / npm / node runner ────────────────────────────────────────
function scriptArgs(scriptName) {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args   : [process.env.npm_execpath, 'run', scriptName],
    };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args   : ['run', scriptName],
    options: { shell: process.platform === 'win32' },
  };
}

// ── Banner ───────────────────────────────────────────────────────────────────
divider('Educheia Dev');
info(`Starting ${c(B, 'CSS watcher')} + ${c(B, 'dev server')} on ${c(GRN, `http://localhost:${PORT}`)}`);
info(`Press ${c(B, 'Ctrl+C')} to stop`);

// ── Start processes ──────────────────────────────────────────────────────────
launch(PROC_CSS, () => scriptArgs('watch:css'), true);

launch(PROC_SERVER, () => ({
  command: process.execPath,
  args: [
    '--watch-path=index.html',
    '--watch-path=src',
    '--watch-path=js',
    path.join(__dirname, 'dev-server.cjs'),  // eslint-disable-line
    '--root', '.',
    '--port', String(PORT),
  ],
}), true);


