const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateNativeLicenses, validateSourceInfo } = require('./release-licensing.cjs');

const productionFiles = ['package.json', 'README.md', 'LICENSE', 'assets/texpresso_logo.png', 'dist/extension.js',
  'media/preview.js', 'media/preview-cache.js', 'media/preview-svg.js', 'media/preview-png.js', 'media/preview.css',
  'media/tikz-editor.png', 'media/tikz-editor-LICENSE', 'media/preview-lens.js', 'media/preview-viewport.js', 'media/codicons-LICENSE', 'THIRD-PARTY-NOTICES.txt',
  'licenses/tmp-MIT.txt', 'licenses/wsl-path-MIT.txt', 'licenses/AGPL-3.0.txt', 'licenses/GPL-2.0.txt',
  'licenses/GPL-3.0.txt', 'licenses/LGPL-2.1.txt', 'licenses/texpresso-MIT.txt', 'licenses/README.txt'];
const targets = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function productionManifest(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // Compilation runs before staging; installed packages need no build scripts.
  delete manifest.scripts;
  return manifest;
}
function productionBytes(file, root) {
  const bytes = fs.readFileSync(path.join(root, file));
  // The Marketplace license asset explains the mixed native distribution;
  // the source repository's original MIT grant remains unchanged.
  return file === 'LICENSE' ? Buffer.concat([bytes, Buffer.from('\n\n'), fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'))]) : bytes;
}
function bundleFiles(directory, prefix = '') {
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) { return bundleFiles(directory, relative); }
    if (!entry.isFile()) { throw new Error('Bundle contains a non-regular file: ' + relative); }
    return [relative];
  });
}
function validateBundle(directory, target, root) {
  if (!targets.includes(target)) { throw new Error('Unsupported bundled target: ' + target); }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'build-manifest.json'), 'utf8'));
  const architecture = manifest.architecture === 'x86_64' ? 'x64' : manifest.architecture;
  if (manifest.platform + '-' + architecture !== target) { throw new Error('Bundle architecture does not match ' + target); }
  const revision = execFileSync('git', ['rev-parse', ':native/texpresso'], { cwd: root, encoding: 'utf8' }).trim();
  if (manifest.engineRevision !== revision) { throw new Error('Bundle engine revision differs from the recorded submodule pin'); }
  if (!manifest.features?.embeddedPreview || manifest.capabilities?.previewProtocol !== 1) {
    throw new Error('Bundle must support the embedded preview');
  }
  const files = bundleFiles(directory);
  if (!files.some(file => file.startsWith('notices/'))) { throw new Error('Bundle dependency notices are missing'); }
  const hashed = new Set();
  for (const entry of manifest.files || []) {
    if (!files.includes(entry.path) || hashed.has(entry.path)) { throw new Error('Invalid manifest file: ' + entry.path); }
    const bytes = fs.readFileSync(path.join(directory, entry.path));
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) { throw new Error('Bundle hash mismatch: ' + entry.path); }
    hashed.add(entry.path);
  }
  for (const file of files) {
    if (file !== 'build-manifest.json' && !file.startsWith('notices/') && !hashed.has(file)) {
      throw new Error('Unrecorded bundle file: ' + file);
    }
  }
  for (const executable of ['bin/texpresso', 'bin/texpresso-xetex']) {
    if (!hashed.has(executable) || (process.platform !== 'win32' && !(fs.statSync(path.join(directory, executable)).mode & 0o111))) {
      throw new Error('Missing executable in bundle: ' + executable);
    }
  }
  validateNativeLicenses(manifest, name => fs.readFileSync(path.join(directory, name)), files);
  validateSourceInfo(manifest.sourceArchive, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
    target, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), revision);
  return files;
}
module.exports = { productionFiles, productionManifest, productionBytes, bundleFiles, validateBundle, sha256, targets };
