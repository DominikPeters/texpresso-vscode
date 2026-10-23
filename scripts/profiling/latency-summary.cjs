#!/usr/bin/env node
/* Keep host and browser clocks separate. The two-rAF observer is a sampling
 * endpoint, not proof of compositor presentation or of when pixels first changed. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
const stats = values => ({ count: values.length, medianMs: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99), maxMs: percentile(values, 1) });
const finiteDelta = (end, start) => Number.isFinite(end) && Number.isFinite(start) && end >= start ? end - start : null;
const frameKey = (generation, id) => `${generation ?? 0}/${id}`;
const generationOf = frame => frame.header?.profileGeneration ?? frame.generation ?? 0;
const visiblePaint = frame => frame.varied === 'paint' && !frame.superseded && frame.shells?.some(shell => shell.page === frame.header.page && shell.visible && shell.sequence === frame.header.sequence);

function summarizeLatency(result) {
  const inputs = result.inputs || [], messages = result.messages || [], timeline = result.timeline || [], browser = result.browser || [];
  const forwards = messages.filter(message => message.received?.[0] === 'preview-forward');
  const headers = messages.filter(message => Number.isSafeInteger(message.received?.requestId) && message.received?.mime);
  const headerById = new Map(headers.map(message => [frameKey(message.generation, message.received.requestId), message]));
  const posts = new Map(), acks = new Map(), native = new Map();
  for (const event of timeline) {
    const key = frameKey(event.generation, event.id);
    if (event.stage === 'post' && Number.isSafeInteger(event.id)) { posts.set(key, event); }
    if (event.stage === 'decoded' && Number.isSafeInteger(event.id)) { acks.set(key, event); }
  }
  const snapshotFor = key => {
    const record = headerById.get(key);
    if (record) { return { ...record, provenance: 'native-frame' }; }
    const post = posts.get(key);
    if (!post || !Number.isSafeInteger(post.sequence) || !Number.isSafeInteger(post.revision) || !Number.isInteger(post.page)) { return undefined; }
    return { provenance: 'host-post-without-native-frame', received: { requestId: post.id, page: post.page, sequence: post.sequence, revision: post.revision, mime: post.mime, width: post.width, height: post.height, bounds: post.bounds, byteLength: post.nativeBytes } };
  };
  for (const event of result.native || []) {
    const key = frameKey(event.generation, event.request), list = native.get(key) || [];
    list.push(event); native.set(key, list);
  }
  const targetFor = (frame, exactRevision = true) => forwards.filter(message => (message.generation ?? 0) === generationOf(frame) && message.at <= frame.hostAt && message.received[2] === frame.header.sequence && (!exactRevision || message.received[1] === frame.header.revision)).at(-1)?.received;
  const paints = browser.filter(visiblePaint);
  const owning = paints.filter(frame => targetFor(frame)?.[3] === frame.header.page);
  const frames = paints.map(frame => {
    const key = frameKey(generationOf(frame), frame.header.requestId), header = snapshotFor(key), post = posts.get(key), ack = acks.get(key), timing = frame.timing || ack?.profileTiming;
    const stages = native.get(key) || [];
    const origin = inputs.find(input => (input.generation ?? 0) === generationOf(frame) && input.sequence === frame.header.sequence);
    return { generation: generationOf(frame), phase: frame.phase, id: frame.header.requestId, sequence: frame.header.sequence, revision: frame.header.revision, page: frame.header.page, mime: frame.header.mime,
      inputAt: origin?.applied, headerAt: header?.at, postAt: post?.at, ackAt: ack?.at, observerAt: frame.hostAt,
      owningSourcePage: targetFor(frame)?.[3] === frame.header.page,
      sourceCurrentAtObserverReceipt: frame.header.sequence === frame.latestSequence,
      currentAtObserverReceipt: Number.isSafeInteger(frame.latestRevision) ? frame.header.sequence === frame.latestSequence && frame.header.revision === frame.latestRevision : null,
      currentAtBrowserCommit: ack ? ack.displayed === true && ack.stale === false : null,
      inputToHeaderMs: finiteDelta(header?.at, origin?.applied), headerToObserverReceiptMs: finiteDelta(frame.hostAt, header?.at),
      headerToPostMs: finiteDelta(post?.at, header?.at), postToAckRoundTripMs: finiteDelta(ack?.at, post?.at),
      browserReceiveToCommitMs: finiteDelta(timing?.committedAt, timing?.receivedAt), browserCommitToTwoRafMs: finiteDelta(frame.timing?.paintAt, frame.timing?.committedAt),
      browserRenderMs: Number.isFinite(ack?.renderMs) ? ack.renderMs : null,
      snapshotProvenance: header?.provenance ?? 'observer-only', nativeExportMs: header?.provenance === 'native-frame' ? frame.header.exportMs ?? null : null, nativeStages: Object.fromEntries(stages.filter(stage => Number.isFinite(stage.ms)).map(stage => [stage.stage, stage.ms])) };
  });
  // ACKs establish successful commits even when rAF observation is delayed or
  // absent. They do not establish visibility unless the browser records it.
  const commits = [...acks.values()].filter(ack => ack.displayed === true).flatMap(ack => {
    const record = snapshotFor(frameKey(ack.generation, ack.id));
    if (!record) { return []; }
    const h = record.received, timing = ack.profileTiming, post = posts.get(frameKey(ack.generation, ack.id));
    const frame = { header: { ...h, profileGeneration: ack.generation ?? 0 }, hostAt: ack.at };
    return [{ phase: ack.phase, generation: ack.generation ?? 0, id: ack.id, sequence: h.sequence, revision: h.revision, page: h.page,
      ackAt: ack.at, snapshotProvenance: record.provenance, owningSourcePage: targetFor(frame)?.[3] === h.page, geometricVisibleAtCommit: typeof timing?.visible === 'boolean' ? timing.visible : null, documentVisibilityAtCommit: timing?.visibility ?? null, visibleAtCommit: timing?.visible === true && timing?.visibility === 'visible',
      currentAtHostAck: Number.isSafeInteger(ack.latestSequence) && Number.isSafeInteger(ack.latestRevision) ? h.sequence === ack.latestSequence && h.revision === ack.latestRevision : null,
      currentAtBrowserCommit: ack.stale === false && (!Number.isSafeInteger(timing?.latestSequence) || timing.latestSequence === h.sequence) && (!Number.isSafeInteger(timing?.latestRevision) || timing.latestRevision === h.revision),
      browserReceiveToCommitMs: finiteDelta(timing?.committedAt, timing?.receivedAt), postToAckRoundTripMs: finiteDelta(ack.at, post?.at),
      headerToAckMs: finiteDelta(ack.at, record.at), browserRenderMs: Number.isFinite(ack.renderMs) ? ack.renderMs : null }];
  });
  const visibilitySamples = [...browser.filter(event => event.visibility).map(event => ({ at: event.hostAt, generation: event.generation ?? 0, visibility: event.visibility })),
    ...timeline.filter(event => event.stage === 'decoded' && event.profileTiming?.visibility).map(event => ({ at: event.at, generation: event.generation ?? 0, visibility: event.profileTiming.visibility }))].sort((a, b) => a.at - b.at);
  const visibilityExposure = (start, end, generation) => {
    const samples = visibilitySamples.filter(sample => sample.generation === generation), previous = samples.filter(sample => sample.at <= start).at(-1);
    const during = samples.filter(sample => sample.at > start && sample.at <= end), observed = [...(previous ? [previous] : []), ...during];
    const maxGap = observed.reduce((largest, sample, index) => Math.max(largest, index ? sample.at - observed[index - 1].at : start - sample.at), Math.max(0, end - (observed.at(-1)?.at ?? start)));
    if (observed.some(sample => sample.visibility === 'hidden')) { return { state: 'hidden', maxSampleGapMs: maxGap }; }
    if (!previous || observed.some(sample => sample.visibility !== 'visible') || maxGap > 150) { return { state: 'unknown', maxSampleGapMs: maxGap }; }
    return { state: 'sampled-visible', maxSampleGapMs: maxGap };
  };
  const phaseReports = (result.phases || []).map(phase => {
    const phaseInputs = inputs.filter(input => input.phase === phase.name);
    if (!phaseInputs.length) { return { name: phase.name, inputCount: 0 }; }
    const start = phaseInputs[0].applied, end = phaseInputs.at(-1).completed, generation = phase.generation ?? 0;
    const selected = owning.filter(frame => generationOf(frame) === generation && frame.hostAt >= phase.start && frame.hostAt <= phase.end);
    const eligible = phaseInputs.filter(input => input.sourceValid === true && !input.manualViewport);
    const inputLatency = currentMode => eligible.flatMap(input => {
      const frame = selected.find(candidate => candidate.hostAt >= input.completed && candidate.header.sequence >= input.sequence && (!currentMode || (candidate.header.sequence === candidate.latestSequence && (currentMode !== 'revision' || (Number.isSafeInteger(candidate.latestRevision) && candidate.header.revision === candidate.latestRevision)))));
      if (!frame || phaseInputs.some(other => other.applied > input.applied && other.applied < frame.hostAt && (other.sourceValid !== true || other.manualViewport))) { return []; }
      return [{ inputSequence: input.sequence, inputAt: input.applied, frameSequence: frame.header.sequence, frameRevision: frame.header.revision, page: frame.header.page, observerAt: frame.hostAt, ms: frame.hostAt - input.applied }];
    });
    const catchUp = inputLatency(false), sourceCurrent = inputLatency('source'), current = inputLatency('revision');
    const visibleCommits = commits.filter(commit => commit.generation === generation && commit.owningSourcePage && commit.visibleAtCommit && commit.currentAtBrowserCommit && commit.ackAt >= phase.start && commit.ackAt <= phase.end);
    const commitLatency = requireHostCurrent => eligible.flatMap(input => {
      const commit = visibleCommits.find(candidate => candidate.ackAt >= input.completed && candidate.sequence >= input.sequence && (!requireHostCurrent || candidate.currentAtHostAck === true));
      if (!commit || phaseInputs.some(other => other.applied > input.applied && other.applied < commit.ackAt && (other.sourceValid !== true || other.manualViewport))) { return []; }
      return [commit.ackAt - input.applied];
    });
    const commitLatencies = commitLatency(true), browserCurrentCommitLatencies = commitLatency(false);
    const exposureRows = eligible.map(input => {
      const commit = visibleCommits.find(candidate => candidate.ackAt >= input.completed && candidate.sequence >= input.sequence && candidate.currentAtHostAck === true);
      if (!commit || phaseInputs.some(other => other.applied > input.applied && other.applied < commit.ackAt && (other.sourceValid !== true || other.manualViewport))) { return { state: 'unobserved' }; }
      return { ...visibilityExposure(input.applied, commit.ackAt, generation), inputSequence: input.sequence, inputAt: input.applied, ackAt: commit.ackAt, ms: commit.ackAt - input.applied };
    });
    const sampledVisible = exposureRows.filter(row => row.state === 'sampled-visible');
    // Compare encoded content only at identical allocation. A newline can advance
    // the source epoch with identical pixels; its open pixel interval is censored.
    const surfaces = new Map(), epochs = new Map();
    const surfaceKey = frame => JSON.stringify([frame.header.page, frame.header.mime, frame.header.width, frame.header.height, frame.header.bounds]);
    for (const frame of paints.filter(frame => generationOf(frame) === generation && frame.hostAt < start)) {
      surfaces.set(surfaceKey(frame), frame.contentId); epochs.set(frame.header.page, [frame.header.sequence, frame.header.revision]);
    }
    const foreground = paints.filter(frame => generationOf(frame) === generation && frame.hostAt >= start && frame.hostAt <= phase.end && frame.header.page === targetFor(frame, false)?.[3]);
    const epochAdvances = [], changedAdvances = [];
    for (const frame of foreground) {
      const key = surfaceKey(frame), previous = surfaces.get(key), old = epochs.get(frame.header.page), h = frame.header;
      const advances = !old || h.sequence > old[0] || (h.sequence === old[0] && h.revision > old[1]);
      if (old && (h.sequence < old[0] || (h.sequence === old[0] && h.revision < old[1]))) { continue; }
      if (advances) { epochAdvances.push(frame); if (previous !== undefined && previous !== frame.contentId) { changedAdvances.push(frame); } }
      surfaces.set(key, frame.contentId); epochs.set(h.page, [h.sequence, h.revision]);
    }
    const progress = observed => {
      let pending, eligibleNow = false, latest = 0, painted = 0; const completed = [];
      const events = [...phaseInputs.map(input => ({ at: input.applied, input })), ...observed.filter(frame => frame.hostAt <= end).map(frame => ({ at: frame.hostAt, frame }))].sort((a, b) => a.at - b.at);
      for (const event of events) {
        if (event.input) {
          eligibleNow = event.input.sourceValid === true && !event.input.manualViewport; latest = event.input.sequence;
          if (!eligibleNow) { pending = undefined; }
          else if (latest > painted && pending === undefined) { pending = event.at; }
        } else if (eligibleNow && event.frame.header.sequence > painted) {
          painted = event.frame.header.sequence;
          if (pending !== undefined) { completed.push(event.at - pending); pending = painted < latest ? event.at : undefined; }
        }
      }
      const terminal = pending === undefined ? null : Math.max(0, end - pending);
      return { observedIntervals: stats(completed), terminalPendingMs: terminal, terminalCensored: terminal !== null,
        note: 'Typing window ends at the last edit completion. An open interval is censored; unchanged pixels or an unfinished source epoch do not establish a visible stall.' };
    };
    const last = phaseInputs.at(-1), noOpHeaders = headers.filter(message => (message.generation ?? 0) === generation && message.received.sequence === last.sequence && message.received.patch && message.received.byteLength === 0);
    const phaseHeaders = headers.filter(message => (message.generation ?? 0) === generation && message.at >= start && message.at <= phase.end);
    return { name: phase.name, inputCount: phaseInputs.length, typingWindow: { start, end, durationMs: end - start }, postTypingWindow: { start: end, end: phase.end, durationMs: Math.max(0, phase.end - end), note: 'Includes the harness post-phase wait (normally 700 ms), idle refinement, and target rechecks; excluded from typing progress intervals.', headers: phaseHeaders.filter(message => message.at > end).length, observerFrames: selected.filter(frame => frame.hostAt > end).length },
      sourceEpochCatchUpAtObserverReceipt: { ...stats(catchUp.map(row => row.ms)), endpoint: 'Owning visible source-page frame with sequence >= the individual input, observed after two rAF callbacks. It may already be stale relative to later inputs.', worst: catchUp.sort((a, b) => b.ms - a.ms).slice(0, 5) },
      sourceCurrentAtObserverReceipt: { ...stats(sourceCurrent.map(row => row.ms)), endpoint: 'Owning visible frame whose source sequence equals latestSequence at host observer receipt; convergence may already have advanced its compiler revision.', worst: sourceCurrent.sort((a, b) => b.ms - a.ms).slice(0, 5) },
      fullyCurrentAtObserverReceipt: { ...stats(current.map(row => row.ms)), endpoint: 'Owning visible source-page frame whose sequence and revision equal latestSequence/latestRevision at host observer receipt. Unavailable for traces without latestRevision; still not compositor presentation.', worst: current.sort((a, b) => b.ms - a.ms).slice(0, 5) },
      currentVisibleCommitAckUpperBound: { ...stats(commitLatencies), endpoint: 'Host receipt of an owning browser commit ACK that is current both in the browser and against the host source sequence/compiler revision at receipt. Requires geometric visibility and a visible document at commit. An input-to-commit upper bound, independent of rAF; unavailable without host epoch fields.' },
      sampledVisibleExposureCommit: { ...stats(sampledVisible.map(row => row.ms)), counts: Object.fromEntries(['sampled-visible', 'hidden', 'unknown', 'unobserved'].map(state => [state, exposureRows.filter(row => row.state === state).length])), maxAllowedObservationGapMs: 150, endpoint: 'Strict current visible commit ACK latency restricted to inputs preceded by a visible sample, with no hidden sample through ACK receipt and no observation gap above 150 ms. Sampled exposure cannot exclude brief hidden intervals between observations.', worst: sampledVisible.sort((a, b) => b.ms - a.ms).slice(0, 5) },
      browserObservedCurrentVisibleCommitAckUpperBound: { ...stats(browserCurrentCommitLatencies), endpoint: 'Host receipt of an owning visible browser commit ACK whose epoch was current in the browser at commit. The host may already be ahead; not a fully-current host endpoint.' },
      sourceEpochProgressDuringTyping: progress(epochAdvances), encodedSurfaceProgressDuringTyping: progress(changedAdvances),
      finalInputHasNativeNoOpPatch: noOpHeaders.length > 0,
      sourceEpochCatchUpAtObserverReceiptNote: 'Per-input latency includes the eventual observation after typing stops; the progress windows above exclude deliberate post-typing waits.' };
  });
  const stageStats = Object.fromEntries(['inputToHeaderMs', 'headerToObserverReceiptMs', 'headerToPostMs', 'postToAckRoundTripMs', 'browserReceiveToCommitMs', 'browserCommitToTwoRafMs', 'browserRenderMs', 'nativeExportMs'].map(key => [key, stats(frames.filter(frame => frame.owningSourcePage).map(frame => frame[key]).filter(Number.isFinite))]));
  const scheduler = browser.filter(event => event.varied === 'scheduler');
  return { schema: 1, clocks: { hostTimeOrigin: result.metadata?.hostTimeOrigin ?? null, rule: 'Browser-local durations and host-local/round-trip intervals only. timeOrigin values are provenance, not cross-process clock calibration. No one-way transport or compositor latency is inferred.' }, instrumentation: { timelineEvents: timeline.length, observedFrames: frames.length, commitAcks: commits.length, visibleCommitAcks: commits.filter(commit => commit.visibleAtCommit).length, hostEpochCommitAcks: commits.filter(commit => commit.currentAtHostAck !== null).length, browserSchedulerSamples: scheduler.length }, stages: stageStats, commitStages: Object.fromEntries(['browserReceiveToCommitMs', 'postToAckRoundTripMs', 'headerToAckMs', 'browserRenderMs'].map(key => [key, stats(commits.filter(commit => commit.owningSourcePage).map(commit => commit[key]).filter(Number.isFinite))])),
    slowestCommitRoundTrips: commits.filter(commit => commit.owningSourcePage && commit.postToAckRoundTripMs !== null).sort((a, b) => b.postToAckRoundTripMs - a.postToAckRoundTripMs).slice(0, 15),
    slowestHeaderToObserver: frames.filter(frame => frame.owningSourcePage && frame.headerToObserverReceiptMs !== null).sort((a, b) => b.headerToObserverReceiptMs - a.headerToObserverReceiptMs).slice(0, 15),
    hostLag: timeline.filter(event => event.stage === 'host-lag').sort((a, b) => (b.lag || 0) - (a.lag || 0)).slice(0, 10),
    browserLag: scheduler.filter(event => Number.isFinite(event.lag)).sort((a, b) => b.lag - a.lag).slice(0, 10), phases: phaseReports };
}
module.exports = { summarizeLatency };
if (require.main === module) {
  const input = path.resolve(process.argv[2] || ''), result = summarizeLatency(JSON.parse(fs.readFileSync(input, 'utf8'))), json = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[3]) { fs.writeFileSync(path.resolve(process.argv[3]), json); } else { process.stdout.write(json); }
}
