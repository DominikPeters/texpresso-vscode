import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

const { validateBundle, sha256 } = require('../../scripts/vsix-payload.cjs');
const { requiredNotices, sourceName, sourceURL } = require('../../scripts/release-licensing.cjs');

test('native packaging rejects wrong architectures, stale pins, and modified or incomplete engine payloads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'txp-vsix-bundle-'));
  const root = path.resolve(__dirname, '../..');
  try {
    await fs.mkdir(path.join(directory, 'bin'));
    await fs.mkdir(path.join(directory, 'notices'));
    const licenseFiles = [];
    for (const name of requiredNotices as string[]) {
      const bytes = Buffer.from(name.endsWith('COMPONENTS.json') ? JSON.stringify(
        ['tmp', 'wsl-path', 'mupdf', 'lcms2', 'zlib-ng', 'icu'].map(name => ({ name }))) : 'complete license fixture');
      await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await fs.writeFile(path.join(directory, name), bytes);
      licenseFiles.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const files = [];
    for (const name of ['texpresso', 'texpresso-xetex']) {
      const bytes = Buffer.from(name);
      await fs.writeFile(path.join(directory, 'bin', name), bytes);
      await fs.chmod(path.join(directory, 'bin', name), 0o755);
      files.push({ path: 'bin/' + name, sha256: sha256(bytes), bytes: bytes.length });
    }
    const revision = execFileSync('git', ['rev-parse', ':native/texpresso'], { cwd: root, encoding: 'utf8' }).trim();
    const extensionRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
    const manifest = { platform: 'darwin', architecture: 'arm64', engineRevision: revision,
      features: { embeddedPreview: true }, capabilities: { previewProtocol: 1 }, files, licenseFiles,
      sourceArchive: { name: sourceName(version, 'darwin-arm64'), url: sourceURL(version, 'darwin-arm64'),
        target: 'darwin-arm64', version, extensionRevision, engineRevision: revision, sha256: 'a'.repeat(64), bytes: 100 } };
    const save = () => fs.writeFile(path.join(directory, 'build-manifest.json'), JSON.stringify(manifest));
    await save();
    assert.equal(validateBundle(directory, 'darwin-arm64', root).length, 3 + requiredNotices.length);
    assert.throws(() => validateBundle(directory, 'darwin-x64', root), /architecture/);
    manifest.engineRevision = '0'.repeat(40); await save();
    assert.throws(() => validateBundle(directory, 'darwin-arm64', root), /submodule pin/);
    manifest.engineRevision = revision; await save();
    await fs.writeFile(path.join(directory, 'bin', 'texpresso'), 'tampered');
    assert.throws(() => validateBundle(directory, 'darwin-arm64', root), /hash mismatch/);
    await fs.writeFile(path.join(directory, 'bin', 'texpresso'), 'texpresso');
    await fs.writeFile(path.join(directory, 'extra-library'), 'unrecorded');
    assert.throws(() => validateBundle(directory, 'darwin-arm64', root), /Unrecorded bundle file/);
    await fs.rm(path.join(directory, 'extra-library'));
    if (process.platform !== 'win32') {
      await fs.chmod(path.join(directory, 'bin', 'texpresso'), 0o644);
      assert.throws(() => validateBundle(directory, 'darwin-arm64', root), /Missing executable/);
      await fs.chmod(path.join(directory, 'bin', 'texpresso'), 0o755);
    }
    await fs.rm(path.join(directory, 'bin', 'texpresso-xetex'));
    assert.throws(() => validateBundle(directory, 'darwin-arm64', root), /Invalid manifest file/);
    await fs.writeFile(path.join(directory, 'bin', 'texpresso-xetex'), 'texpresso-xetex');
    await fs.chmod(path.join(directory, 'bin', 'texpresso-xetex'), 0o755);
    await fs.writeFile(path.join(directory, requiredNotices[0]), 'incomplete replacement');
    assert.throws(() => validateBundle(directory, 'darwin-arm64', root), /license file hash/);
    await fs.writeFile(path.join(directory, requiredNotices[0]), 'complete license fixture');
    manifest.sourceArchive.engineRevision = '2'.repeat(40); await save();
    assert.throws(() => validateBundle(directory, 'darwin-arm64', root), /source engine revision/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
