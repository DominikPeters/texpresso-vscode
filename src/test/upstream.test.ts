import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Dependencies, FileChange } from '../dependencies';
import { SessionPaths } from '../paths';
import { DocumentSync } from '../document-sync';
import { Command } from '../protocol';
import { TexpressoSession } from '../session';
import { buildLaunchCommand } from '../configuration';
import { config, document, FakeProcess } from './helpers';

test('stream launch primes open buffers and enables reruns before resuming; legacy launch sends no new commands', async () => {
  for (const streamFiles of [false, true]) {
    const main = document('/work/main.tex');
    const child = document('/work/chapter.tex', 'unsaved chapter');
    const process = new FakeProcess();
    const session = new TexpressoSession(main, { ...config, streamFiles, autoRerun: streamFiles },
      new SessionPaths(main.fileName, false), () => [main, child], {
        state() {}, output() {}, debug() {}, synctex() {}, error(error) { throw error; }
      }, undefined, () => {
        queueMicrotask(() => process.emit('spawn'));
        return process.asChild();
      });
    try {
      await session.start();
      if (streamFiles) {
        assert.deepEqual(process.commands.at(-1), ['resume']);
        assert.ok(process.commands.findIndex(cmd => cmd[0] === 'register') <
          process.commands.findIndex(cmd => cmd[0] === 'open'));
        assert.ok(process.commands.some(cmd => cmd[0] === 'open' && cmd[1] === child.fileName && cmd[2] === 'unsaved chapter'));
        assert.ok(process.commands.some(cmd => cmd[0] === 'rerun' && cmd[1] === true));
        session.setAutoRerun(false);
        assert.deepEqual(process.commands.at(-1), ['rerun', false]);
        session.rerunOnce();
        assert.deepEqual(process.commands.at(-1), ['rerun-once']);
        session.setPaused(true);
        assert.equal(session.paused, true);
        assert.deepEqual(process.commands.at(-1), ['pause']);
        session.setPaused(false);
        assert.deepEqual(process.commands.at(-1), ['resume']);
      } else {
        assert.ok(process.commands.every(cmd => cmd[0] === 'open'));
      }
    } finally { session.dispose(); }
  }
  assert.throws(() => buildLaunchCommand({ ...config, arguments: ['-stream'] },
    new SessionPaths(path.resolve('/work/main.tex'), false)), /Stream Files/);
});

test('an old engine rejecting a new command restores the UI state and warns once without ending the session', async () => {
  const main = document('/work/main.tex');
  const child = new FakeProcess();
  const warnings: string[] = [];
  const session = new TexpressoSession(main, { ...config }, new SessionPaths(main.fileName, false), () => [main], {
    state() {}, output() {}, debug() {}, synctex() {}, warning: text => warnings.push(text), error(error) { throw error; }
  }, undefined, () => {
    queueMicrotask(() => child.emit('spawn'));
    return child.asChild();
  });
  try {
    await session.start();
    session.setPaused(true);
    child.stderr.write('[command] unk');
    child.stderr.write('nown verb: pause\n[command] unknown verb: pause\n');
    assert.equal(session.paused, false);
    assert.equal(session.state, 'running');
    assert.equal(warnings.length, 1);
    assert.ok(session.unsupported.has('pause'));
  } finally { session.dispose(); }
});

test('untitled root overlays retain their temporary engine path instead of being replaced with disk contents', () => {
  const root = Object.assign(document('/work/Untitled-1', 'current unsaved text'), { isUntitled: true });
  const paths = new SessionPaths(path.resolve('/work/tmp/untitled.tex'), false);
  const sync = new DocumentSync(root, paths, true, () => [root], () => {});
  sync.prime(); sync.initialize();
  sync.announce(paths.rootEnginePath);
  assert.equal(sync.overlay(paths.rootEnginePath), root);
  assert.ok(sync.hasOverlay(paths.rootEditorPath));
  assert.equal(sync.trackedPaths.length, 1);
  assert.equal(sync.editorPath(paths.rootEnginePath), paths.rootEditorPath);
});

