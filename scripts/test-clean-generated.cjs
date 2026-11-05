const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planCleanup, applyCleanup } = require('./clean-generated.cjs');

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'txp-clean-'));
  const write = (name, text = 'output', age = 20) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    const old = new Date(Date.now() - age * 86400000);
    fs.utimesSync(file, old, old);
    // Directory timestamps must also be old for a stale-output fixture.
    for (let directory = path.dirname(file); directory !== root; directory = path.dirname(directory)) {
      fs.utimesSync(directory, old, old);
    }
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, '.gitignore'), '/artifacts/\n/native/.work/\n/native/.bundles/\n');
    return run(root, write);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('cleanup removes stale outputs while preserving recent descendants, pins, source, bundles and current packages', () => fixture((root, write) => {
  write('native/.work/old-build/object.o');
  write('native/.bundles/darwin-arm64-preview/bin/texpresso');
  write('native/.bundles/old-candidate/bin/texpresso');
  write('artifacts/old-run/frame.png');
  write('artifacts/active-run/old.json'); write('artifacts/active-run/nested/new.json', 'recent', 0);
  write('artifacts/pinned/nested/.keep');
  write('artifacts/report.log'); write('artifacts/report.log.keep');
  write('artifacts/experiment.c'); write('artifacts/screenshot.png');
  write('artifacts/texpresso-1.0.0-darwin-arm64.vsix', 'old', 30);
  write('artifacts/texpresso-2.0.0-darwin-arm64.vsix');
  write('artifacts/texpresso-2.0.0-darwin-arm64.vsix.sha256');
  const plan = planCleanup(root);
  assert.deepEqual(plan.candidates.map(entry => entry.path).sort(), [
    'artifacts/old-run', 'artifacts/texpresso-1.0.0-darwin-arm64.vsix',
    'native/.bundles/old-candidate', 'native/.work/old-build'
  ]);
  assert.ok(fs.existsSync(path.join(root, 'artifacts/old-run')), 'planning does not delete');
  applyCleanup(plan);
  for (const entry of plan.candidates) { assert.ok(!fs.existsSync(path.join(root, entry.path))); }
  for (const entry of plan.retained) { assert.ok(fs.existsSync(path.join(root, entry.path))); }
}));

test('cleanup protects tracked descendants and symlink targets', () => fixture((root, write) => {
  write('artifacts/tracked-run/result.json');
  execFileSync('git', ['add', '-f', 'artifacts/tracked-run/result.json'], { cwd: root });
  write('outside/important.txt');
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'artifacts/linked'), 'junction');
  assert.equal(planCleanup(root).candidates.length, 0);
  fs.rmSync(path.join(root, 'artifacts'), { recursive: true });
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'artifacts'), 'junction');
  assert.throws(() => planCleanup(root), /symlinked output root/);
  assert.equal(fs.readFileSync(path.join(root, 'outside/important.txt'), 'utf8'), 'output');
}));

test('cleanup rechecks newly pinned or modified outputs before deleting any entries', () => fixture((root, write) => {
  write('artifacts/a/file.log'); write('artifacts/b/file.log');
  const plan = planCleanup(root);
  write('artifacts/b/.keep');
  assert.throws(() => applyCleanup(plan), /protected or changed/);
  assert.ok(fs.existsSync(path.join(root, 'artifacts/a/file.log')));
  fs.unlinkSync(path.join(root, 'artifacts/b/.keep'));
  write('artifacts/b/new.log', 'new data', 0);
  assert.throws(() => applyCleanup(plan), /protected or changed/);
  assert.ok(fs.existsSync(path.join(root, 'artifacts/a/file.log')));
}));

test('cleanup honors a scope pin and refuses unignored roots or invalid retention', () => fixture((root, write) => {
  write('artifacts/run/file.log'); write('artifacts/.keep');
  assert.equal(planCleanup(root).candidates.length, 0);
  assert.throws(() => planCleanup(path.join(root, 'artifacts/run')), /repository root/);
  assert.throws(() => planCleanup(root, -1), /nonnegative/);
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  assert.throws(() => planCleanup(root));
  assert.ok(fs.existsSync(path.join(root, 'artifacts/run/file.log')));
}));
