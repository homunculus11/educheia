const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT_DIR = process.cwd();
const IGNORED_DIRS = new Set(['node_modules', '.git']);
const SOURCE_SUFFIX = '.tailwind.css';

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function walkDir(dirPath, result = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkDir(fullPath, result);
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(SOURCE_SUFFIX)) {
      result.push(fullPath);
    }
  }

  return result;
}

function getSourceFiles() {
  return walkDir(ROOT_DIR).sort((a, b) => a.localeCompare(b));
}

function getOutputFile(sourceFile) {
  return sourceFile.replace(/\.tailwind\.css$/i, '.css');
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readOptionValue(args, optionNames) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    for (const optionName of optionNames) {
      if (arg === optionName) {
        return args[index + 1];
      }

      if (arg.startsWith(`${optionName}=`)) {
        return arg.slice(optionName.length + 1);
      }
    }
  }

  return undefined;
}

function resolveBuildConcurrency(sourceCount, rawArgs = []) {
  const fromArgs = parsePositiveInteger(readOptionValue(rawArgs, ['--concurrency', '--parallel', '-j']));
  const fromEnv = parsePositiveInteger(process.env.TAILWIND_BUILD_CONCURRENCY);
  const requested = fromArgs || fromEnv;

  if (requested) {
    return Math.min(requested, sourceCount);
  }

  const cpuCount = Array.isArray(os.cpus()) && os.cpus().length > 0 ? os.cpus().length : 1;
  const defaultConcurrency = Math.max(1, cpuCount - 1);
  return Math.min(defaultConcurrency, sourceCount);
}

function getTailwindCommand() {
  return process.execPath;
}

function getTailwindArgs(sourceFile, outputFile, watch = false) {
  const cliPath = require.resolve('tailwindcss/lib/cli.js');
  const args = [cliPath, '-i', sourceFile, '-o', outputFile];

  if (watch) {
    args.push('--watch');
  } else {
    args.push('--minify');
  }

  return args;
}

function runTailwindOnce(sourceFile) {
  return new Promise((resolve, reject) => {
    const outputFile = getOutputFile(sourceFile);
    const command = getTailwindCommand();
    const args = getTailwindArgs(sourceFile, outputFile, false);

    const child = spawn(command, args, { stdio: 'inherit' });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Build failed for ${toPosixPath(path.relative(ROOT_DIR, sourceFile))} (exit ${code})`));
      }
    });
  });
}

async function buildAll() {
  const sources = getSourceFiles();

  if (sources.length === 0) {
    console.log('No .tailwind.css files found.');
    return;
  }

  console.log(`Found ${sources.length} source file(s).`);

  const rawArgs = process.argv.slice(3);
  const concurrency = resolveBuildConcurrency(sources.length, rawArgs);
  console.log(`Using ${concurrency} concurrent worker(s).`);

  if (concurrency === 1) {
    for (const source of sources) {
      const relSource = toPosixPath(path.relative(ROOT_DIR, source));
      const relOutput = toPosixPath(path.relative(ROOT_DIR, getOutputFile(source)));
      console.log(`Building ${relSource} -> ${relOutput}`);
      await runTailwindOnce(source);
    }
    return;
  }

  let nextIndex = 0;
  let completed = 0;

  const runWorker = async (workerId) => {
    while (nextIndex < sources.length) {
      const source = sources[nextIndex];
      nextIndex += 1;

      const relSource = toPosixPath(path.relative(ROOT_DIR, source));
      const relOutput = toPosixPath(path.relative(ROOT_DIR, getOutputFile(source)));
      console.log(`[worker ${workerId}] Building ${relSource} -> ${relOutput}`);
      await runTailwindOnce(source);
      completed += 1;
      console.log(`[worker ${workerId}] Completed ${completed}/${sources.length}`);
    }
  };

  const workers = Array.from({ length: concurrency }, (_unused, index) => runWorker(index + 1));
  await Promise.all(workers);
}

function startWatcherForFile(sourceFile) {
  const outputFile = getOutputFile(sourceFile);
  const relSource = toPosixPath(path.relative(ROOT_DIR, sourceFile));
  const relOutput = toPosixPath(path.relative(ROOT_DIR, outputFile));
  const command = getTailwindCommand();
  const args = getTailwindArgs(sourceFile, outputFile, true);

  console.log(`Watching ${relSource} -> ${relOutput}`);

  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(`Watcher error for ${relSource}:`, error.message);
  });

  return child;
}

function watchAll() {
  const watchers = new Map();

  const syncWatchers = () => {
    const currentFiles = new Set(getSourceFiles());

    for (const sourceFile of currentFiles) {
      if (!watchers.has(sourceFile)) {
        const child = startWatcherForFile(sourceFile);
        watchers.set(sourceFile, child);
      }
    }

    for (const [sourceFile, child] of watchers.entries()) {
      if (!currentFiles.has(sourceFile)) {
        const relSource = toPosixPath(path.relative(ROOT_DIR, sourceFile));
        console.log(`Stopping watcher for removed file ${relSource}`);
        child.kill('SIGTERM');
        watchers.delete(sourceFile);
      }
    }

    if (watchers.size === 0) {
      console.log('No .tailwind.css files found yet. Waiting for new files...');
    }
  };

  syncWatchers();
  const intervalId = setInterval(syncWatchers, 2000);

  const shutdown = () => {
    clearInterval(intervalId);

    for (const child of watchers.values()) {
      child.kill('SIGTERM');
    }

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const mode = process.argv[2];

  if (mode === 'build') {
    await buildAll();
    return;
  }

  if (mode === 'watch') {
    watchAll();
    return;
  }

  console.error('Usage: node scripts/tailwind-auto.cjs <build|watch> [--concurrency <n>]');
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
