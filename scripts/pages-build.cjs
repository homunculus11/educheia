const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const COPY_ITEMS = ['assets', 'images', 'js', 'src', 'index.html', 'robots.txt', 'sitemap.xml'];
const FINGERPRINT_EXTENSIONS = new Set(['.js', '.css']);
const REFERENCE_EXTENSIONS = new Set(['.html', '.js']);

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

  console.log(`Fingerprinted ${Object.keys(manifest).length} asset(s).`);
  return manifest;
}

function rewriteAssetReferences(manifest) {
  const entries = Object.entries(manifest);
  if (entries.length === 0) {
    return;
  }

  const targetFiles = walkFiles(DIST_DIR)
    .filter((filePath) => REFERENCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));

  const pathTokenRegex = /(["'])([^"'#?]+\.(?:js|css))((?:\?[^"'#]*)?)(#[^"']*)?\1/g;

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
    }
  }

  console.log(`Rewrote asset references in ${targetFiles.length} file(s).`);
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
    console.log(`Skipping missing path: ${relPath}`);
    return;
  }

  fs.cpSync(srcPath, destPath, { recursive: true });
  console.log(`Copied ${relPath}`);
}

function copyBuiltCssOnly() {
  const cssSourceDir = path.join(ROOT_DIR, 'css');
  const cssDestDir = path.join(DIST_DIR, 'css');

  if (!fs.existsSync(cssSourceDir)) {
    console.log('Skipping missing path: css');
    return;
  }

  fs.mkdirSync(cssDestDir, { recursive: true });

  const entries = fs.readdirSync(cssSourceDir, { withFileTypes: true });
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
  }

  console.log('Copied compiled CSS files to dist/css');
}

function listDistFiles() {
  const files = [];

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(toPosixPath(path.relative(DIST_DIR, fullPath)));
      }
    }
  }

  walk(DIST_DIR);
  files.sort((a, b) => a.localeCompare(b));

  console.log('Dist artifact contents:');
  for (const file of files) {
    console.log(file);
  }
}

function main() {
  console.log('Building CSS...');
  runNpmScript('build:css');

  console.log('Preparing dist artifact...');
  cleanDist();

  for (const item of COPY_ITEMS) {
    copyIfExists(item);
  }

  copyBuiltCssOnly();
  const manifest = fingerprintAssets();
  rewriteAssetReferences(manifest);
  listDistFiles();
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}