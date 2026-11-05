import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { EditPrewarm, type SourcePosition } from '../edit-prewarm';
import type { Command } from '../protocol';

type Prepare = Extract<Command, ['preview-prepare', ...unknown[]]>;
function fixture(t: TestContext) {
  (t.mock.timers as unknown as { enable(options: { apis: string[] }): void }).enable({ apis: ['setTimeout'] });
  const context = { available: true, idle: true, revision: 7, sequence: 11 };
  const commands: Command[] = [];
  let next = 100, started = 0, settled = 0;
  const warm = new EditPrewarm(() => context, command => commands.push(command), () => ++next,
    () => { started++; }, () => { settled++; });
  t.after(() => warm.interrupt());
  const preparations = () => commands.filter((command): command is Prepare => command[0] === 'preview-prepare');
  const ack = (command: Prepare, status: 'ready' | 'cached' | 'skipped' | 'cancelled' = 'ready') =>
    warm.handle(['preview-prepared', command[1], command[4], command[5], status]);
  return { warm, context, commands, preparations, ack, tick: (ms: number) => t.mock.timers.tick(ms),
    started: () => started, settled: () => settled };
}
const position = (offset: number, path = '/work/main.tex'): SourcePosition => ({ path, offset });

test('only settled cursor speculation resolves source bytes and starts work', t => {
  const f = fixture(t);
  let oldResolves = 0, currentResolves = 0;
  f.warm.select('version1:offset64', () => { oldResolves++; return position(64); });
  assert.equal(f.warm.pending, true);
  assert.equal(oldResolves, 0, 'selection does not scan the source synchronously');
  f.tick(150);
  f.warm.select('version1:offset128', () => { currentResolves++; return position(128); });
  f.tick(199);
  assert.equal(oldResolves + currentResolves, 0);
  assert.equal(f.commands.length, 0, 'the debounce delays only speculative compiler work');
  f.tick(1);
  assert.equal(oldResolves, 0, 'a superseded cursor never resolves');
  assert.equal(currentResolves, 1);
  assert.deepEqual(f.preparations()[0], ['preview-prepare', 101, '/work/main.tex', 128, 7, 11]);
  assert.equal(f.started(), 1);
  f.ack(f.preparations()[0]);
  assert.equal(f.warm.pending, false);
  assert.equal(f.settled(), 1);
});

test('nearby cursor positions share one byte bucket while source epochs and files remain distinct', t => {
  const f = fixture(t);
  f.warm.select('first', () => position(128)); f.tick(200); f.ack(f.preparations()[0]);
  f.warm.select('nearby', () => position(191)); f.tick(200);
  assert.equal(f.preparations().length, 1, 'movement inside the same 64-byte bucket does not replay');
  assert.equal(f.warm.pending, false);
  let resolves = 0;
  f.warm.select('next-bucket', () => { resolves++; return position(192); }); f.tick(200);
  assert.equal(f.preparations().length, 2);
  f.ack(f.preparations()[1]);
  f.context.sequence++;
  f.warm.refresh(); f.tick(200);
  assert.equal(f.preparations().length, 3, 'new source content can prepare the same bucket again');
  assert.equal(f.preparations()[2][5], 12);
  assert.equal(resolves, 1, 'immutable cursor position reuses its UTF-8 conversion');
  f.ack(f.preparations()[2]);
  f.context.revision++;
  f.warm.refresh(); f.tick(200); f.ack(f.preparations()[3]);
  assert.equal(f.preparations()[3][4], 8, 'native rollback epochs have independent attempts');
  f.warm.select('different-file', () => position(192, '/work/appendix.tex')); f.tick(200);
  assert.equal(f.preparations().length, 5);
});

test('stale request, revision and sequence acknowledgments cannot settle current preparation', t => {
  const f = fixture(t);
  f.warm.select('first', () => position(64)); f.tick(200);
  const first = f.preparations()[0];
  f.warm.handle(['preview-prepared', first[1] + 1, 7, 11, 'ready']);
  f.warm.handle(['preview-prepared', first[1], 8, 11, 'ready']);
  f.warm.handle(['preview-prepared', first[1], 7, 12, 'ready']);
  assert.equal(f.settled(), 0); assert.equal(f.warm.pending, true);
  f.warm.select('second', () => position(256));
  assert.deepEqual(f.commands.at(-1), ['preview-prepare-cancel', first[1]]);
  f.ack(first);
  assert.equal(f.settled(), 0, 'old completion cannot cancel the replacement debounce');
  f.tick(200);
  const second = f.preparations()[1];
  f.ack(first); assert.equal(f.settled(), 0);
  f.ack(second); assert.equal(f.settled(), 1); assert.equal(f.warm.pending, false);
  f.ack(second); f.tick(5000);
  assert.equal(f.settled(), 1, 'duplicate completion and cleared watchdog are inert');
  assert.equal(f.commands.filter(command => command[0] === 'preview-prepare-cancel').length, 1);
});

