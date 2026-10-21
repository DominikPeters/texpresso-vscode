import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { refineSourceWord } from '../source-word';

test('line-only SyncTeX refines unique literal words, including wrapped source, Unicode and ligatures', () => {
  assert.deepEqual(refineSourceWord('An immediate connection.', 0, 'connection.'), { line: 0, character: 13 });
  assert.deepEqual(refineSourceWord('First source line\nwith a unique target.\\par', 1, 'source'), { line: 0, character: 6 });
  assert.deepEqual(refineSourceWord('🙂 An efficient office.', 0, 'oﬃce.'), { line: 0, character: 16 });
  assert.deepEqual(refineSourceWord('\\textbf{connection}', 0, 'connection'), { line: 0, character: 8 });
});

test('word refinement retains line-only navigation for ambiguous, absent, generated, or commented words', () => {
  for (const source of ['target target', 'target\nsecond target', '\\target', '% target', '\\\\% target', 'untargeted', '\\section{heading}\nother text']) {
    assert.equal(refineSourceWord(source, source.includes('\n') ? 1 : 0, 'target'), undefined, source);
  }
  assert.equal(refineSourceWord('a word\n\ntarget', 0, 'target'), undefined, 'does not cross paragraph boundaries');
  assert.equal(refineSourceWord('target', 0), undefined);
});
