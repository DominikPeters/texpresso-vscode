const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const requiredNotices = ['notices/AGPL-3.0.txt', 'notices/GPL-2.0.txt', 'notices/GPL-3.0.txt',
  'notices/LGPL-2.1.txt', 'notices/COMPONENTS.json', 'notices/BUILDING.txt',
  'notices/THIRD-PARTY-NOTICES.txt', 'notices/engine/EMBEDDED-COPYRIGHTS.txt'];
const sourceName = (version, target) => `texpresso-${version}-sources-${target}.tar.gz`;
const sourceURL = (version, target) => `https://github.com/DominikPeters/texpresso-vscode/releases/download/v${version}/${sourceName(version, target)}`;
function hashFile(filename) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(filename, 'r');
  try { for (;;) { const bytes = fs.readSync(fd, buffer); if (!bytes) { break; } hash.update(buffer.subarray(0, bytes)); } }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function validateSourceInfo(source, version, target, extensionRevision, engineRevision) {
  assert.ok(source, 'corresponding source metadata required');
  assert.equal(source.name, sourceName(version, target), 'source archive filename');
  assert.equal(source.url, sourceURL(version, target), 'permanent corresponding source URL');
  assert.equal(source.target, target); assert.equal(source.version, version);
  assert.equal(source.extensionRevision, extensionRevision, 'source extension revision');
  if (target !== 'universal') { assert.equal(source.engineRevision, engineRevision, 'source engine revision'); }
  assert.match(source.sha256, /^[a-f0-9]{64}$/, 'source archive hash');
  assert.ok(Number.isSafeInteger(source.bytes) && source.bytes > 0, 'source archive size');
}
function validateNativeLicenses(manifest, read, paths) {
  assert.ok(Array.isArray(manifest.licenseFiles), 'hashed native license inventory required');
  const declared = new Set();
  for (const entry of manifest.licenseFiles) {
    assert.ok(entry.path.startsWith('notices/') && !entry.path.split('/').includes('..'), 'safe license path');
    assert.ok(!declared.has(entry.path), 'unique license path');
    const bytes = read(entry.path);
    assert.ok(bytes, 'license file exists: ' + entry.path);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256, 'license file hash: ' + entry.path);
    assert.equal(bytes.length, entry.bytes); declared.add(entry.path);
  }
  assert.deepEqual([...declared].sort(), paths.filter(file => file.startsWith('notices/')).sort(), 'complete hashed native license inventory');
  assert.ok(requiredNotices.every(file => declared.has(file)), 'complete native license texts and build instructions');
  const components = JSON.parse(read('notices/COMPONENTS.json'));
  const names = new Set(components.map(component => component.name));
  assert.ok(['tmp', 'wsl-path', 'mupdf', 'lcms2', 'zlib-ng'].every(name => names.has(name)) &&
    (names.has('icu') || names.has('icu4c@78')), 'complete native source component inventory');
}
module.exports = { requiredNotices, sourceName, sourceURL, hashFile, validateSourceInfo, validateNativeLicenses };