test('foreground interruption immediately cancels timers and active replay without waiting for acknowledgment', t => {
  const f = fixture(t);
  let resolves = 0;
  f.warm.select('timer', () => { resolves++; return position(64); });
  f.tick(199); f.warm.interrupt();
  assert.equal(f.warm.pending, false);
  f.tick(5000);
  assert.equal(resolves, 0); assert.equal(f.commands.length, 0);
  f.warm.select('active', () => position(256)); f.tick(200);
  const active = f.preparations()[0]; f.warm.interrupt();
  assert.equal(f.warm.pending, false);
  assert.deepEqual(f.commands.at(-1), ['preview-prepare-cancel', active[1]]);
  f.tick(5000); f.ack(active);
  assert.equal(f.commands.length, 2); assert.equal(f.settled(), 0);
  f.warm.select('new-target', () => position(512)); f.tick(200);
  const latest = f.preparations()[1]; f.warm.select();
  assert.deepEqual(f.commands.at(-1), ['preview-prepare-cancel', latest[1]]);
  f.tick(1000); assert.equal(f.warm.pending, false);
});

test('interrupted replay may retry its settled bucket without repeating the source conversion', t => {
  const f = fixture(t);
  let resolves = 0;
  f.warm.select('same-cursor', () => { resolves++; return position(128); }); f.tick(200);
  const first = f.preparations()[0];
  f.warm.interrupt();
  assert.deepEqual(f.commands.at(-1), ['preview-prepare-cancel', first[1]]);
  f.warm.refresh(); f.tick(199);
  assert.equal(f.preparations().length, 1);
  f.tick(1);
  const second = f.preparations()[1];
  assert.notEqual(second[1], first[1]); assert.equal(second[3], first[3]);
  assert.equal(resolves, 1, 'retry reuses the immutable position, not the canceled native request');
  f.ack(first); assert.equal(f.warm.pending, true);
  f.ack(second); f.warm.refresh(); f.tick(1000);
  assert.equal(f.preparations().length, 2, 'successful retry remains deduplicated');
});

test('unavailable or busy contexts do not resolve or send speculative work', t => {
  const f = fixture(t);
  let resolves = 0;
  f.context.available = false;
  f.warm.select('cursor', () => { resolves++; return position(100); }); f.tick(500);
  assert.equal(f.warm.pending, false); assert.equal(resolves, 0);
  f.context.available = true; f.context.idle = false; f.warm.refresh(); f.tick(500);
  assert.equal(f.warm.pending, false); assert.equal(resolves, 0);
  f.context.idle = true; f.warm.refresh(); f.tick(199);
  f.context.available = false; f.tick(1);
  assert.equal(resolves, 0); assert.equal(f.commands.length, 0);
  f.context.available = true; f.warm.refresh(); f.tick(199);
  f.context.idle = false; f.tick(1);
  assert.equal(resolves, 0, 'foreground work starting during debounce prevents an expensive source scan');
  assert.equal(f.commands.length, 0);
  f.context.idle = true; f.warm.refresh(); f.tick(200);
  assert.equal(resolves, 1); assert.equal(f.preparations().length, 1);
});

test('an unresolved immutable source position is inert and is not repeatedly scanned', t => {
  const f = fixture(t);
  let resolves = 0;
  f.warm.select('unknown-source-v1', () => { resolves++; return undefined; }); f.tick(200);
  assert.equal(f.warm.pending, false); assert.equal(f.commands.length, 0);
  for (let i = 0; i < 4; i++) { f.warm.refresh(); f.tick(300); }
  assert.equal(resolves, 1);
  f.warm.select('known-source-v2', () => position(64)); f.tick(200);
  assert.equal(f.preparations().length, 1);
});

test('watchdog bounds a missing native acknowledgment and cannot later cancel a newer replay', t => {
  const f = fixture(t);
  f.warm.select('first', () => position(64)); f.tick(200);
  const first = f.preparations()[0]; f.tick(4999);
  assert.equal(f.commands.length, 1); assert.equal(f.warm.pending, true);
  f.tick(1);
  assert.deepEqual(f.commands.at(-1), ['preview-prepare-cancel', first[1]]);
  assert.equal(f.warm.pending, false); assert.equal(f.settled(), 1);
  for (let i = 0; i < 3; i++) { f.warm.refresh(); f.tick(1000); }
  assert.equal(f.commands.length, 2, 'a timed-out bucket cannot create a speculative retry loop');
  f.context.sequence++;
  f.warm.refresh(); f.tick(200);
  const second = f.preparations()[1];
  f.ack(first); assert.equal(f.settled(), 1); assert.equal(f.warm.pending, true);
  f.ack(second, 'cached'); f.tick(5000);
  assert.equal(f.settled(), 2); assert.equal(f.commands.length, 3);
});

