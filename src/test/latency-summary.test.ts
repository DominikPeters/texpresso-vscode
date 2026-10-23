import { test } from 'node:test';
import * as assert from 'node:assert/strict';
const { summarizeLatency } = require('../../scripts/profiling/latency-summary.cjs');

const header = (id: number, sequence = id, page = 1) => ({ requestId: id, sequence, revision: sequence, page, width: 100, height: 200, bounds: [0, 0, 1, 2], mime: 'image/png', byteLength: 10 });
const input = (sequence: number, applied: number) => ({ phase: 'typed', sequence, applied, completed: applied + 1, sourceValid: true, manualViewport: false });
const paint = (id: number, at: number, latestSequence = id) => ({ varied: 'paint', phase: 'typed', hostAt: at, header: header(id), latestSequence, latestRevision: latestSequence, toolbar: 0, contentId: 'content-' + id, shells: [{ page: 1, visible: true, sequence: id }] });
const fixture = () => ({ inputs: [input(1, 0), input(2, 100)], phases: [{ name: 'typed', start: 0, end: 900 }], messages: [1, 2].map(sequence => ({ at: sequence === 1 ? 5 : 105, received: ['preview-forward', sequence, sequence, 1, 0, 0] })), browser: [paint(1, 120, 2), paint(2, 160, 2)] });

test('latency audit separates input catch-up from fully current observation and uses source affinity over toolbar', () => {
  const result = summarizeLatency(fixture()), phase = result.phases[0];
  assert.equal(phase.sourceEpochCatchUpAtObserverReceipt.maxMs, 120);
  assert.equal(phase.fullyCurrentAtObserverReceipt.maxMs, 160);
  assert.equal(phase.fullyCurrentAtObserverReceipt.worst[0].frameSequence, 2);
  const source = fixture(); source.browser[1].shells[0].visible = false;
  assert.equal(summarizeLatency(source).phases[0].fullyCurrentAtObserverReceipt.count, 0);
});

test('last unchanged source epoch is censored during typing and never counted as a 700 ms pixel stall', () => {
  const source: any = fixture(); source.browser = [paint(1, 20, 1), paint(2, 120, 2)];
  source.browser[1].contentId = source.browser[0].contentId;
  source.messages.push({ at: 115, received: { ...header(2), byteLength: 0, patch: { base: 1, rect: [0, 0, 0, 0] } } });
  const phase = summarizeLatency(source).phases[0];
  assert.equal(phase.typingWindow.end, 101);
  assert.equal(phase.postTypingWindow.durationMs, 799);
  assert.equal(phase.finalInputHasNativeNoOpPatch, true);
  assert.equal(phase.encodedSurfaceProgressDuringTyping.terminalCensored, true);
  assert.equal(phase.encodedSurfaceProgressDuringTyping.terminalPendingMs, 101);
  assert.equal(phase.encodedSurfaceProgressDuringTyping.observedIntervals.maxMs, null);
});

test('browser-local stage durations do not subtract browser timestamps from host timestamps', () => {
  const source: any = fixture(); source.messages.push({ at: 10, received: header(1) });
  source.timeline = [{ stage: 'post', at: 12, id: 1 }, { stage: 'decoded', phase: 'typed', at: 35, id: 1, latestSequence: 1, latestRevision: 1, displayed: true, stale: false, renderMs: 8,
    profileTiming: { receivedAt: 1000, committedAt: 1008, ackAt: 1009, timeOrigin: 999999, latestSequence: 1, visible: true, visibility: 'visible' } }];
  source.browser[0].timing = { receivedAt: 1000, committedAt: 1008, firstRafAt: 1200, paintAt: 1216, timeOrigin: 999999 };
  const report = summarizeLatency(source);
  assert.equal(report.stages.browserReceiveToCommitMs.maxMs, 8);
  assert.equal(report.stages.browserCommitToTwoRafMs.maxMs, 208);
  assert.equal(report.stages.postToAckRoundTripMs.maxMs, 23);
  assert.equal(report.phases[0].currentVisibleCommitAckUpperBound.maxMs, 35);
});

test('successful commit ACKs survive absent rAF observations and require recorded visibility for visible latency', () => {
  const source: any = fixture(); source.browser = []; source.messages.push({ at: 10, received: header(1) });
  source.timeline = [{ stage: 'post', at: 11, id: 1 }, { stage: 'decoded', phase: 'typed', at: 30, id: 1, latestSequence: 1, latestRevision: 1, displayed: true, stale: false, profileTiming: { receivedAt: 100, committedAt: 105, latestSequence: 1 } }];
  let report = summarizeLatency(source);
  assert.equal(report.instrumentation.commitAcks, 1);
  assert.equal(report.commitStages.browserReceiveToCommitMs.maxMs, 5);
  assert.equal(report.phases[0].currentVisibleCommitAckUpperBound.count, 0);
  source.timeline[1].profileTiming.visible = true; source.timeline[1].profileTiming.visibility = 'visible';
  report = summarizeLatency(source);
  assert.equal(report.phases[0].currentVisibleCommitAckUpperBound.maxMs, 30);
});

test('invalid source and manual navigation intervals cannot establish source latency', () => {
  const source = fixture(); source.inputs[1].sourceValid = false;
  assert.equal(summarizeLatency(source).phases[0].sourceEpochCatchUpAtObserverReceipt.count, 0);
  source.inputs[1].sourceValid = true; source.inputs[0].manualViewport = true;
  assert.equal(summarizeLatency(source).phases[0].sourceEpochCatchUpAtObserverReceipt.count, 1);
});


