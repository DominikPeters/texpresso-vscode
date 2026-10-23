import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RecoveryBudget, isRecoverableEngineFailure } from '../recovery';
import { EngineFailure } from '../failures';

test('recovery allows at most two attempts per rolling minute without resetting on success', () => {
  let now = 0;
  const budget = new RecoveryBudget(2, 60000, () => now);
  assert.equal(budget.take(), true); now = 1000; assert.equal(budget.take(), true);
  now = 59999; assert.equal(budget.take(), false);
  now = 60000; assert.equal(budget.take(), true);
  assert.equal(budget.take(), false, 'the second original attempt still belongs to the rolling window');
  now = 61000; assert.equal(budget.take(), true); assert.equal(budget.take(), false);
  budget.reset(); assert.equal(budget.take(), true, 'manual restart starts a new session chain');
});

test('recovery classifies only runtime transport failures and unexpected exits', () => {
  for (const phase of ['exit', 'connection'] as const) {
    const failure = new EngineFailure(phase, phase === 'exit' ? 'TeXpresso exited with code 0' : 'Pipe closed');
    assert.equal(isRecoverableEngineFailure(failure, true), true);
    assert.equal(isRecoverableEngineFailure(failure, false), false, 'never restart a failed initial launch');
  }
  for (const phase of ['configuration', 'launch'] as const) {
    assert.equal(isRecoverableEngineFailure(new EngineFailure(phase, 'bad setup'), true), false);
  }
  assert.equal(isRecoverableEngineFailure(new Error('something unrelated'), true), false);
  for (const details of ['unknown option --foo', '! Undefined control sequence.\nl.12 \\typo', 'Emergency stop.', 'Fatal error occurred',
    'TeX capacity exceeded', 'Runaway argument?', 'LaTeX Error: missing file', 'Package cleveref Error: bad reference']) {
    assert.equal(isRecoverableEngineFailure(new EngineFailure('exit', 'exit 1', undefined, details), true), false, details);
    assert.equal(isRecoverableEngineFailure(new EngineFailure('connection', 'Pipe closed'), true, details), false, details);
  }
});