test('terminal native statuses all release preparation while the attempt cache remains bounded', t => {
  const f = fixture(t);
  const statuses = ['ready', 'cached', 'skipped', 'cancelled'] as const;
  for (let i = 0; i < 17; i++) {
    f.warm.select(`bucket-${i}`, () => position(i * 64 + 1)); f.tick(200);
    f.ack(f.preparations().at(-1)!, statuses[i % statuses.length]);
    assert.equal(f.warm.pending, false);
  }
  assert.equal(f.preparations().length, 17); assert.equal(f.settled(), 17);
  f.warm.select('recent-bucket-again', () => position(16 * 64 + 63)); f.tick(200);
  assert.equal(f.preparations().length, 17, 'recent bucket is still remembered');
  f.warm.select('oldest-bucket-again', () => position(1)); f.tick(200);
  assert.equal(f.preparations().length, 18, 'the oldest of17 attempts was evicted from the16-entry cache');
});

test('skipped preparation retries once after foreground progress and never from its own idle acknowledgments', t => {
  const f = fixture(t);
  let resolves = 0;
  f.warm.select('cursor', () => { resolves++; return position(128); }); f.tick(200);
  f.ack(f.preparations()[0], 'skipped');
  for (let i = 0; i < 4; i++) { f.warm.refresh(); f.tick(500); }
  assert.equal(f.preparations().length, 1, 'ordinary state/idle updates do not retry skipped native work');
  f.warm.refresh(true); f.tick(199);
  assert.equal(f.preparations().length, 1);
  f.warm.refresh(true); f.tick(1);
  assert.equal(f.preparations().length, 2, 'foreground progress schedules exactly one speculative retry');
  assert.equal(resolves, 1, 'native discovery does not rescan an already resolved immutable source position');
  f.ack(f.preparations()[1], 'skipped');
  f.warm.refresh(); f.tick(1000);
  assert.equal(f.preparations().length, 2, 'a second skipped reply still cannot loop');
  f.warm.refresh(true); f.tick(200);
  assert.equal(f.preparations().length, 3);
  f.ack(f.preparations()[2], 'ready');
  for (let i = 0; i < 3; i++) { f.warm.refresh(true); f.tick(500); }
  assert.equal(f.preparations().length, 3, 'a successful retry is retained across later foreground progress');
});

test('foreground discovery retries skipped buckets without forgetting successful READY or CACHED buckets', t => {
  const f = fixture(t);
  for (const [index, status] of (['ready', 'cached', 'skipped'] as const).entries()) {
    f.warm.select(`cursor-${index}`, () => position(index * 64)); f.tick(200);
    f.ack(f.preparations().at(-1)!, status);
  }
  assert.equal(f.preparations().length, 3);
  f.warm.refresh(true); f.tick(200); f.ack(f.preparations()[3], 'cached');
  assert.equal(f.preparations().length, 4, 'only the skipped target was newly eligible');
  for (const index of [0, 1, 2]) {
    f.warm.select(`return-to-${index}`, () => position(index * 64 + 63));
    f.warm.refresh(true); f.tick(200);
  }
  assert.equal(f.preparations().length, 4, 'all successful buckets remain deduplicated, including the retried one');
  assert.equal(f.warm.pending, false);
});

test('foreground source discovery can resolve a formerly unknown cursor without creating an idle scan loop', t => {
  const f = fixture(t);
  let known = false, resolves = 0;
  f.warm.select('included-file-v1:cursor', () => { resolves++; return known ? position(192, '/work/included.tex') : undefined; });
  f.tick(200);
  assert.equal(resolves, 1); assert.equal(f.preparations().length, 0);
  known = true;
  for (let i = 0; i < 3; i++) { f.warm.refresh(); f.tick(500); }
  assert.equal(resolves, 1, 'availability changes alone do not repeatedly scan unresolved sources');
  f.context.idle = false; f.warm.refresh(true); f.tick(500);
  assert.equal(resolves, 1, 'source discovery still defers conversion until foreground work settles');
  f.context.idle = true; f.warm.refresh(); f.tick(199);
  assert.equal(resolves, 1);
  f.tick(1);
  assert.equal(resolves, 2);
  assert.deepEqual(f.preparations()[0].slice(2), ['/work/included.tex', 192, 7, 11]);
  f.ack(f.preparations()[0]);
  f.warm.refresh(true); f.tick(500);
  assert.equal(resolves, 2, 'a successful immutable position remains cached');
  assert.equal(f.preparations().length, 1);
});
