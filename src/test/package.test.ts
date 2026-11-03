import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

const { validateBundle, sha256 } = require('../../scripts/vsix-payload.cjs');

test('native packaging rejects wrong architectures, stale pins, and modified or incomplete engine payloads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'txp-vsix-bundle-'));
  const root = path.resolve(__dirname, '../..');
  try {
    await fs.mkdir(path.join(directory, 'bin'));
    await fs.mkdir(path.join(directory, 'notices'));
    await fs.writeFile(path.join(directory, 'notices', 'LICENSE'), 'dependency notice');
    const files = [];
    for (const name of ['texpresso', 'texpresso-xetex']) {
      const bytes = Buffer.from(name);
      await fs.writeFile(path.join(directory, 'bin', name), bytes);
      await fs.chmod(path.join(directory, 'bin', name), 0o755);
      files.push({ path: 'bin/' + name, sha256: sha256(bytes), bytes: bytes.length });
    }
    const revision = execFileSync('git', ['rev-parse', ':native/texpresso'], { cwd: root, encoding: 'utf8' }).trim();
    const manifest = { platform: 'darwin', architecture: 'arm64', engineRevision: revision,
      features: { embeddedPreview: true }, capabilities: { previewProtocol: 1 }, files };
    const save = () => fs.writeFile(path.join(directory, 'build-manifest.json'), JSON.stringify(manifest));
    await save();
    assert.equal(validateBundle(directory, 'darwin-arm64', root).length, 4);
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
    await fs.rm(path.join(directory, 'bin', 'texpresso-xetex'));
    assert.throws(() => validateBundle(directory, 'darwin-arm64', root), /Invalid manifest file/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
