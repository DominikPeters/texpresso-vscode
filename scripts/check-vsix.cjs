const fs = require('node:fs');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

// Read the small ZIP produced by vsce without another runtime dependency.
function readVSIX(file) {
  const bytes = fs.readFileSync(file);
  const end = bytes.lastIndexOf(Buffer.from('504b0506', 'hex'));
  assert.ok(end >= 0, 'VSIX has a ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const files = new Map();
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
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    cursor += 46 + nameLength + extra + comment;
  }
  return files;
}

function checkVSIX(file) {
  const files = readVSIX(file);
  const allowed = ['package.json', 'readme.md', 'LICENSE.txt', 'assets/texpresso_logo.png', 'dist/extension.js',
    'media/preview.js', 'media/preview.css', 'media/preview-lens.js', 'media/preview-viewport.js', 'media/codicons-LICENSE'];
  assert.deepEqual([...files.keys()].filter(name => name.startsWith('extension/')).sort(),
    allowed.map(name => 'extension/' + name).sort(), 'VSIX contains exactly the production payload');
  for (const name of allowed) {
    assert.deepEqual(files.get('extension/' + name), fs.readFileSync(name === 'readme.md' ? 'README.md' : name === 'LICENSE.txt' ? 'LICENSE' : name), name + ' is current');
  }
  const manifest = JSON.parse(files.get('extension/package.json').toString());
  assert.ok(files.has('extension/' + manifest.main.replace(/^\.\//, '')), 'runtime entry point packaged');
  assert.ok(files.has('extension/' + manifest.icon.replace(/^\.\//, '')), 'extension icon packaged');
  console.log('PASS: VSIX production files and manifest (' + fs.statSync(file).size + ' bytes)');
}
module.exports = { checkVSIX };
if (require.main === module) { checkVSIX(process.argv[2]); }
