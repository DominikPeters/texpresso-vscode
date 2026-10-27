import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPreviewProtocol, isImageHeader, isPreviewMessage, type PreviewImageHeader, type PreviewImage } from '../preview-protocol';
import { TexpressoSession } from '../session';
import { SessionPaths } from '../paths';
import { config, document, FakeProcess } from './helpers';
import { probePreview } from '../preview-capabilities';
import { EngineFailure, describeFailure } from '../failures';

const header: PreviewImageHeader = { requestId: 1, revision: 3, sequence: 2, page: 0,
  bounds: [0, 0, 612, 792], width: 100, height: 130, mime: 'image/png', byteLength: 9 };
const body = Buffer.from([0x89, 0x50, 0, 10, 13, 255, 123, 0xc3, 0xa9]);
const frame = Buffer.concat([Buffer.from(JSON.stringify(['preview-image', header]) + '\n'), body]);

test('binary preview framing preserves every byte and split boundary beside Unicode compiler output', () => {
  const stream = Buffer.concat([Buffer.from('["append-lines","out","é😀"]\n'), frame, Buffer.from('["flush"]\n')]);
  for (let split = 1; split < stream.length; split++) {
    const input = new PassThrough(), messages: unknown[] = [], images: PreviewImage[] = [];
    const reader = readPreviewProtocol(input, m => messages.push(m), f => images.push(f), e => { throw e; });
    input.write(stream.subarray(0, split)); input.write(stream.subarray(split));
    assert.deepEqual(messages, [['append-lines', 'out', 'é😀'], ['flush']]);
    assert.equal(images.length, 1); assert.deepEqual(images[0].bytes, body);
    assert.deepEqual(images[0].header, header); reader.close();
  }
  const input = new PassThrough(); let count = 0;
  const reader = readPreviewProtocol(input, () => {}, () => { count++; }, e => { throw e; });
  for (const byte of Buffer.concat([frame, frame])) { input.write(Buffer.from([byte])); }
  assert.equal(count, 2); reader.close();
});

test('binary preview refuses oversized or malformed headers and detects truncated bodies', async () => {
  for (const change of [{ byteLength: 17 * 1024 * 1024 }, { byteLength: -1 }, { width: 10000 },
    { width: 4096, height: 4096 }, { mime: 'text/html' }, { bounds: [0, 0, 0, 10] }, { requestId: 1.5 }]) {
    const input = new PassThrough(); const errors: Error[] = [];
    readPreviewProtocol(input, () => {}, () => assert.fail('must not accept image'), e => errors.push(e));
    input.write(JSON.stringify(['preview-image', { ...header, ...change }]) + '\n');
    input.write(frame);
    assert.equal(errors.length, 1, 'invalid stream is permanently closed');
  }
  const input = new PassThrough(); const errors: Error[] = [];
  readPreviewProtocol(input, () => {}, () => assert.fail('incomplete image'), e => errors.push(e));
  input.end(frame.subarray(0, frame.length - 1));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(errors[0].message, /during a preview frame/);
});

test('native SyncTeX notifications accept an unknown column', () => {
  const input = new PassThrough(); const messages: unknown[] = [];
  const reader = readPreviewProtocol(input, m => messages.push(m), () => {}, e => { throw e; });
  input.write('["synctex","main.tex",6,-1]\n');
  input.write('["preview-future-notification",1]\n');
  assert.deepEqual(messages, [['synctex', 'main.tex', 6, -1], ['preview-future-notification', 1]]);
  reader.close();
});

test('preview capability selection preserves old engines and orders source barriers after edits', async () => {
  const main = document('/work/main.tex');
  for (const location of ['auto', 'editor', 'window'] as const) {
    for (const supported of [false, true]) {
      const child = new FakeProcess(); let probes = 0, launches = 0; const errors: Error[] = [];
      const session = new TexpressoSession(main, { ...config, previewLocation: location }, new SessionPaths(main.fileName, false),
        () => [main], { state() {}, output() {}, debug() {}, synctex() {}, error: e => errors.push(e) }, undefined,
        (_command, args) => { launches++; assert.equal(args.includes('-headless'), supported && location !== 'window');
          queueMicrotask(() => child.emit('spawn')); return child.asChild(); },
        { probePreview: async () => { probes++; return supported; } });
      try {
        await session.start();
        assert.equal(probes, location === 'window' ? 0 : 1);
        if (!supported && location === 'editor') {
          assert.equal(launches, 0); assert.equal(session.state, 'failed');
          assert.match(errors[0].message, /Preview Location to Window/);
        } else {
          assert.equal(session.state, 'running');
          const before = child.commands.length;
          session.send(['change-range', main.fileName, 0, 0, 0, 0, 'é']);
          const commands = child.commands.slice(before);
          assert.equal(commands[0][0], 'change-range');
          if (session.embedded) { assert.deepEqual(commands[1], ['preview-barrier', session.previewSequence]); }
          else { assert.equal(commands.length, 1); }
        }
      } finally { await session.dispose(); }
    }
  }
});

