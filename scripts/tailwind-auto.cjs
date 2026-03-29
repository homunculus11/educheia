'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');
const { log, warn, error, info, divider, elapsed, c, B, D, GRN, YLW, CYN, R } = require('./_logger.cjs');

// ── Config ───────────────────────────────────────────────────────────────────
const ROOT_DIR    = process.cwd();
const IGNORED     = new Set(['node_modules', '.git', 'dist']);
const SOURCE_SUFFIX = '.tailwind.css';

// ── Utilities ────────────────────────────────────────────────────────────────
const posix = (p) => p.split(path.sep).join('/');
const rel   = (p) => posix(path.relative(ROOT_DIR, p));

function walkForSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED.has(entry.name)) walkForSources(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(SOURCE_SUFFIX)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const getSources   = () => walkForSources(ROOT_DIR).sort((a, b) => a.localeCompare(b));
const outputFor    = (src) => src.replace(/\.tailwind\.css$/i, '.css');

function readArgValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name)              return args[i + 1];
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
}

function parseConcurrency(sources, rawArgs) {
  const fromArg = Number.parseInt(readArgValue(rawArgs, ['--concurrency', '--parallel', '-j']), 10);
  const fromEnv = Number.parseInt(process.env.TAILWIND_BUILD_CONCURRENCY ?? '', 10);
  const requested = (Number.isFinite(fromArg) && fromArg > 0) ? fromArg
                  : (Number.isFinite(fromEnv) && fromEnv > 0) ? fromEnv
                  : null;
  if (requested) return Math.min(requested, sources.length);

  const cpus = os.cpus()?.length || 1;
  return Math.min(Math.max(1, cpus - 1), sources.length);
}

function tailwindCmd(src, out, options = {}) {
  const { watch = false, poll = false } = options;
  const cli  = require.resolve('tailwindcss/lib/cli.js');
  const args = [cli, '-i', src, '-o', out];

  if (watch) {
    // "always" prevents watch mode from exiting when stdin is not interactive.
    args.push('--watch=always');
    if (poll) args.push('--poll');
  } else {
    args.push('--minify');
  }

  return { bin: process.execPath, args };
}

function parseWatchOptions(rawArgs) {
  const pollArg = rawArgs.includes('--poll');
  const pollEnv = /^(1|true|yes)$/i.test(String(process.env.TAILWIND_WATCH_POLL || ''));
  return { poll: pollArg || pollEnv };
}

function createLineScanner(onLine) {
  let buffer = '';

  const push = (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      onLine(line);
    }
  };

  const flush = () => {
    const line = buffer.trim();
    if (line) onLine(line);
    buffer = '';
  };

  return { push, flush };
}

