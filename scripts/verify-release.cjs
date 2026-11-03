const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readVSIX } = require('./check-vsix.cjs');
const { targets, sha256, productionFiles } = require('./vsix-payload.cjs');
const { validateNativeLicenses, validateSourceInfo, sourceName, hashFile } = require('./release-licensing.cjs');

function verifyRelease(directory, root = path.resolve(__dirname, '..')) {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.match(expected.version, /^2\.\d+\.\d+$/, 'publish a stable v2 release');
  const revision = execFileSync('git', ['rev-parse', ':native/texpresso'], { cwd: root, encoding: 'utf8' }).trim();
  const extensionRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const names = [...targets, 'universal'].map(target => `texpresso-${target}.vsix`);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.vsix')).sort(), [...names].sort(), 'complete release target set');
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tar.gz')).sort(),
    [...targets, 'universal'].map(target => sourceName(expected.version, target)).sort(), 'complete corresponding source set');
  for (const target of [...targets, 'universal']) {
    const sourceFile = path.join(directory, sourceName(expected.version, target));
    const source = JSON.parse(fs.readFileSync(sourceFile + '.json'));
    validateSourceInfo(source, expected.version, target, extensionRevision, revision);
    assert.equal(hashFile(sourceFile), source.sha256, 'corresponding source checksum');
    assert.equal(fs.statSync(sourceFile).size, source.bytes);
    assert.equal(fs.readFileSync(sourceFile + '.sha256', 'utf8').trim().split(/\s+/)[0], source.sha256, 'source checksum sidecar');
    const name = `texpresso-${target}.vsix`, filename = path.join(directory, name);
    const checksum = fs.readFileSync(filename + '.sha256', 'utf8').trim().split(/\s+/)[0];
    assert.equal(checksum, sha256(fs.readFileSync(filename)), name + ' checksum');
    const files = readVSIX(filename);
    const manifest = JSON.parse(files.get('extension/package.json'));
    for (const key of ['publisher', 'name', 'version']) { assert.equal(manifest[key], expected[key], name + ' ' + key); }
    const platform = files.get('extension.vsixmanifest').toString().match(/TargetPlatform="([^"]+)"/)?.[1];
    assert.equal(platform, target === 'universal' ? undefined : target, name + ' platform');
    const allowed = new Set(productionFiles.map(file => 'extension/' + (file === 'README.md' ? 'readme.md' : file)));
    if (target !== 'universal') {
      const prefix = 'extension/runtime/' + target + '/';
      const native = JSON.parse(files.get(prefix + 'build-manifest.json'));
      assert.equal(native.engineRevision, revision, name + ' engine pin');
      assert.equal(native.platform + '-' + (native.architecture === 'x86_64' ? 'x64' : native.architecture), target);
      assert.equal(native.features.embeddedPreview, true);
      assert.equal(native.capabilities.previewProtocol, 1);
      if (target.startsWith('darwin-')) {
        assert.equal(native.signing?.kind, 'developer-id', 'Developer ID signing is required');
        assert.equal(native.signing?.hardenedRuntime, true);
        assert.equal(native.signing?.secureTimestamp, true);
        // The build workflow uploads a candidate only after Apple's Accepted
        // response and installed-VSIX acceptance, not merely after signing.
      }
      allowed.add(prefix + 'build-manifest.json');
      const hashed = new Set();
      for (const entry of native.files) {
        assert.ok(!hashed.has(entry.path), 'unique native manifest path');
        const data = files.get(prefix + entry.path);
        assert.ok(data, 'native file exists: ' + entry.path);
        assert.equal(sha256(data), entry.sha256, 'native file hash: ' + entry.path);
        assert.equal(data.length, entry.bytes);
        allowed.add(prefix + entry.path); hashed.add(entry.path);
      }
      for (const binary of ['bin/texpresso', 'bin/texpresso-xetex']) {
        assert.ok(hashed.has(binary), 'complete executable pair');
        assert.ok(files.modes.get(prefix + binary) & 0o111, 'native executable permissions');
      }
      const notices = [...files.keys()].filter(file => file.startsWith(prefix + 'notices/'));
      assert.ok(notices.length, 'dependency notices');
      notices.forEach(file => allowed.add(file));
      validateNativeLicenses(native, name => files.get(prefix + name), notices.map(name => name.slice(prefix.length)));
      assert.deepEqual(native.sourceArchive, source, 'VSIX is paired with the exact corresponding source archive');
    }
    assert.deepEqual([...files.keys()].filter(file => file.startsWith('extension/')).sort(), [...allowed].sort(), 'only production payload');
    console.log('Verified ' + name + ' / ' + expected.publisher + '.' + expected.name + '@' + expected.version);
  }
  return names;
}
function releaseAssets(directory, root = path.resolve(__dirname, '..')) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  return [...targets, 'universal'].flatMap(target => {
    const vsix = `texpresso-${target}.vsix`, source = sourceName(version, target);
    return [vsix, vsix + '.sha256', source, source + '.sha256', source + '.json'];
  }).map(name => ({ name, sha256: hashFile(path.join(directory, name)), bytes: fs.statSync(path.join(directory, name)).size }));
}
module.exports = { verifyRelease, releaseAssets };
if (require.main === module) { verifyRelease(path.resolve(process.argv[2] || 'artifacts')); }
