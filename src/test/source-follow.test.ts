import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SourceFollow, type SourceFollowIntent } from '../source-follow';

const intent = (): SourceFollowIntent => ({ session: {}, document: 'file:///work/main.tex', version: 1,
  line: 100, sequence: 4, revision: 8 });

test('compiler flushes cannot recursively create automatic source-follow work', () => {
  const follow = new SourceFollow(), source = intent();
  let sends = 0;
  const rendered = () => {
    if (follow.request(source)) { sends++; rendered(); }
  };
  rendered();
  for (let i = 0; i < 100; i++) { rendered(); }
  assert.equal(sends, 1, 'initial sync remains available, but acknowledgments are not new intent');
});

test('source edits and real compiler passes refresh automatic following once', () => {
  const follow = new SourceFollow(), source = intent();
  assert.equal(follow.request(source), true); assert.equal(follow.request(source), false);
  source.version++; source.sequence++;
  assert.equal(follow.request(source), true, 'editing on the same line is still a new source target');
  assert.equal(follow.request(source), false);
  source.revision++;
  assert.equal(follow.request(source), true, 'auxiliary reruns can move a source target without another keystroke');
  assert.equal(follow.request(source), false);
  source.sequence++;
  assert.equal(follow.request(source), true, 'dependency updates can change the render without editor version changes');
});

test('moving between source lines or documents creates intent, including returning to an earlier line', () => {
  const follow = new SourceFollow(), source = intent();
  assert.equal(follow.request(source), true);
  source.line++; assert.equal(follow.request(source), true);
  source.line--; assert.equal(follow.request(source), true);
  assert.equal(follow.request(source), false);
  source.document = 'file:///work/appendix.tex'; assert.equal(follow.request(source), true);
  source.document = 'file:///work/main.tex'; assert.equal(follow.request(source), true);
});

test('manual forward commands always force the target while their later flush is deduplicated', () => {
  const follow = new SourceFollow(), source = intent();
  assert.equal(follow.request(source), true);
  assert.equal(follow.request(source, true), true);
  assert.equal(follow.request(source, true), true);
  assert.equal(follow.request(source), false);
});

test('a replacement session gets initial following even for the same file and source version', () => {
  const follow = new SourceFollow(), source = intent();
  assert.equal(follow.request(source), true);
  const replacement = { ...source, session: {} };
  assert.equal(follow.request(replacement), true);
  assert.equal(follow.request(source), false);
  assert.equal(follow.request(replacement), false);
});

test('explicit rerun or recovery invalidation permits exactly one unchanged automatic target', () => {
  const follow = new SourceFollow(), source = intent(), other = intent();
  assert.equal(follow.request(source), true); assert.equal(follow.request(other), true);
  follow.invalidate(source.session);
  assert.equal(follow.request(source), true); assert.equal(follow.request(source), false);
  assert.equal(follow.request(other), false, 'recovery does not reset another session');
});

test('manual preview navigation holds automatic following across compiler passes and dependency updates', () => {
  const follow = new SourceFollow(), source = intent();
  assert.equal(follow.request(source), true);
  follow.suspend(source.session);
  for (let i = 0; i < 4; i++) {
    source.revision++; source.sequence++;
    assert.equal(follow.request(source), false, 'late auxiliary passes cannot override the chosen preview page');
  }
  source.version++;
  assert.equal(follow.request(source), true, 'editing the source resumes following');
  assert.equal(follow.request(source), false);
  source.revision++;
  assert.equal(follow.request(source), true, 'normal pass following resumes after a real edit');
});

test('source selection and explicit forward commands resume after manual preview navigation', () => {
  const follow = new SourceFollow(), source = intent();
  follow.request(source); follow.suspend(source.session);
  source.line++; assert.equal(follow.request(source), true);
  follow.suspend(source.session);
  source.document = 'file:///work/appendix.tex'; assert.equal(follow.request(source), true);
  follow.suspend(source.session);
  assert.equal(follow.request(source, true), true, 'manual source reveal always overrides a preview hold');
  assert.equal(follow.request(source), false, 'the manual reveal completion cannot recursively reveal again');
});

test('preview navigation before initial compilation suppresses its late initial target', () => {
  const follow = new SourceFollow(), source = intent();
  follow.suspend(source.session);
  assert.equal(follow.request(source), false);
  source.revision++; assert.equal(follow.request(source), false);
  source.line++; assert.equal(follow.request(source), true);
});

test('preview holds are per-session and compiler recovery does not resume them', () => {
  const follow = new SourceFollow(), source = intent(), other = intent();
  follow.request(source); follow.request(other); follow.suspend(source.session);
  source.revision++; other.revision++;
  assert.equal(follow.request(source), false);
  assert.equal(follow.request(other), true);
  follow.invalidate(source.session);
  assert.equal(follow.request(source), false, 'rerun recovery still respects the chosen preview page');
  assert.equal(follow.request(source, true), true, 'an explicit source reveal resumes following');
});


test('horizontal caret motion resumes a preview hold without issuing redundant ordinary line searches', () => {
  const follow = new SourceFollow(), source = intent(); source.column = 2;
  assert.equal(follow.request(source), true);
  source.column = 3; assert.equal(follow.request(source), false, 'normal following is line-based');
  follow.suspend(source.session);
  source.revision++; assert.equal(follow.request(source), false, 'the hold remembers the latest column');
  source.column = 4; assert.equal(follow.request(source), true, 'a new same-line selection resumes the source intent');
  assert.equal(follow.request(source), false);
});
