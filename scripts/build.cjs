const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const COPY_ITEMS = ['images', 'js', 'src', 'index.html', 'robots.txt', 'sitemap.xml'];
const FINGERPRINT_EXTENSIONS = new Set(['.js', '.css']);
const REFERENCE_EXTENSIONS = new Set(['.html', '.js']);
const DIVIDER = '='.repeat(64);

function logHeader(title) {
  console.log(`\n${DIVIDER}`);
  console.log(title);
  console.log(DIVIDER);
}

function logStep(message) {
  console.log(`- ${message}`);
}

function logSummary(lines) {
  console.log('\nBuild Summary');
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

function formatDuration(durationMs) {
  const seconds = durationMs / 1000;
  return `${seconds.toFixed(2)}s`;
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function toModuleRelativePath(fromAbsDir, toAbsFile) {
  const relative = toPosixPath(path.relative(fromAbsDir, toAbsFile));
  if (!relative || (!relative.startsWith('.') && !relative.startsWith('/'))) {
    return `./${relative}`;
  }
  return relative;
}

function walkFiles(rootDir) {
  const files = [];

  if (!fs.existsSync(rootDir)) {
    return files;
  }

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function buildFingerprintName(fileName, contentBuffer) {
  const parsed = path.parse(fileName);
  const digest = crypto.createHash('sha256').update(contentBuffer).digest('hex').slice(0, 10);
  return `${parsed.name}.${digest}${parsed.ext}`;
}

function fingerprintAssets() {
  const allFiles = walkFiles(DIST_DIR);
  const fingerprintEntries = allFiles
    .filter((filePath) => FINGERPRINT_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .map((filePath) => ({
      absPath: filePath,
      relPath: toPosixPath(path.relative(DIST_DIR, filePath)),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  const manifest = {};

  for (const entry of fingerprintEntries) {
    const buffer = fs.readFileSync(entry.absPath);
    const nextName = buildFingerprintName(path.basename(entry.absPath), buffer);
    const nextAbsPath = path.join(path.dirname(entry.absPath), nextName);
    const nextRelPath = toPosixPath(path.relative(DIST_DIR, nextAbsPath));

    fs.renameSync(entry.absPath, nextAbsPath);
    manifest[entry.relPath] = nextRelPath;
  }

  fs.writeFileSync(
    path.join(DIST_DIR, 'asset-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  console.log(`  Fingerprinted ${Object.keys(manifest).length} asset(s).`);
  return manifest;
}

function rewriteAssetReferences(manifest) {
  const entries = Object.entries(manifest);
  if (entries.length === 0) {
    return { scannedFiles: 0, rewrittenFiles: 0 };
  }

  const targetFiles = walkFiles(DIST_DIR)
    .filter((filePath) => REFERENCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));

  const pathTokenRegex = /(["'])([^"'#?]+\.(?:js|css))((?:\?[^"'#]*)?)(#[^"']*)?\1/g;
  let rewrittenFiles = 0;

  for (const filePath of targetFiles) {
    const original = fs.readFileSync(filePath, 'utf8');
    const fileDir = path.dirname(filePath);

    const rewritten = original.replace(pathTokenRegex, (fullMatch, quote, targetPath, query = '', hash = '') => {
      if (/^(?:https?:)?\/\//i.test(targetPath) || targetPath.startsWith('data:')) {
        return fullMatch;
      }

      const resolvedAbsPath = targetPath.startsWith('/')
        ? path.join(DIST_DIR, targetPath.replace(/^\/+/, ''))
        : path.resolve(fileDir, targetPath);

      const resolvedRelPath = toPosixPath(path.relative(DIST_DIR, resolvedAbsPath));
      const mappedRelPath = manifest[resolvedRelPath];
      if (!mappedRelPath) {
        return fullMatch;
      }

      const mappedAbsPath = path.join(DIST_DIR, mappedRelPath);

      let nextTarget;
      if (targetPath.startsWith('/')) {
        nextTarget = `/${mappedRelPath}`;
      } else {
        const moduleRelative = toModuleRelativePath(fileDir, mappedAbsPath);
        if (targetPath.startsWith('./') && !moduleRelative.startsWith('./') && !moduleRelative.startsWith('../')) {
          nextTarget = `./${moduleRelative}`;
        } else if (!targetPath.startsWith('./') && !targetPath.startsWith('../') && !targetPath.startsWith('/') && moduleRelative.startsWith('./')) {
          nextTarget = moduleRelative.slice(2);
        } else {
          nextTarget = moduleRelative;
        }
      }

      return `${quote}${nextTarget}${query || ''}${hash || ''}${quote}`;
    });

    if (rewritten !== original) {
      fs.writeFileSync(filePath, rewritten, 'utf8');
      rewrittenFiles += 1;
    }
  }

  console.log(`  Updated references in ${rewrittenFiles}/${targetFiles.length} file(s).`);
  return { scannedFiles: targetFiles.length, rewrittenFiles };
}

function runNpmScript(scriptName) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmExecPath ? [npmExecPath, 'run', scriptName] : ['run', scriptName];

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: ROOT_DIR,
    shell: !npmExecPath && process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`npm run ${scriptName} failed with exit code ${result.status}`);
  }
}

function cleanDist() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

function copyIfExists(relPath) {
  const srcPath = path.join(ROOT_DIR, relPath);
  const destPath = path.join(DIST_DIR, relPath);

  if (!fs.existsSync(srcPath)) {
    console.log(`  Skipped missing path: ${relPath}`);
    return false;
  }

  fs.cpSync(srcPath, destPath, { recursive: true });
  console.log(`  Copied ${relPath}`);
  return true;
}

function copyBuiltCssOnly() {
  const cssSourceDir = path.join(ROOT_DIR, 'css');
  const cssDestDir = path.join(DIST_DIR, 'css');

  if (!fs.existsSync(cssSourceDir)) {
    console.log('  Skipped missing path: css');
    return 0;
  }

  fs.mkdirSync(cssDestDir, { recursive: true });

  const entries = fs.readdirSync(cssSourceDir, { withFileTypes: true });
  let copiedCount = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith('.css') || entry.name.endsWith('.tailwind.css')) {
      continue;
    }

    const srcFile = path.join(cssSourceDir, entry.name);
    const destFile = path.join(cssDestDir, entry.name);
    fs.copyFileSync(srcFile, destFile);
    copiedCount += 1;
  }

  console.log(`  Copied ${copiedCount} compiled CSS file(s) to dist/css`);
  return copiedCount;
}

function main() {
  const startedAt = Date.now();
  logHeader('Educheia Build');

  logStep('Building CSS...');
  runNpmScript('build:css');

  logStep('Preparing dist artifact...');
  cleanDist();

  let copiedPaths = 0;
  for (const item of COPY_ITEMS) {
    if (copyIfExists(item)) {
      copiedPaths += 1;
    }
  }

  logStep('Copying compiled CSS...');
  const copiedCssFiles = copyBuiltCssOnly();

  logStep('Fingerprinting static assets...');
  const manifest = fingerprintAssets();

  logStep('Rewriting asset references...');
  const rewriteStats = rewriteAssetReferences(manifest);

  const fingerprintedAssets = Object.keys(manifest).length;
  const duration = formatDuration(Date.now() - startedAt);
  logSummary([
    `Copied paths: ${copiedPaths}/${COPY_ITEMS.length}`,
    `Compiled CSS files copied: ${copiedCssFiles}`,
    `Fingerprinted assets: ${fingerprintedAssets}`,
    `Files with rewritten references: ${rewriteStats.rewrittenFiles}/${rewriteStats.scannedFiles}`,
    `Duration: ${duration}`,
  ]);
}

try {
  main();
} catch (error) {
  console.error(`Build failed: ${error.message || error}`);
  process.exit(1);
}