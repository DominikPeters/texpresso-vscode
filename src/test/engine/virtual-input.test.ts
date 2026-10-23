import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';

const binary = process.env.TEXPRESSO_BINARY;
type State = Extract<PreviewMessage, ['preview-state', ...unknown[]]>;
type Target = Extract<PreviewMessage, ['preview-forward', ...unknown[]]>;
const mainText = '\\documentclass{article}\n\\pagestyle{empty}\n\\begin{document}\nFirst page.\\newpage\n\\input{chapter}\n\\newpage Last page.\\end{document}\n';
const initial = '\\typeout{VIRTUAL-INITIAL}\nVirtual paragraph: Café belongs to the unsaved source.\n' + '%' + 'padding'.repeat(200) + '\n';

async function setup(streamFiles: boolean, disk: boolean, text = initial) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-virtual-input-')));
  const main = document(path.join(root, 'main.tex'), mainText);
  let contents = text;
  const child = document(path.join(root, 'chapter.tex'), contents); child.getText = () => contents;
  await fs.writeFile(main.fileName, mainText);
  if (disk) { await fs.writeFile(child.fileName, '\\typeout{ORIGINAL-DISK}\nObsolete disk paragraph.\n'); }
  let session: TexpressoSession, state: State | undefined, failure: Error | undefined, output = '', debug = '', id = 0;
  const frames = new Map<number, PreviewImage>(), messages: PreviewMessage[] = [], targets: Target[] = [];
  const sources: { file: string; line: number; word?: string }[] = [];
  const start = async () => {
    state = undefined; failure = undefined; output = ''; messages.length = 0;
    session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor',
      streamFiles, autoRerun: false, watchDependencies: false }, new SessionPaths(main.fileName, false), () => [main, child], {
      state() {}, output: (target, value) => { if (target === 'out') { output = value; } },
      debug: value => { debug = (debug + value).slice(-40000); }, error: error => { failure = error; },
      synctex: (file, line, _column, word) => sources.push({ file, line, word }),
      preview: event => {
        if ('header' in event) { frames.set(event.header.requestId, event); }
        else if (Array.isArray(event)) {
          messages.push(event); if (event[0] === 'preview-state') { state = event; }
          if (event[0] === 'preview-forward') { targets.push(event); }
          if (event[0] === 'preview-error') { failure = new Error(event[2]); }
        }
      }
    });
    await session.start();
  };
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!check()) {
      if (failure || Date.now() > deadline) { throw failure || new Error('Virtual input timeout\n' + output + '\n' + debug); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const render = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await until(() => !!state && state[2] === session.previewSequence);
      const request = ++id;
      session.send(['preview-render', request, 1, 800, state![1], state![2]]);
      await until(() => frames.has(request) || messages.some(m => m[0] === 'preview-retry' && m[1] === request));
      if (frames.has(request)) { return frames.get(request)!; }
    }
    throw Error('Virtual input render repeatedly superseded');
  };
  return { root, main, child, start, render, until, messages, targets, sources,
    session: () => session, output: () => output,
    prepare: async () => {
      const request = ++id, offset = Buffer.byteLength(contents.slice(0, contents.indexOf('Café')));
      session.send(['preview-prepare', request, child.fileName, offset, state![1], state![2]]);
      await until(() => messages.some(m => m[0] === 'preview-prepared' && m[1] === request));
      const ack = messages.find(m => m[0] === 'preview-prepared' && m[1] === request)!;
      assert.match(String(ack[4]), /ready|cached/);
    },
    edit: () => {
      const offset = contents.indexOf('Café'), value = 'CHANGED wide text before Café';
      const character = offset - contents.lastIndexOf('\n', offset) - 1;
      contents = contents.slice(0, offset) + value + contents.slice(offset + 4);
      session.sync.change(child, [{ rangeOffset: offset, rangeLength: 4, text: value,
        range: { start: { line: 1, character }, end: { line: 1, character: character + 4 } } as vscode.Range }]);
    },
    text: () => contents,
    dispose: async () => { await session?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  };
}

for (const streamFiles of [false, true]) {
  for (const disk of [false, true]) {
    test(`extensionless input uses unsaved source, tracks rollback and replays recovery (${streamFiles ? 'stream' : 'filesystem'}, ${disk ? 'different disk' : 'no disk'})`,
      { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 60000 }, async () => {
        const f = await setup(streamFiles, disk);
        try {
          await f.start(); const before = await f.render();
          assert.match(f.output(), /VIRTUAL-INITIAL/, 'extension lookup must reach the editor buffer');
          assert.doesNotMatch(f.output(), /ORIGINAL-DISK/);
          await f.prepare(); f.edit(); const edited = await f.render();
          assert.notDeepEqual(edited.bytes, before.bytes, 'editing the tracked extensionless include changes rendered text');
          const targetCount = f.targets.length; f.session().sync.syncForward(f.child, 1);
          await f.until(() => f.targets.length > targetCount);
          const target = f.targets.at(-1)!; assert.equal(target[3], 1);
          f.session().send(['preview-inverse', target[1], target[2], target[3], target[4], target[5]]);
          await f.until(() => f.sources.length > 0);
          assert.equal(f.sources.at(-1)!.file, f.child.fileName, 'SyncTeX identifies the resolved .tex source');
          assert.equal(f.sources.at(-1)!.line, 2);
          await f.session().dispose(); await f.start();
          const recovered = await f.render();
          assert.deepEqual(recovered.bytes, edited.bytes, 'replacement replays the unsaved include over original disk contents');
          const clean = await setup(streamFiles, disk, f.text());
          try { await clean.start(); assert.deepEqual((await clean.render()).bytes, edited.bytes, 'warm rollback equals a fresh compile of the current source'); }
          finally { await clean.dispose(); }
        } finally { await f.dispose(); }
      });
  }
}
