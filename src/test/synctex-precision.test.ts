import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { TexpressoSession, type SourceRevealOptions } from '../session';
import { SessionPaths } from '../paths';
import { config, document, FakeProcess } from './helpers';
import { isPreviewMessage, readPreviewProtocol } from '../preview-protocol';
import { probePreview } from '../preview-capabilities';

test('precision capability requires the supported version, rather than truthiness', async t => {
  for (const value of [undefined, false, true, 1, 2, '1']) {
    t.mock.method(require('child_process'), 'execFile', (...args: any[]) => {
      queueMicrotask(() => args.at(-1)(null, JSON.stringify({ previewProtocol: 1, codecs: ['png'], synctex: true, synctexPrecision: value })));
      return {};
    });
    let precision: boolean | undefined;
    await probePreview(config, undefined, features => { precision = features.synctexPrecision; });
    assert.equal(precision, value === 1);
    t.mock.restoreAll();
  }
});

test('precise framing accepts empty boxes and fragmented Unicode replies, rejecting malformed geometry and locations', () => {
  const source = ['preview-source-precise', 1, 4, 2, 0, 20, 30, []];
  const inverse = ['preview-inverse-result', 2, 4, 2, 0, { file: '/work/café.tex', line: 2, column: -1, word: 'oﬃce' }];
  const bytes = Buffer.from(JSON.stringify(source) + '\n' + JSON.stringify(inverse) + '\n');
  for (let split = 1; split < bytes.length; split++) {
    const input = new PassThrough(), messages: unknown[] = [];
    const reader = readPreviewProtocol(input, m => messages.push(m), () => assert.fail(), e => { throw e; });
    input.write(bytes.subarray(0, split)); input.write(bytes.subarray(split));
    assert.deepEqual(messages, [source, inverse]); reader.close();
  }
  for (const rects of [[[1, 2, 1, 3]], [[1, 2, Infinity, 3]], Array(129).fill([1, 2, 3, 4])]) {
    assert.equal(isPreviewMessage([...source.slice(0, 7), rects]), false);
  }
  for (const bad of [{ line: 0 }, { column: -2 }, { file: 'bad\nfile' }, { word: 'é'.repeat(129) }]) {
    assert.equal(isPreviewMessage([...inverse.slice(0, 5), { ...inverse[5] as object, ...bad }]), false);
  }
  assert.ok(isPreviewMessage([...inverse.slice(0, 5), null]));
});

async function fixture(check: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, precision = true) {
  const f = await setup(precision);
  try { await check(f); } finally { await f.session.dispose(); }
}
async function setup(precision: boolean) {
  const main = document('/work/main.tex', 'é😀 office and target'), child = new FakeProcess();
  const events: unknown[] = [], reveals: { file: string; line: number; column?: number; word?: string; options?: SourceRevealOptions }[] = [];
  const session = new TexpressoSession(main, { ...config, previewLocation: 'editor' }, new SessionPaths(main.fileName, false), () => [main],
    { state() {}, output() {}, debug() {}, error: e => { throw e; }, preview: e => events.push(e),
      synctex: (file, line, column, word, options) => reveals.push({ file, line, column, word, options }) }, undefined,
    () => { queueMicrotask(() => child.emit('spawn')); return child.asChild(); }, {
      probePreview: async (_config, _cwd, features) => {
        features?.({ regions: true, svg: true, links: true, auto: true, pngPatches: true, background: true,
          prepareEdit: true, requestLifecycle: true, synctexPrecision: precision }); return true;
      }
    });
  await session.start();
  const reply = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  reply(['preview-state', 4, session.previewSequence, 2, true, 0]);
  return { session, child, main, events, reveals, reply };
}

