#!/usr/bin/env node
'use strict';
// Bounded, open-loop native companion to the varied-document VS Code run.
// Uses production sessions/SyncTeX and local TeX Live; no native windows.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), { createHash } = require('node:crypto'), { performance } = require('node:perf_hooks');
const { Run } = require('../profile-preview.cjs');
const { createVariedFixture, sourceLocation, resolveInput, sustainedPlans } = require('./varied-fixture.cjs');
const { SourceFollow } = require('../../out/source-follow');
const arg = (name, fallback) => { const at = process.argv.indexOf('--' + name); return at < 0 ? fallback : process.argv[at + 1]; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const output = path.resolve(arg('output', 'artifacts/profile-varied-native'));
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw Error('Choose a fresh --output directory');
  fs.mkdirSync(output, { recursive: true });
  const binary = path.resolve(arg('binary', process.env.TEXPRESSO_BINARY || 'native/.bundles/darwin-arm64-preview/bin/texpresso'));
  const manifestPath = path.resolve(path.dirname(binary), '../build-manifest.json');
  const engineRevision = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).engineRevision :
    cp.execFileSync('git', ['-C', path.resolve(__dirname, '../../native/texpresso'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const binarySha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const engineSourceDirty = !!cp.execFileSync('git', ['-C', path.resolve(__dirname, '../../native/texpresso'), 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  const fixture = createVariedFixture(output, { targetPages: Number(arg('pages', 30)) });
  const codec = arg('format', 'svg'), interval = Number(arg('interval', 100)), intervalOverride = process.argv.includes('--interval'), follow = new SourceFollow();
  const run = new Run(fixture, binary, codec, 1100, output, 0), started = performance.now();
  run.session.autoRerun = true; run.session.configuration.autoRerun = true;
  const stream = fs.createWriteStream(path.join(output, 'trace.log'));
  const stages = [], messages = [], images = [], inputs = [], phases = [], diagnostics = [];
  const pendingLimit = 20000; let debugPending = '', pending, dirty = false, epochError = '', focus = 'early', phase;
  let currentFrame, selectedTarget, desiredPage = 0, editing = false, sourceVersion = 0, workerLaunches = 0, workerKills = 0, lastDiagnostic = '';
  const now = () => performance.now() - started;
  const originalDebug = run.session.events.debug;
  run.session.events.debug = text => {
    stream.write(text); originalDebug(text); debugPending += text;
    const lines = debugPending.split('\n'); debugPending = lines.pop();
    for (const line of lines) {
      if (line.includes('[process] launched pid')) workerLaunches++;
      if (line.includes('[kill]')) workerKills++;
      const at = line.indexOf('[profile] ');
      if (at >= 0) { try { stages.push({ at: now(), phase: phase?.id, ...JSON.parse(line.slice(at + 10)) }); } catch {} }
      if (/\[rerun\]|\[kill\]|\[process\]|\[prepare-edit\]|\[change\]|\[synctex forward\]/.test(line)) {
        if (diagnostics.length < pendingLimit) diagnostics.push({ at: now(), phase: phase?.id, text: line });
      }
    }
  };
  run.session.events.output = (target, text) => {
    if (target === 'out' && text.includes('!') && text !== lastDiagnostic) {
      lastDiagnostic = text; diagnostics.push({ at: now(), phase: phase?.id, compilerError: text.slice(-2000) });
    }
  };
  const requestFollow = () => {
    if (!run.state || run.state[2] !== run.session.previewSequence) return;
    const selection = sourceLocation(run.text, focus), line = editing ? selection.line : selection.visibleLine, revision = run.state[1], sequence = run.session.previewSequence;
    if (follow.request({ session: run.session, document: run.main.fileName, version: sourceVersion, line, sequence, revision })) {
      messages.push({ at: now(), phase: phase?.id, sourceFollow: { focus, line, sequence, revision } });
      run.session.sync.syncForward(run.main, line);
    }
  };
  run.session.events.rendered = requestFollow;
  const pump = () => {
    if (pending || !dirty || !run.state || run.state[2] !== run.session.previewSequence || run.failure) return;
    const [ , revision, sequence ] = run.state;
    if (epochError === revision + '/' + sequence) return;
    const request = ++run.id, page = desiredPage;
    pending = { request, revision, sequence, at: now(), phase: phase?.id };
    dirty = false;
    run.session.send([codec === 'svg' ? 'preview-svg' : 'preview-render', request, page, 1100, revision, sequence]);
  };
  run.onPreview = event => {
    if (Array.isArray(event)) {
      messages.push({ at: now(), phase: phase?.id, event });
      if (event[0] === 'preview-invalidated') { dirty = true; }
      if (event[0] === 'preview-forward' && event[2] === run.session.previewSequence && event[1] === run.state?.[1]) {
        selectedTarget = { revision: event[1], sequence: event[2], page: event[3] }; desiredPage = event[3]; dirty = true;
      }
      if (event[0] === 'preview-error') { run.failure = undefined; }
      if ((event[0] === 'preview-retry' || event[0] === 'preview-error') && pending?.request === event[1]) {
        const old = pending; pending = undefined;
        if (event[0] === 'preview-error') {
          epochError = old.revision + '/' + old.sequence;
          // Incomplete LaTeX is an expected editing state. The next input/pass
          // must recover; the final valid source still has a bounded deadline.
          run.failure = undefined;
        } else dirty = true;
      }
    } else if ('header' in event) {
      const h = event.header; run.frames.delete(h.requestId);
      images.push({ at: now(), phase: phase?.id, ...h, stale: h.sequence !== run.session.previewSequence });
      if (h.requestId === pending?.request) pending = undefined;
      if (h.sequence === run.session.previewSequence) currentFrame = { ...h, at: now() };
    }
    queueMicrotask(pump);
  };
  const until = async (condition, label, timeout = 20000) => {
    const end = performance.now() + timeout;
    while (!condition()) {
      if (run.failure || performance.now() > end) throw run.failure || Error(label + '\n' + run.trace.slice(-4000));
      await delay(10);
    }
  };
  const settle = async (label, requireSelected = false) => {
    dirty = true; pump();
    await until(() => {
      if (requireSelected) requestFollow();
      return currentFrame?.sequence === run.session.previewSequence && currentFrame.page === desiredPage && !pending &&
        (!requireSelected || (selectedTarget?.sequence === run.session.previewSequence && currentFrame.revision === selectedTarget.revision && currentFrame.page === selectedTarget.page));
    }, label);
  };
  let outcome;
  try {
    await run.session.start(); dirty = true; pump(); await settle('initial render');
    const selected = arg('plans', '').split(',').filter(Boolean);
    for (const plan of sustainedPlans().filter(p => !selected.length || selected.includes(p.id))) {
      focus = plan.anchor; phase = { id: plan.id, anchor: plan.anchor, started: now(), inputs: plan.inputs.length, firstSequence: run.session.previewSequence + 1 };
      phases.push(phase); editing = false; selectedTarget = undefined; follow.invalidate(run.session); requestFollow();
      await settle('navigate to ' + plan.anchor, true);
      const launchStart = workerLaunches, killStart = workerKills;
      const cadence = intervalOverride ? interval : plan.intervalMs, begin = performance.now();
      for (let index = 0; index < plan.inputs.length; ++index) {
        const target = begin + index * cadence; await delay(Math.max(0, target - performance.now()));
        editing = true; const input = plan.inputs[index], edit = resolveInput(run.text, input), appliedAt = now();
        run.replace(edit.offset, edit.length, edit.text); sourceVersion++; dirty = true; epochError = '';
        inputs.push({ phase: plan.id, index, at: appliedAt, scheduledAt: target - started,
          sequence: run.session.previewSequence, length: edit.length, text: edit.text, incomplete: !!input.temporarilyIncomplete });
        pump();
        for (const nav of plan.navigation || []) if (nav.afterInput === index + 1) {
          focus = nav.anchor; follow.invalidate(run.session); requestFollow();
          messages.push({ at: now(), phase: plan.id, navigation: nav });
        }
      }
      await settle('final valid source after ' + plan.id, true);
      phase.finished = now(); phase.lastSequence = run.session.previewSequence;
      phase.workerLaunches = workerLaunches - launchStart; phase.workerKills = workerKills - killStart;
      phase.finalPage = currentFrame.page;
      fs.writeFileSync(path.join(fixture.root, 'source-after-' + plan.id + '.tex'), run.text);
    }
    outcome = 'passed';
  } catch (error) { outcome = { error: String(error), trace: run.trace.slice(-6000) }; }
  finally {
    await run.dispose(); await new Promise(resolve => stream.end(resolve));
    const rows = inputs.map(input => {
      const matches = images.filter(h => !h.stale && h.sequence === input.sequence && h.at >= input.at);
      const targets = messages.filter(m => m.event?.[0] === 'preview-forward' && m.event[2] === input.sequence);
      const owning = matches.filter(h => targets.some(t => t.event[1] === h.revision && t.event[3] === h.page));
      return { ...input, schedulerLateMs: Math.max(0, input.at - input.scheduledAt),
        nativeSelectedPageFrameMs: owning.length ? owning[0].at - input.at : null,
        firstFrameMs: matches.length ? matches[0].at - input.at : null,
        finalFrameMs: matches.length ? matches.at(-1).at - input.at : null,
        sourceSequenceCoalesced: !matches.length };
    });
    fs.writeFileSync(path.join(output, 'native.json'), JSON.stringify({ schema: 1, endpoint: 'Source apply to native binary frame receipt (no browser); selected-page metrics require a matching resolved native SyncTeX target', binary, engineRevision, binarySha256, engineSourceDirty,
      fixture: { ...fixture, text: undefined }, codec, intervalMsOverride: intervalOverride ? interval : null, outcome, phases, inputs: rows,
      workerLaunches, workerKills, images, messages, stages, diagnostics }, null, 2));
    console.log(JSON.stringify({ outcome, phases, workerLaunches, workerKills, inputs: inputs.length, images: images.length }));
  }
  if (outcome !== 'passed') process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