test('stopping during the capabilities probe prevents a later engine launch', async () => {
  const main = document('/work/main.tex'); let resolve!: (value: boolean) => void;
  const session = new TexpressoSession(main, { ...config, previewLocation: 'editor' }, new SessionPaths(main.fileName, false),
    () => [main], { state() {}, output() {}, debug() {}, synctex() {}, error: e => { throw e; } }, undefined,
    () => { throw new Error('Canceled startup must not spawn'); },
    { probePreview: () => new Promise(r => { resolve = r; }) });
  const start = session.start(); await session.dispose(); resolve(true); await start;
  assert.equal(session.state, 'stopped');
});

test('capability probing permits a slow cold executable startup', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'txp-cold-probe-'));
  const executable = path.join(directory, 'engine');
  try {
    await fs.writeFile(executable, '#!/usr/bin/env node\nsetTimeout(() => console.log(JSON.stringify({previewProtocol:1,codecs:["png"],synctex:true})), 3500);\n', { mode: 0o755 });
    assert.equal(await probePreview({ ...config, command: executable }), true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a capability probe timeout is a launch failure rather than missing preview support', async context => {
  context.mock.method(require('child_process'), 'execFile', (...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: Error, stdout: string, stderr: string) => void;
    queueMicrotask(() => callback(Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM', code: null }), '', ''));
    return {};
  });
  await assert.rejects(probePreview(config), error => error instanceof EngineFailure && error.phase === 'launch' && error.code === 'ETIMEDOUT');
});

test('capability probing distinguishes a missing executable from missing preview support', async () => {
  await assert.rejects(probePreview({ ...config, command: '/texpresso-nonexistent-directory/missing-executable' }),
    error => error instanceof EngineFailure && error.phase === 'launch' && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
  const failure = describeFailure(new EngineFailure('configuration', 'Choose another engine or Window.', 'PREVIEW_UNSUPPORTED'));
  assert.equal(failure.setting, 'texpresso.previewLocation');
  assert.equal(failure.message, 'Choose another engine or Window.');
});

test('SVG framing and bounded hyperlink metadata preserve UTF-8, escaping and arbitrary body splits', () => {
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">\n<path data-text="é😀"/></svg>');
  const svg = { ...header, mime: 'image/svg+xml', byteLength: bytes.length, annotations: {
    links: [{ bounds: [1, 2, 3, 4], uri: 'https://example.com/?x=1&y=2' }], destinations: [{ name: 'é\\()😀', x: 2, y: 3 }]
  } };
  const payload = Buffer.concat([Buffer.from(JSON.stringify(['preview-image', svg]) + '\n'), bytes]);
  for (let split = 1; split < payload.length; split++) {
    const input = new PassThrough(); const frames: PreviewImage[] = [];
    const reader = readPreviewProtocol(input, () => {}, image => frames.push(image), error => { throw error; });
    input.write(payload.subarray(0, split)); input.write(payload.subarray(split));
    assert.deepEqual(frames[0].header.annotations, svg.annotations); assert.deepEqual(frames[0].bytes, bytes); reader.close();
  }
  for (const annotations of [{ links: [{ uri: 'x', bounds: [0, 0, Infinity, 2] }], destinations: [] },
    { links: [], destinations: [{ name: 'x', x: NaN, y: 0 }] }, { links: Array(4097).fill({ uri: 'x', bounds: [0, 0, 1, 1] }), destinations: [] }]) {
    const input = new PassThrough(), errors: Error[] = [];
    readPreviewProtocol(input, () => {}, () => assert.fail('invalid metadata'), error => errors.push(error));
    input.write(JSON.stringify(['preview-image', { ...svg, annotations }]) + '\n');
    assert.equal(errors.length, 1);
  }
});


test('PNG patch framing accepts metadata-only frames immediately and validates crop bounds', () => {
  const empty = { ...header, byteLength: 0, rasterId: 2, patch: { base: 1, rect: [0, 0, 0, 0] } };
  const input = new PassThrough(), images: PreviewImage[] = [], messages: unknown[] = [];
  const reader = readPreviewProtocol(input, m => messages.push(m), f => images.push(f), e => { throw e; });
  input.write(JSON.stringify(['preview-image', empty]) + '\n');
  assert.equal(images.length, 1, 'zero-byte frames do not wait for a following chunk');
  assert.equal(images[0].bytes.length, 0);
  for (const byte of frame) { input.write(Buffer.from([byte])); }
  input.write('["flush"]\n');
  assert.equal(images.length, 2); assert.deepEqual(images[1].bytes, body); assert.deepEqual(messages, [['flush']]);
  reader.close();
  assert.ok(isImageHeader({ ...header, rasterId: 3, patch: { base: 2, rect: [1, 2, 3, 4] } }));
  for (const change of [{ patch: undefined }, { mime: 'image/svg+xml' }, { rasterId: -1 },
    { patch: { base: 0, rect: [0, 0, 0, 0] } }, { patch: { base: 1, rect: [0, 0, 1, 0] } },
    { byteLength: 4, patch: { base: 1, rect: [99, 0, 2, 1] } }, { patch: { base: 1, rect: [0.5, 0, 0, 0] } }]) {
    assert.equal(isImageHeader({ ...empty, ...change }), false);
  }
});


test('native export timing is optional and rejects nonfinite, negative and nonnumeric costs', () => {
  assert.equal(isImageHeader(header), true);
  assert.equal(isImageHeader({ ...header, exportMs: 0 }), true);
  assert.equal(isImageHeader({ ...header, exportMs: 3.5 }), true);
  for (const exportMs of [-1, Infinity, NaN, '3']) { assert.equal(isImageHeader({ ...header, exportMs }), false); }
});


test('cursor preparation acknowledgments reject malformed identities and unknown statuses', () => {
  for (const result of ['ready', 'cached', 'skipped', 'cancelled']) {
    assert.equal(isPreviewMessage(['preview-prepared', 1, 3, 2, result]), true);
  }
  for (const value of [
    ['preview-prepared', 1, 3, 2], ['preview-prepared', 1, 3, 2, 'ready', 'extra'],
    ['preview-prepared', -1, 3, 2, 'ready'], ['preview-prepared', 1.5, 3, 2, 'ready'],
    ['preview-prepared', 1, NaN, 2, 'ready'], ['preview-prepared', 1, 3, -1, 'ready'],
    ['preview-prepared', 1, 3, 2, 'complete']
  ]) { assert.equal(isPreviewMessage(value), false, JSON.stringify(value)); }
});

test('identified source replies cannot override newer searches within the same source sequence', async () => {
  const main = document('/work/main.tex'), child = new FakeProcess(), events: unknown[] = [];
  const session = new TexpressoSession(main, { ...config, previewLocation: 'editor' }, new SessionPaths(main.fileName, false),
    () => [main], { state() {}, output() {}, debug() {}, synctex() {}, error: error => { throw error; }, preview: event => events.push(event) }, undefined,
    () => { queueMicrotask(() => child.emit('spawn')); return child.asChild(); }, {
      probePreview: async (_configuration, _cwd, features) => {
        features?.({ regions: true, svg: true, links: true, auto: true, pngPatches: true, background: true, prepareEdit: true, requestLifecycle: true });
        return true;
      }
    });
  try {
    await session.start();
    session.sync.syncForward(main, 3); session.sync.syncForward(main, 9);
    const searches = child.commands.filter(c => c[0] === 'preview-search'); assert.equal(searches.length, 2);
    const [first, second] = searches; assert.notEqual(first[1], second[1]);
    child.stdout.write(JSON.stringify(['preview-source', first[1], 4, session.previewSequence, 2, 20, 30]) + '\n');
    assert.equal(events.filter(e => Array.isArray(e) && e[0] === 'preview-forward').length, 0);
    child.stdout.write(JSON.stringify(['preview-source', second[1], 4, session.previewSequence, 8, 20, 30]) + '\n');
    assert.deepEqual(events.filter(e => Array.isArray(e) && e[0] === 'preview-forward'), [['preview-forward', 4, session.previewSequence, 8, 20, 30]]);
    session.sync.syncForward(main, 20); const third = child.commands.at(-1)!;
    session.send(['preview-cancel', 0, 0]);
    child.stdout.write(JSON.stringify(['preview-source', third[1], 4, session.previewSequence, 19, 20, 30]) + '\n');
    assert.equal(events.filter(e => Array.isArray(e) && e[0] === 'preview-forward').length, 1, 'canceled source reply stays obsolete');
    const oldSequence = session.previewSequence;
    session.send(['rescan']);
    child.stdout.write(JSON.stringify(['preview-state', 99, oldSequence, 1, true, 0]) + '\n');
    assert.equal(session.previewState, undefined, 'stale session state cannot corrupt later source-follow metadata');
    for (const malformed of [['preview-source', -1, 1, 1, 0, 0, 0], ['preview-source', 1, 1, 1, 0, Infinity, 0], ['preview-cancelled', -1]]) {
      assert.equal(isPreviewMessage(malformed), false);
    }
  } finally { await session.dispose(); }
});

test('paused recovery launch primes every current editor overlay before resume', async () => {
  const main = document('/work/main.tex', 'unsaved root'), included = document('/work/chapter.tex', 'unsaved include');
  const child = new FakeProcess(), errors: Error[] = []; let launchArguments: string[] = [];
  const session = new TexpressoSession(main, { ...config, previewLocation: 'editor' }, new SessionPaths(main.fileName, false),
    () => [main, included], { state() {}, output() {}, debug() {}, synctex() {}, error: error => errors.push(error) }, undefined,
    (_command, args) => { launchArguments = args; queueMicrotask(() => child.emit('spawn')); return child.asChild(); },
    { recovering: true, probePreview: async () => true });
  try {
    await session.start(); assert.ok(launchArguments.includes('-stream'));
    const resume = child.commands.findIndex(c => c[0] === 'resume'); assert.ok(resume > 0);
    for (const doc of [main, included]) {
      const opened = child.commands.findIndex(c => c[0] === 'open' && c[1] === doc.fileName && c[2] === doc.getText());
      assert.ok(opened >= 0 && opened < resume, doc.fileName + ' replays before compilation resumes');
    }
    child.emit('close', 0, null); await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 1); assert.ok(errors[0] instanceof EngineFailure);
    assert.equal((errors[0] as EngineFailure).phase, 'exit', 'unexpected clean embedded exit is recoverable');
  } finally { await session.dispose(); }
});

test('recovering a paused preview restores overlays without a transient resume or compilation', async () => {
  const main = document('/work/main.tex', 'latest root'), included = document('/work/chapter.tex', 'latest included');
  const child = new FakeProcess(), states: boolean[] = [];
  const session = new TexpressoSession(main, { ...config, previewLocation: 'editor', autoRerun: true }, new SessionPaths(main.fileName, false),
    () => [main, included], { state: () => states.push(session.paused), output() {}, debug() {}, synctex() {}, error(error) { throw error; } }, undefined,
    () => { queueMicrotask(() => child.emit('spawn')); return child.asChild(); },
    { recovering: true, initialPaused: true, probePreview: async () => true });
  try {
    assert.equal(session.paused, true, 'paused state exists before launching the replacement');
    await session.start();
    for (const doc of [main, included]) {
      assert.ok(child.commands.some(command => command[0] === 'open' && command[1] === doc.fileName && command[2] === doc.getText()));
    }
    assert.equal(child.commands.some(command => command[0] === 'resume'), false, 'stream start remains paused after overlay restoration');
    assert.ok(states.every(paused => paused), 'status never exposes a transient running compilation');
    session.setPaused(false);
    assert.deepEqual(child.commands.at(-1), ['resume'], 'only an explicit Resume starts compilation');
  } finally { await session.dispose(); }
});


test('optional full-page text geometry survives PNG, SVG and no-op patch framing', () => {
  const textBounds: [number, number, number, number] = [72, 85, 540, 710];
  const variants: PreviewImageHeader[] = [
    { ...header, textBounds },
    { ...header, textBounds, mime: 'image/svg+xml' },
    { ...header, textBounds, byteLength: 0, rasterId: 2, patch: { base: 1, rect: [0, 0, 0, 0] } }
  ];
  for (const value of variants) {
    const input = new PassThrough(), frames: PreviewImage[] = [];
    const reader = readPreviewProtocol(input, () => {}, image => frames.push(image), error => { throw error; });
    const bytes = value.byteLength ? body : Buffer.alloc(0);
    const payload = Buffer.concat([Buffer.from(JSON.stringify(['preview-image', value]) + '\n'), bytes]);
    for (const byte of payload) { input.write(Buffer.from([byte])); }
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].header.textBounds, textBounds);
    assert.deepEqual(frames[0].bytes, bytes);
    reader.close();
  }
  assert.ok(isImageHeader(header), 'older engines can omit text geometry');
  assert.ok(isImageHeader({ ...header, textBounds: [-10, -20, 620, 800] }), 'overhanging text stays in page coordinates');
  for (const invalid of [null, [], [1, 2, 3], [0, 0, 0, 10], [0, 0, 10, 0], [0, 0, Infinity, 10], [0, NaN, 10, 10], ['0', 0, 10, 10]]) {
    assert.equal(isImageHeader({ ...header, textBounds: invalid }), false);
  }
});