test('precise source requests carry UTF-8 columns and words; stale IDs, revisions and source epochs cannot reveal', async () => fixture(async f => {
  f.session.syncForward(f.main, 0, 7); const old = f.child.commands.at(-1)!;
  f.session.syncForward(f.main, 0, 16); const latest = f.child.commands.at(-1)!;
  assert.deepEqual(old.slice(0, 1), ['preview-search-precise']);
  assert.deepEqual(old.slice(2), [f.main.fileName, 1, f.session.previewSequence, 11, 'office']);
  const forward = (id: unknown, rev = 4, boxes: number[][] = [[20, 25, 45, 35]]) =>
    ['preview-source-precise', id, rev, f.session.previewSequence, 0, 20, 30, boxes];
  f.reply(forward(old[1])); f.reply(forward(latest[1], 3));
  assert.equal(f.events.filter(e => Array.isArray(e) && e[0] === 'preview-forward').length, 0);
  f.reply(forward(latest[1]));
  assert.deepEqual(f.events.at(-1), ['preview-forward', 4, f.session.previewSequence, 0, 20, 30, [[20, 25, 45, 35]]]);
  f.session.syncForward(f.main, 0, 7); const empty = f.child.commands.at(-1)!;
  f.reply(forward(empty[1], 4, [])); assert.deepEqual((f.events.at(-1) as any)[6], []);
  f.session.syncForward(f.main, 0, 7); const obsolete = f.child.commands.at(-1)!, sequence = f.session.previewSequence;
  f.session.send(['rescan']); f.reply(['preview-source-precise', obsolete[1], 4, sequence, 0, 20, 30, []]);
  assert.equal(f.events.filter(e => Array.isArray(e) && e[0] === 'preview-forward').length, 2);
}));

test('legacy engines retain line-only request/reply shapes', async () => fixture(async f => {
  f.session.syncForward(f.main, 0, 7);
  const command = f.child.commands.at(-1)!;
  assert.equal(command[0], 'preview-search'); assert.equal(command.length, 5);
  f.reply(['preview-source', command[1], 4, f.session.previewSequence, 0, 20, 30]);
  assert.deepEqual(f.events.at(-1), ['preview-forward', 4, f.session.previewSequence, 0, 20, 30]);
}, false));

test('precise inverse settles nulls and guards the ID, page, revision, source epoch and asynchronous editor reveal', async () => fixture(async f => {
  let current = true;
  const request = () => { f.session.inversePrecise(4, f.session.previewSequence, 1, 20, 30, () => current); return f.child.commands.at(-1)!; };
  const result = (id: unknown, location: unknown = { file: f.main.fileName, line: 1, column: -1, word: 'office' }, page = 1, revision = 4) =>
    ['preview-inverse-result', id, revision, f.session.previewSequence, page, location];
  const first = request(); assert.equal(first[0], 'preview-inverse-precise'); assert.deepEqual(first.slice(-2), [null, true]);
  const second = request(); f.reply(result(first[1])); f.reply(result(second[1], undefined, 0)); f.reply(result(second[1], undefined, 1, 3));
  assert.equal(f.reveals.length, 0);
  f.reply(result(second[1], null)); f.reply(result(second[1])); assert.equal(f.reveals.length, 0, 'null is terminal');
  const third = request(); current = false; f.reply(result(third[1])); assert.equal(f.reveals.length, 0);
  current = true;
  const fourth = request(); f.reply(result(fourth[1], { file: '/unregistered.tex', line: 1, column: -1, word: 'office' }));
  assert.equal(f.reveals.length, 0, 'only registered inputs may be opened');
  const fifth = request(); f.reply(result(fifth[1])); assert.equal(f.reveals.length, 1);
  assert.equal(f.reveals[0].options?.utf8Column, true); assert.equal(f.reveals[0].options?.current?.(), true);
  request(); assert.equal(f.reveals[0].options?.current?.(), false, 'a newer click retires an already delivered asynchronous reveal');
  const canceled = request(); f.reply(result(canceled[1]));
  const delivered = f.reveals.at(-1)!; assert.equal(delivered.options?.current?.(), true);
  f.session.send(['preview-cancel', 0, 0]); assert.equal(delivered.options?.current?.(), false);
  const beforeBarrier = f.reveals.length;
  const pending = request(); f.session.send(['rescan']);
  f.reply(result(pending[1])); assert.equal(f.reveals.length, beforeBarrier);
  assert.ok(f.child.commands.every(c => !/^preview-(render|svg|png|auto|background)$/.test(c[0])), 'inverse lookup requests no images');
}));
