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

test('UTF-8 native columns and UTF-16 editor columns preserve Unicode boundaries', () => {
  const { characterFromByteColumn, sourceWordAt } = require('../source-word');
  const line = 'é😀 office';
  assert.equal(characterFromByteColumn(line, 8), 4);
  assert.equal(characterFromByteColumn(line, 4), 1, 'never split a surrogate pair');
  assert.equal(characterFromByteColumn(line, -1), undefined);
  assert.equal(characterFromByteColumn(line, 1000), undefined);
  assert.equal(sourceWordAt(line, 6), 'office');
  assert.equal(sourceWordAt('\\office{literal}', 3), undefined);
  assert.equal(sourceWordAt('% office', 5), undefined);
  assert.equal(sourceWordAt('\\textbf{office}', 10), 'office');
  assert.equal(sourceWordAt('é'.repeat(129), 2), undefined, 'hints obey the native UTF-8 byte budget');
});
