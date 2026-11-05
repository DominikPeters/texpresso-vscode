import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveEngine } from '../engine-selection';
import { config } from './helpers';

test('engine selection preserves external commands and runs directly on a Remote WSL host', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'txp-engine-selection-'));
  try {
    assert.equal(resolveEngine(config, root).command, 'texpresso', 'explicit PATH override is retained');
    assert.equal(resolveEngine({ ...config, command: '' }, root).engineSource, 'path');
    const bridge = resolveEngine({ ...config, command: '', useWSL: true }, root, 'win32', 'x64');
    assert.equal(bridge.useWSL, true);
    assert.equal(bridge.command, 'texpresso');
    const remote = resolveEngine({ ...config, command: '/opt/texpresso', useWSL: true }, root, 'linux', 'x64');
    assert.equal(remote.useWSL, false);
    assert.equal(remote.command, '/opt/texpresso');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a relocated bundled engine is selected as a complete pair and damaged bundles never silently use PATH', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'txp bundled engine '));
  try {
    const directory = path.join(root, 'runtime', 'linux-x64');
    await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
    await fs.writeFile(path.join(directory, 'build-manifest.json'), JSON.stringify({
      platform: 'linux', architecture: 'x86_64', engineRevision: 'a'.repeat(40)
    }));
    for (const name of ['texpresso', 'texpresso-xetex']) {
      await fs.writeFile(path.join(directory, 'bin', name), 'test executable');
      await fs.chmod(path.join(directory, 'bin', name), 0o755);
    }
    const selected = resolveEngine({ ...config, command: '', useWSL: true }, root, 'linux', 'x64');
    assert.equal(selected.command, path.join(directory, 'bin', 'texpresso'));
    assert.equal(selected.engineSource, 'bundled');
    assert.equal(selected.useWSL, false);
    assert.equal(selected.engineRevision, 'a'.repeat(40));
    assert.throws(() => resolveEngine({ ...config, command: '' }, root, 'linux', 'arm64'), /bundled engine.*damaged/);
    await fs.rm(path.join(directory, 'bin', 'texpresso-xetex'));
    assert.throws(() => resolveEngine({ ...config, command: '' }, root, 'linux', 'x64'), /bundled engine.*damaged/);
    assert.equal(resolveEngine({ ...config, command: '/custom/engine' }, root, 'linux', 'x64').command, '/custom/engine');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
