const fs = require('node:fs');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const path = require('node:path');
const { productionFiles, productionManifest, validateBundle } = require('./vsix-payload.cjs');
const root = path.resolve(__dirname, '..');

// Read the small ZIP produced by vsce without another runtime dependency.
function readVSIX(file) {
  const bytes = fs.readFileSync(file);
  const end = bytes.lastIndexOf(Buffer.from('504b0506', 'hex'));
  assert.ok(end >= 0, 'VSIX has a ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const files = new Map();
  files.modes = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const length = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.ok(!name.split('/').includes('..') && !name.startsWith('/'), 'safe archive path');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + length);
    assert.ok(method === 0 || method === 8, 'supported ZIP compression');
    assert.ok(!files.has(name), 'unique archive path');
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    files.modes.set(name, bytes.readUInt32LE(cursor + 38) >>> 16);
    cursor += 46 + nameLength + extra + comment;
  }
  return files;
}

function checkVSIX(file, { bundle, target } = {}) {
  const files = readVSIX(file);
  const rename = name => name === 'README.md' ? 'readme.md' : name === 'LICENSE' ? 'LICENSE.txt' : name;
  const allowed = productionFiles.map(rename);
  const nativeFiles = bundle ? validateBundle(bundle, target, root) : [];
  allowed.push(...nativeFiles.map(name => 'runtime/' + target + '/' + name));
  assert.deepEqual([...files.keys()].filter(name => name.startsWith('extension/')).sort(),
    allowed.map(name => 'extension/' + name).sort(), 'VSIX contains exactly the production payload');
  for (const name of allowed) {
    if (name === 'package.json') {
      assert.deepEqual(JSON.parse(files.get('extension/' + name)), productionManifest(root), 'production manifest is current');
      continue;
    }
    const source = name.startsWith('runtime/') ? path.join(bundle, name.slice(('runtime/' + target + '/').length)) :
      path.join(root, name === 'readme.md' ? 'README.md' : name === 'LICENSE.txt' ? 'LICENSE' : name);
    assert.deepEqual(files.get('extension/' + name), fs.readFileSync(source), name + ' is current');
  }
  const vsixManifest = files.get('extension.vsixmanifest').toString();
  if (target) {
    assert.ok(vsixManifest.includes('TargetPlatform="' + target + '"'), 'VSIX declares the native target');
    for (const name of ['texpresso', 'texpresso-xetex']) {
      assert.ok(files.modes.get('extension/runtime/' + target + '/bin/' + name) & 0o111, 'VSIX preserves executable permissions');
    }
  } else { assert.ok(!vsixManifest.includes('TargetPlatform='), 'universal package has no native target'); }
  const manifest = JSON.parse(files.get('extension/package.json').toString());
  assert.ok(files.has('extension/' + manifest.main.replace(/^\.\//, '')), 'runtime entry point packaged');
  assert.ok(files.has('extension/' + manifest.icon.replace(/^\.\//, '')), 'extension icon packaged');
  console.log('PASS: VSIX production files and manifest (' + fs.statSync(file).size + ' bytes)');
}
module.exports = { checkVSIX, readVSIX };
if (require.main === module) {
  const { values, positionals } = require('node:util').parseArgs({ allowPositionals: true,
    options: { bundle: { type: 'string' }, target: { type: 'string' } } });
  checkVSIX(positionals[0], values);
}
