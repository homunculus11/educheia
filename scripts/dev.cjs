const { spawn } = require('child_process');

const ROOT_DIR = process.cwd();

function runProcess(command, args, name, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    ...options
  });

  child.on('error', (error) => {
    console.error(`[${name}] failed to start: ${error.message}`);
  });

  return child;
}

function runPackageScript(scriptName) {
  if (process.env.npm_execpath) {
    return runProcess(process.execPath, [process.env.npm_execpath, 'run', scriptName], scriptName);
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return runProcess(npmCmd, ['run', scriptName], scriptName, { shell: process.platform === 'win32' });
}

const children = [];
let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 150);
}

const cssWatcher = runPackageScript('watch:css');
const devServer = runProcess(process.execPath, [
  '--watch-path=index.html',
  '--watch-path=src',
  '--watch-path=js',
  './scripts/dev-server.cjs',
  '--root',
  '.',
  '--port',
  '5173'
], 'dev-server');

children.push(cssWatcher, devServer);

for (const child of children) {
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) {
      shutdown(code || 1);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));