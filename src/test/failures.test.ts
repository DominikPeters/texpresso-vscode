import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeFailure, EngineFailure } from '../failures';
import { findExecutable, setupReport } from '../setup';
import { SessionPaths } from '../paths';
import { config } from './helpers';

test('launch, configuration, unsupported option and runtime failures have distinct recovery advice', () => {
  const missing = new EngineFailure('launch', 'spawn ENOENT', 'ENOENT');
  assert.match(describeFailure(missing, config).message, /Could not find TeXpresso/);
  assert.match(describeFailure(missing, { ...config, useWSL: true }).message, /Could not start WSL/);
  assert.match(describeFailure(new EngineFailure('launch', 'permission denied', 'EACCES'), config).message, /permissions/);
  assert.match(describeFailure(new EngineFailure('configuration', '-I needs a directory'), config).message, /settings are invalid/);
  const exit = new EngineFailure('exit', 'TeXpresso exited with code 1', undefined, 'Unknown option -tectonic');
  assert.match(describeFailure(exit, config).message, /rejected a launch argument/);
  const crash = describeFailure(new EngineFailure('exit', 'TeXpresso exited with SIGSEGV'), config).message;
  assert.match(crash, /Engine Log/);
  assert.doesNotMatch(crash, /WSL settings|executable path/);
});

test('setup checks a spaced executable path without launching it and reports invalid settings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso setup '));
  try {
    const binary = path.join(root, process.platform === 'win32' ? 'fake engine.exe' : 'fake engine');
    // This is intentionally not a valid executable: setup must never run it.
    await fs.writeFile(binary, 'do not run');
    await fs.chmod(binary, 0o755);
    assert.equal(await findExecutable(binary, root), binary);
    assert.equal(await findExecutable(root, root), undefined);
    const paths = new SessionPaths(path.join(root, 'paper.tex'), false);
    const report = await setupReport({ ...config, command: binary }, paths, 'test host');
    assert.ok(report.includes('Executable found: ' + binary));
    assert.ok(report.includes(JSON.stringify([binary, '-json', '-lines', paths.rootEnginePath], null, 2)));
    const missing = await setupReport({ ...config, command: path.join(root, 'missing') }, paths, 'test host');
    assert.match(missing, /Executable NOT FOUND/);
    const invalid = await setupReport({ ...config, arguments: ['-I'] }, paths, 'test host');
    assert.match(invalid, /Setup check failed: The -I argument needs a directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