const stripAnsi = (s) => String(s || '').replace(/\x1B\[[0-9;]*m/g, '');

function isSuppressedTailwindLine(cleanLine) {
  return cleanLine.includes('browserslist: caniuse-lite is outdated')
      || cleanLine.includes('update-browserslist-db@latest')
      || cleanLine.includes('why you should do it regularly');
}

function classifyTailwindLine(line) {
  const cleanLine = stripAnsi(line).toLowerCase();

  if (!cleanLine) return { type: 'ignore', cleanLine };
  if (isSuppressedTailwindLine(cleanLine)) return { type: 'ignore', cleanLine };
  if (/^done in\s+\d+(?:\.\d+)?m?s\.?$/i.test(cleanLine)) return { type: 'done', cleanLine };
  if (/\brebuild(?:ing)?\b/i.test(cleanLine)) return { type: 'rebuild', cleanLine };
  if (/\berror\b|\berr!\b/i.test(cleanLine)) return { type: 'error', cleanLine };
  if (/\bwarn(?:ing)?\b/i.test(cleanLine)) return { type: 'warn', cleanLine };
  return { type: 'other', cleanLine };
}

function attachBuildOutputHandlers(child, src) {
  const srcRel = rel(src);

  const onLine = (rawLine) => {
    const line = String(rawLine || '').trim();
    if (!line) return;

    const parsed = classifyTailwindLine(line);

    if (parsed.type === 'ignore' || parsed.type === 'done' || parsed.type === 'rebuild' || parsed.type === 'other') return;
    if (parsed.type === 'warn') { warn(`[${srcRel}] ${line}`); return; }
    if (parsed.type === 'error') { error(`[${srcRel}] ${line}`); }
  };

  const stdout = createLineScanner(onLine);
  const stderr = createLineScanner(onLine);

  child.stdout.on('data', stdout.push);
  child.stderr.on('data', stderr.push);
  child.stdout.on('end', stdout.flush);
  child.stderr.on('end', stderr.flush);
}

function attachWatchOutputHandlers(child, src, out) {
  let bootstrapping   = true;
  let rebuildAnnounced = false;
  const srcRel = rel(src);
  const outRel = rel(out);

  const onLine = (rawLine) => {
    const line = String(rawLine || '').trim();
    if (!line) return;

    const parsed = classifyTailwindLine(line);
    if (parsed.type === 'ignore') return;

    if (parsed.type === 'done') {
      if (bootstrapping) bootstrapping = false;
      rebuildAnnounced = false;
      return;
    }

    if (parsed.type === 'rebuild') {
      if (bootstrapping) return;
      if (!rebuildAnnounced) {
        info(`Change detected: ${c(D, srcRel)} → building ${c(D, outRel)}`);
        rebuildAnnounced = true;
      }
      return;
    }

    if (parsed.type === 'warn') {
      warn(`[${srcRel}] ${line}`);
      return;
    }

    if (parsed.type === 'error') {
      error(`[${srcRel}] ${line}`);
      return;
    }

    // Keep unexpected lines visible while still suppressing Tailwind timing noise.
    info(`[${srcRel}] ${line}`);
  };

  const stdout = createLineScanner(onLine);
  const stderr = createLineScanner(onLine);

  child.stdout.on('data', stdout.push);
  child.stderr.on('data', stderr.push);
  child.stdout.on('end', stdout.flush);
  child.stderr.on('end', stderr.flush);
}

// ── Build ─────────────────────────────────────────────────────────────────────
function buildOne(src, label) {
  return new Promise((resolve, reject) => {
    const out       = outputFor(src);
    const { bin, args } = tailwindCmd(src, out, { watch: false });
    const child     = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    attachBuildOutputHandlers(child, src);
    child.on('error', reject);
    child.on('exit', (code) => {
      code === 0
        ? resolve()
        : reject(new Error(`Tailwind failed for ${label} (exit ${code})`));
    });
  });
}

async function buildAll(rawArgs) {
  const sources     = getSources();
  const totalSteps  = sources.length;
  const t0          = Date.now();

  if (sources.length === 0) { warn('No .tailwind.css source files found'); return; }

  const concurrency = parseConcurrency(sources, rawArgs);
  divider('Tailwind CSS Build');
  info(`Found ${c(B, String(totalSteps))} source file(s)  ·  concurrency ${c(B, String(concurrency))}`);

  let completed = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < sources.length) {
      const src   = sources[nextIndex++];
      const out   = outputFor(src);
      const label = `${rel(src)} → ${rel(out)}`;
      const tFile = Date.now();

      await buildOne(src, label);

      completed++;
      log(`[${String(completed).padStart(String(totalSteps).length)}/${totalSteps}] built ${c(D, rel(src))} in ${c(D, elapsed(tFile))}`);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log();
  log(`Built ${totalSteps} file(s) in ${elapsed(t0)}`);
}

// ── Watch ─────────────────────────────────────────────────────────────────────
function watchFile(src, watchOptions) {
  const out       = outputFor(src);
  const { bin, args } = tailwindCmd(src, out, { watch: true, poll: watchOptions.poll });
  info(`Watching ${c(D, rel(src))} → ${c(D, rel(out))}`);

  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  attachWatchOutputHandlers(child, src, out);
  child.on('error', (err) => error(`Watcher error [${rel(src)}]: ${err.message}`));
  return child;
}

function watchAll(rawArgs) {
  divider('Tailwind CSS Watch');
  const watchOptions = parseWatchOptions(rawArgs);
  if (watchOptions.poll) info(`Watch mode ${c(B, 'polling')} enabled`);

  const watchers = new Map();
  let stopping   = false;

  const startWatcher = (src) => {
    const child = watchFile(src, watchOptions);
    watchers.set(src, child);

    child.on('exit', (code, signal) => {
      const stillTracked = watchers.get(src) === child;
      const expectedStop = stopping || !stillTracked || signal === 'SIGTERM';
      if (expectedStop) return;

      const reason = signal ? `signal ${signal}` : `code ${code}`;
      warn(`Watcher exited [${rel(src)}] with ${reason}; restarting…`);

      setTimeout(() => {
        if (stopping) return;
        if (watchers.get(src) !== child) return;
        startWatcher(src);
      }, 400);
    });
  };

  const sync = () => {
    const current = new Set(getSources());

    for (const src of current) {
      if (!watchers.has(src)) startWatcher(src);
    }

    for (const [src, child] of watchers) {
      if (!current.has(src)) {
        info(`Stopping watcher: ${rel(src)}`);
        watchers.delete(src);
        child.kill('SIGTERM');
      }
    }

    if (watchers.size === 0) warn('No .tailwind.css files found yet — waiting…');
  };

  sync();
  const id = setInterval(sync, 2_000);

  const quit = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(id);
    for (const [src, child] of watchers) {
      watchers.delete(src);
      child.kill('SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

// ── Entry ─────────────────────────────────────────────────────────────────────
async function main() {
  const [,, mode, ...rawArgs] = process.argv;

  if (mode === 'build') { await buildAll(rawArgs); return; }
  if (mode === 'watch') { watchAll(rawArgs); return; }

  error('Usage: node scripts/tailwind-auto.cjs <build|watch> [--concurrency <n>] [--poll]');
  process.exit(1);
}

main().catch((e) => { error(e.message || String(e)); process.exit(1); });