test('source-current observations cannot claim convergence-current without the latest compiler revision', () => {
  const source: any = fixture(); delete source.browser[1].latestRevision;
  const phase = summarizeLatency(source).phases[0];
  assert.equal(phase.sourceCurrentAtObserverReceipt.count, 2);
  assert.equal(phase.fullyCurrentAtObserverReceipt.count, 0);
  source.browser[1].latestRevision = 3;
  assert.equal(summarizeLatency(source).phases[0].fullyCurrentAtObserverReceipt.count, 0);
});


test('a browser-current commit cannot satisfy the strict endpoint while the host is ahead', () => {
  const source: any = fixture(); source.browser = []; source.messages.push({ at: 10, received: header(1) });
  source.timeline = [{ stage: 'post', at: 11, id: 1 }, { stage: 'decoded', phase: 'typed', at: 30, id: 1, latestSequence: 2, latestRevision: 2, displayed: true, stale: false,
    profileTiming: { receivedAt: 100, committedAt: 105, latestSequence: 1, latestRevision: 1, visible: true, visibility: 'visible' } }];
  let phase = summarizeLatency(source).phases[0];
  assert.equal(phase.currentVisibleCommitAckUpperBound.count, 0);
  assert.equal(phase.browserObservedCurrentVisibleCommitAckUpperBound.maxMs, 30);
  source.timeline[1].latestSequence = 1; source.timeline[1].latestRevision = 1;
  phase = summarizeLatency(source).phases[0];
  assert.equal(phase.currentVisibleCommitAckUpperBound.maxMs, 30);
  delete source.timeline[1].latestRevision;
  assert.equal(summarizeLatency(source).phases[0].currentVisibleCommitAckUpperBound.count, 0);
});

test('geometric intersection in a hidden document cannot establish a visible commit', () => {
  const source: any = fixture(); source.browser = []; source.messages.push({ at: 10, received: header(1) });
  source.timeline = [{ stage: 'decoded', phase: 'typed', at: 30, id: 1, latestSequence: 1, latestRevision: 1, displayed: true, stale: false,
    profileTiming: { receivedAt: 100, committedAt: 105, latestSequence: 1, visible: true, visibility: 'hidden' } }];
  let report = summarizeLatency(source);
  assert.equal(report.instrumentation.visibleCommitAcks, 0);
  assert.equal(report.phases[0].currentVisibleCommitAckUpperBound.count, 0);
  source.timeline[0].profileTiming.visibility = 'visible';
  report = summarizeLatency(source);
  assert.equal(report.phases[0].currentVisibleCommitAckUpperBound.maxMs, 30);
});


test('a host cache post and ACK establish a current visible commit without inventing new native work', () => {
  const source: any = fixture(); source.browser = [paint(1, 50, 1)];
  source.timeline = [{ stage: 'post', at: 10, id: 1, page: 1, sequence: 1, revision: 1, mime: 'image/png', width: 100, height: 200 },
    { stage: 'decoded', phase: 'typed', at: 30, id: 1, latestSequence: 1, latestRevision: 1, displayed: true, stale: false,
      profileTiming: { receivedAt: 100, committedAt: 105, latestSequence: 1, visible: true, visibility: 'visible' } }];
  source.browser[0].header.exportMs = 7;
  const report = summarizeLatency(source);
  assert.equal(report.phases[0].currentVisibleCommitAckUpperBound.maxMs, 30);
  assert.equal(report.commitStages.headerToAckMs.count, 0);
  assert.equal(report.stages.inputToHeaderMs.count, 0);
  assert.equal(report.stages.nativeExportMs.count, 0);
  assert.equal(report.slowestCommitRoundTrips[0].snapshotProvenance, 'host-post-without-native-frame');
});


test('sampled exposure keeps hidden and sparse unknown intervals separate from visible latency', () => {
  const source: any = fixture(); source.browser = [{ varied: 'scheduler', hostAt: -1, visibility: 'visible' }, { varied: 'message', hostAt: 50, visibility: 'hidden' }, { varied: 'message', hostAt: 90, visibility: 'visible' }];
  source.messages.push({ at: 110, received: header(2) });
  source.timeline = [{ stage: 'decoded', phase: 'typed', at: 120, id: 2, latestSequence: 2, latestRevision: 2, displayed: true, stale: false,
    profileTiming: { receivedAt: 100, committedAt: 105, latestSequence: 2, latestRevision: 2, visible: true, visibility: 'visible' } }];
  let phase = summarizeLatency(source).phases[0];
  assert.equal(phase.currentVisibleCommitAckUpperBound.count, 2);
  assert.equal(phase.sampledVisibleExposureCommit.count, 1);
  assert.equal(phase.sampledVisibleExposureCommit.maxMs, 20);
  assert.equal(phase.sampledVisibleExposureCommit.counts.hidden, 1);
  source.browser = [{ varied: 'scheduler', hostAt: -1000, visibility: 'visible' }];
  phase = summarizeLatency(source).phases[0];
  assert.equal(phase.sampledVisibleExposureCommit.count, 0);
  assert.equal(phase.sampledVisibleExposureCommit.counts.unknown, 2);
});
