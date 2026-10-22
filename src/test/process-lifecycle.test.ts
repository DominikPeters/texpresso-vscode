import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { EngineProcess } from '../engine-process';
import { FakeProcess } from './helpers';

const events = () => ({ message() {}, debug() {}, error(error: Error) { throw error; }, exit() {} });

test('cancelling startup settles start and idempotently stops a late spawn', async () => {
  const child = new FakeProcess();
  const engine = new EngineProcess(events(), () => child.asChild());
  const starting = engine.start({ command: 'fixture', args: [], cwd: process.cwd() });
  const stopping = engine.dispose();
  assert.equal(engine.dispose(), stopping);
  await starting; await stopping;
  child.emit('spawn');
  child.stdout.write('["flush"]\n');
  assert.ok(child.killed);
});

test('shutdown kills an unresponsive launcher and its worker', { timeout: 30000 }, async context => {
  const pids: number[] = [];
  let pending = '';
  const started = Date.now();
  const engine = new EngineProcess(events(), (command, args, options) => {
    const child = require('node:child_process').spawn(command, args, options) as import('node:child_process').ChildProcess;
    child.stdout!.on('data', chunk => {
      pending += String(chunk);
      for (const line of pending.split('\n').slice(0, -1)) {
        try { const value = JSON.parse(line); const pid = value.parent || value.worker; if (pid && !pids.includes(pid)) { pids.push(pid); } }
        catch { /* Engine protocol diagnostics may also be present. */ }
      }
    });
    return child;
  });
  try {
    await engine.start({ command: process.execPath, args: [path.resolve(__dirname, '../../src/test/fixtures/process-tree.cjs')], cwd: process.cwd() });
    // Starting two Node processes can be slow on hosted Windows runners.
    // Keep startup separate from the bounded shutdown and reaping checks.
    const end = Date.now() + (process.platform === 'win32' ? 10000 : 3000);
    while (pids.length < 2 && Date.now() < end) { await new Promise(resolve => setTimeout(resolve, 20)); }
    context.diagnostic('Launcher and worker startup: ' + (Date.now() - started) + ' ms; PIDs: ' + pids.join(', '));
    assert.equal(pids.length, 2, 'launcher and worker started');
    const stopping = Date.now();
    await engine.dispose();
    context.diagnostic('Engine disposal: ' + (Date.now() - stopping) + ' ms');
    for (const pid of pids) {
      const deadline = Date.now() + 2000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
        catch { alive = false; }
      }
      assert.equal(alive, false, 'process ' + pid + ' was reaped');
    }
  } finally { await engine.dispose(); }
});


test('macOS EPERM is ignored only after verifying the owned process group has no live workers',
  { skip: process.platform !== 'darwin' }, async context => {
    const cp = require('node:child_process');
    const denied = Object.assign(new Error('kill denied'), { code: 'EPERM' });
    context.mock.method(process, 'kill', () => { throw denied; });
    for (const [output, psError, succeeds] of [
      ['123 S\n42000 Z\n', null, true],
      ['123 S\n', null, true],
      ['42000 S\n', null, false],
      ['malformed', null, false],
      ['', new Error('ps failed'), false]
    ] as const) {
      const ps = context.mock.method(cp, 'execFile', (_command: string, args: string[], _options: object, callback: Function) => {
        assert.deepEqual(args, ['-axo', 'pgid=,stat=']); callback(psError, output);
      });
      const child = new FakeProcess(); Object.assign(child, { pid: 42000 });
      const { terminate } = require('../process-lifecycle') as typeof import('../process-lifecycle');
      if (succeeds) { await terminate(child.asChild()); }
      else { await assert.rejects(terminate(child.asChild()), error => error === denied); }
      ps.mock.restore();
    }
  });