async function fixture(stream: boolean, body: (data: {
  root: string; sync: DocumentSync; deps: Dependencies; sent: Command[];
  changed(file: string, kind: FileChange): void; restarts(): number;
}) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso-deps-')));
  const main = document(path.join(root, 'main.tex'));
  await fs.writeFile(main.fileName, main.getText());
  const sent: Command[] = [];
  const paths = new SessionPaths(main.fileName, false);
  const sync = new DocumentSync(main, paths, true, () => [main], cmd => sent.push(cmd));
  const watchers = new Map<string, (kind: FileChange) => void>();
  let restarts = 0;
  const deps = new Dependencies(paths, sync, { watch: true, stream, roots: [root], delay: 10000,
    watchFile(file, changed) { watchers.set(file, changed); return { dispose() { watchers.delete(file); } }; }
  }, { send: cmd => sent.push(cmd), restart: () => { restarts++; }, debug() {}, error(error) { throw error; } });
  try {
    await body({ root, sync, deps, sent,
      changed(file, kind) { assert.ok(watchers.has(file), 'dependency is watched: ' + file); watchers.get(file)!(kind); },
      restarts: () => restarts });
  } finally { deps.dispose(); await fs.rm(root, { recursive: true, force: true }); }
}

test('disk changes coalesce into one rescan and exclude engine outputs and open overlays', async () => {
  await fixture(false, async ({ root, deps, sent, changed, sync, restarts }) => {
    const source = path.join(root, 'chapter.tex');
    const image = path.join(root, 'picture.png');
    await fs.writeFile(source, 'source');
    await fs.writeFile(image, 'image');
    deps.input('chapter.tex');
    deps.lookup('read', 'successful', 'picture.png');
    deps.lookup('read', 'failed', 'main.aux');
    deps.lookup('write', 'successful', 'main.aux');
    changed(source, 'change'); changed(image, 'change');
    await deps.flush();
    assert.deepEqual(sent, [['rescan']]);
    assert.equal(restarts(), 0);
    // No delayed refresh loop from an engine-written auxiliary file.
    deps.lookup('read', 'successful', 'main.aux');
    await deps.flush();
    assert.equal(sent.length, 1);
    // The root editor buffer wins over disk changes to the same source.
    deps.input('main.tex');
    sync.initialize();
    sent.length = 0;
    changed(path.join(root, 'main.tex'), 'change');
    await deps.flush();
    assert.equal(sent.length, 0);
  });
});

test('atomic file replacement rescans; creating a missing dependency or deleting an input restarts', async () => {
  await fixture(false, async ({ root, deps, sent, changed, restarts }) => {
    const file = path.join(root, 'chapter.tex');
    await fs.writeFile(file, 'source');
    deps.input('chapter.tex');
    changed(file, 'delete'); changed(file, 'create');
    await deps.flush();
    assert.deepEqual(sent, [['rescan']]);
    assert.equal(restarts(), 0);
    await fs.unlink(file); changed(file, 'delete'); await deps.flush();
    assert.equal(restarts(), 1);
    deps.lookup('read', 'failed', 'new.tex');
    await fs.writeFile(path.join(root, 'new.tex'), 'new source');
    changed(path.join(root, 'new.tex'), 'create'); await deps.flush();
    assert.equal(restarts(), 2);
  });
});

test('streamed binary resources preserve every byte and update after disk changes', async () => {
  await fixture(true, async ({ root, deps, sent, changed }) => {
    const file = path.join(root, 'asset.bin');
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await fs.writeFile(file, bytes);
    deps.lookup('read', 'successful', 'asset.bin');
    const until = async (count: number) => {
      for (let i = 0; i < 100 && sent.length < count; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(sent.length, count);
    };
    await until(1);
    assert.equal(sent[0][0], 'open-base64');
    assert.deepEqual(Buffer.from(sent[0][2] as string, 'base64'), bytes);
    await fs.writeFile(file, Buffer.from([0, 255, 0, 127]));
    changed(file, 'change'); await deps.flush();
    await until(2);
    assert.deepEqual(Buffer.from(sent[1][2] as string, 'base64'), Buffer.from([0, 255, 0, 127]));
    deps.dispose();
    deps.lookup('read', 'successful', 'another.png');
    await deps.flush();
    assert.equal(sent.length, 2);
  });
});

test('external-build suspension defers dependency refresh until resumed', async () => {
  await fixture(false, async ({ root, deps, sent, changed }) => {
    const file = path.join(root, 'chapter.tex');
    await fs.writeFile(file, 'source');
    deps.input('chapter.tex');
    deps.suspended = true;
    changed(file, 'change'); await deps.flush();
    assert.equal(sent.length, 0);
    deps.resumeWatching();
    await deps.flush();
    assert.deepEqual(sent, [['rescan']]);
  });
});

test('closing an unsaved registered input clears the engine promise with a restart', async () => {
  await fixture(true, async ({ root, deps, restarts }) => {
    deps.lookup('read', 'failed', 'unsaved.tex');
    deps.closed(path.join(root, 'unsaved.tex'));
    assert.equal(restarts(), 1);
    deps.dispose();
    deps.closed(path.join(root, 'unsaved.tex'));
    assert.equal(restarts(), 1);
  });
});
