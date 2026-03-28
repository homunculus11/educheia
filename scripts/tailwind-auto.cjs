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

function tailwindCmd(src, out, watch = false) {
  const cli  = require.resolve('tailwindcss/lib/cli.js');
  const args = [cli, '-i', src, '-o', out, watch ? '--watch' : '--minify'];
  return { bin: process.execPath, args };
}

// ── Build ─────────────────────────────────────────────────────────────────────
function buildOne(src, label) {
  return new Promise((resolve, reject) => {
    const out       = outputFor(src);
    const { bin, args } = tailwindCmd(src, out, false);
    const child     = spawn(bin, args, { stdio: 'inherit' });
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
      console.log(`  ${c(GRN, '✔')}  [${String(completed).padStart(String(totalSteps).length)}/${totalSteps}]  ${c(D, rel(src))}  ${c(D, elapsed(tFile))}`);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log();
  log(`Built ${totalSteps} file(s) in ${elapsed(t0)}`);
}

// ── Watch ─────────────────────────────────────────────────────────────────────
function watchFile(src) {
  const out       = outputFor(src);
  const { bin, args } = tailwindCmd(src, out, true);
  info(`Watching ${c(D, rel(src))} → ${c(D, rel(out))}`);

  const child = spawn(bin, args, { stdio: 'inherit' });
  child.on('error', (err) => error(`Watcher error [${rel(src)}]: ${err.message}`));
  return child;
}

function watchAll() {
  divider('Tailwind CSS Watch');
  const watchers = new Map();

  const sync = () => {
    const current = new Set(getSources());

    for (const src of current) {
      if (!watchers.has(src)) watchers.set(src, watchFile(src));
    }

    for (const [src, child] of watchers) {
      if (!current.has(src)) {
        info(`Stopping watcher: ${rel(src)}`);
        child.kill('SIGTERM');
        watchers.delete(src);
      }
    }

    if (watchers.size === 0) warn('No .tailwind.css files found yet — waiting…');
  };

  sync();
  const id = setInterval(sync, 2_000);

  const quit = () => {
    clearInterval(id);
    for (const child of watchers.values()) child.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

// ── Entry ─────────────────────────────────────────────────────────────────────
async function main() {
  const [,, mode, ...rawArgs] = process.argv;

  if (mode === 'build') { await buildAll(rawArgs); return; }
  if (mode === 'watch') { watchAll(); return; }

  error('Usage: node scripts/tailwind-auto.cjs <build|watch> [--concurrency <n>]');
  process.exit(1);
}

main().catch((e) => { error(e.message || String(e)); process.exit(1); });
