import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readPreviewProtocol, type PreviewImageHeader, type PreviewImage } from '../preview-protocol';
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

test('capability probing distinguishes a missing executable from missing preview support', async () => {
  await assert.rejects(probePreview({ ...config, command: '/texpresso-nonexistent-directory/missing-executable' }),
    error => error instanceof EngineFailure && error.phase === 'launch' && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
  const failure = describeFailure(new EngineFailure('configuration', 'Choose another engine or Window.', 'PREVIEW_UNSUPPORTED'));
  assert.equal(failure.setting, 'texpresso.previewLocation');
  assert.equal(failure.message, 'Choose another engine or Window.');
});
