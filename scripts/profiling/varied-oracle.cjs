#!/usr/bin/env node
/* Opt-in, independent pagination oracle for varied-profile.ts.
 * Usage: node scripts/profiling/varied-oracle.cjs PROFILE.json FRESH_RESULT_DIR
 * Runs installed local XeLaTeX only, with shell escape disabled; no downloads.
 * This is deliberately separate from the interactive benchmark and its CPU slot.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const TIMEOUT_MS = 30000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function normalizeText(text) {
  return text.normalize('NFKC').replace(/\u00ad/g, '')
    .replace(/([A-Za-z])-\s*\r?\n\s*([A-Za-z])/g, '$1$2').replace(/\s+/gu, ' ').trim();
}
function parsePDFText(text) {
  const pages = text.replace(/\r\n/g, '\n').split('\f');
  // Poppler terminates its final page with a form feed. Keep genuinely blank pages.
  if (pages.length > 1 && !pages.at(-1).trim()) { pages.pop(); }
  return pages.map(normalizeText);
}
function parseSynctex(text) {
  const results = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    const pair = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(line);
    if (!pair) { continue; }
    const [, key, value] = pair;
    if (key === 'Page') {
      const page1 = Number(value);
      current = { page1, page: page1 - 1 };
      results.push(current);
    } else if (current && ['x', 'y', 'h', 'v', 'W', 'H'].includes(key)) {
      current[key] = Number(value);
    }
  }
  return results.filter(result => Number.isInteger(result.page1) && result.page1 > 0);
}
function assessProbe(probe, pages, queryResults) {
  const phrase = probe.phrase ?? probe.text ?? probe.query;
  if (typeof phrase !== 'string' || !normalizeText(phrase)) { throw Error('Probe needs a nonempty phrase'); }
  const needle = normalizeText(phrase), matches = [];
  pages.forEach((text, page) => {
    let from = 0, at;
    while ((at = text.indexOf(needle, from)) >= 0) {
      matches.push({ page, page1: page + 1, character: at }); from = at + needle.length;
    }
  });
  const queryPages = [...new Set(queryResults.map(result => result.page))];
  const visiblePages = Array.isArray(probe.snapshot?.shells)
    ? probe.snapshot.shells.filter(shell => shell.visible).map(shell => shell.page) : undefined;
  const checks = {
    uniquePhrase: matches.length === 1,
    nativeMatchesText: matches.length === 1 && matches[0].page === probe.nativePage,
    synctexHasResults: queryResults.length > 0,
    nativeMatchesSynctex: queryPages.includes(probe.nativePage),
    textMatchesSynctex: matches.length === 1 && queryPages.includes(matches[0].page),
    textPageVisible: visiblePages === undefined ? null : matches.length === 1 && visiblePages.includes(matches[0].page)
  };
  return { ...probe, phrase, textMatches: matches, queryResults, queryPages, visiblePages,
    checks, passed: Object.values(checks).every(value => value === true || value === null) };
}
function findTool(name) {
  const directories = [...(process.env.PATH || '').split(path.delimiter), '/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const directory of directories) {
    const file = path.resolve(directory, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) { return file; } } catch { /* Try next installed path. */ }
  }
  throw Error('Required local tool is not installed: ' + name);
}
function main(argv) {
  if (argv.length !== 2) { throw Error('Usage: node scripts/profiling/varied-oracle.cjs PROFILE.json FRESH_RESULT_DIR'); }
  const profileFile = path.resolve(argv[0]), output = path.resolve(argv[1]);
  if (fs.existsSync(output) && fs.readdirSync(output).length) { throw Error('Choose a fresh oracle result directory: ' + output); }
  fs.mkdirSync(output, { recursive: true });
  const report = { created: new Date().toISOString(), profileFile, output, timeoutPerCommandMs: TIMEOUT_MS,
    method: 'Two clean local XeLaTeX passes; standalone SyncTeX query and independent Poppler PDF text pagination. All page fields except page1 are zero-based.',
    commands: [], probes: [], errors: [], passed: false };
  const run = (tool, args, label, cwd) => {
    const started = performance.now();
    const result = cp.spawnSync(tool, args, { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
      env: process.env });
    fs.writeFileSync(path.join(output, label + '.stdout.log'), result.stdout || '');
    fs.writeFileSync(path.join(output, label + '.stderr.log'), result.stderr || '');
    const command = { executable: tool, args, cwd, elapsedMs: performance.now() - started, status: result.status,
      signal: result.signal, error: result.error?.message, stdout: label + '.stdout.log', stderr: label + '.stderr.log' };
    report.commands.push(command);
    if (result.error || result.status !== 0) { throw Error(label + ' failed: ' + (result.error?.message || 'exit ' + result.status + (result.signal ? ', ' + result.signal : ''))); }
    return (result.stdout || '') + (label.endsWith('-version') ? result.stderr || '' : '');
  };
  try {
    const profileBytes = fs.readFileSync(profileFile), profile = JSON.parse(profileBytes);
    report.profileSha256 = sha256(profileBytes); report.profileMetadata = profile.metadata; report.convergenceChecks = profile.convergenceChecks;
    if (profile.error) { throw Error('The benchmark profile failed: ' + profile.error); }
    if (!Array.isArray(profile.probes) || profile.probes.length === 0) { throw Error('Profile has no probes[]; rerun the updated varied-profile harness'); }
    const root = profile.fixture?.root;
    if (typeof root !== 'string') { throw Error('Profile is missing fixture.root'); }
    const fixtureRoot = path.isAbsolute(root) ? root : path.resolve(path.dirname(profileFile), root);
    const editedFile = path.join(fixtureRoot, 'edited.tex'), source = fs.readFileSync(editedFile);
    const work = path.join(output, 'clean'); fs.mkdirSync(work);
    const sourceFile = path.join(work, 'edited.tex'); fs.writeFileSync(sourceFile, source);
    report.source = { original: editedFile, copied: sourceFile, bytes: source.length, sha256: sha256(source) };
    const sources = new Map([['varied.tex', { source, file: sourceFile }]]);
    report.includedSources = [];
    for (const item of profile.editedFiles || []) {
      if (item.relative === 'varied.tex') { continue; }
      // The profile owns only flat local source files, never arbitrary copy paths.
      if (!/^[A-Za-z0-9_-]+\.tex$/.test(item.relative) || !/^[A-Za-z0-9_-]+\.tex$/.test(item.saved)) { throw Error('Invalid included source path'); }
      const original = path.join(fixtureRoot, item.saved), bytes = fs.readFileSync(original), copied = path.join(work, item.relative);
      if (item.sha256 && sha256(bytes) !== item.sha256) { throw Error('Included source hash changed: ' + item.relative); }
      fs.writeFileSync(copied, bytes); sources.set(item.relative, { source: bytes, file: copied });
      report.includedSources.push({ relative: item.relative, original, copied, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const tools = Object.fromEntries(['xelatex', 'synctex', 'pdftotext'].map(name => [name, findTool(name)]));
    report.tools = {};
    for (const [name, executable] of Object.entries(tools)) {
      report.tools[name] = { executable, realpath: fs.realpathSync(executable), sha256: sha256(fs.readFileSync(executable)),
        version: run(executable, [name === 'pdftotext' ? '-v' : name === 'synctex' ? 'help' : '--version'], name + '-version', work).trim() };
    }
    for (let pass = 1; pass <= 2; pass++) {
      run(tools.xelatex, ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-synctex=1', 'edited.tex'], 'xelatex-pass-' + pass, work);
    }
    const pdf = path.join(work, 'edited.pdf'), pdfBytes = fs.readFileSync(pdf);
    report.pdf = { file: pdf, bytes: pdfBytes.length, sha256: sha256(pdfBytes) };
    const text = run(tools.pdftotext, ['-layout', '-enc', 'UTF-8', pdf, '-'], 'pdftotext', work), pages = parsePDFText(text);
    report.pdf.pages = pages.length;
    for (const [index, probe] of profile.probes.entries()) {
      try {
        if (!Number.isInteger(probe.line1) || probe.line1 <= 0 || !Number.isInteger(probe.column) || probe.column < 0 ||
            !Number.isInteger(probe.nativePage) || probe.nativePage < 0) { throw Error('Probe requires line1>0, column>=0 and nativePage>=0 integers'); }
        const owner = sources.get(probe.document || 'varied.tex');
        if (!owner) { throw Error('Probe source file was not preserved: ' + probe.document); }
        const sourceLine = owner.source.toString('utf8').split(/\r?\n/)[probe.line1 - 1];
        if (sourceLine === undefined || probe.column > sourceLine.length) { throw Error('Probe source location is outside final source file'); }
        const query = `${probe.line1}:${probe.column + 1}:${owner.file}`;
        const result = run(tools.synctex, ['view', '-i', query, '-o', pdf], 'synctex-probe-' + index, work);
        const assessed = assessProbe(probe, pages, parseSynctex(result));
        report.probes.push({ ...assessed, sourceLine, synctexInput: query });
        if (!assessed.passed) { report.errors.push('Probe ' + index + ' mismatch: ' + JSON.stringify(assessed.checks)); }
      } catch (error) {
        report.probes.push({ ...probe, passed: false, error: error.message }); report.errors.push('Probe ' + index + ': ' + error.message);
      }
    }
    const rounds = [...new Set(report.probes.map(probe => probe.round || 'initial'))];
    report.rounds = rounds.map(round => ({ round, passed: report.probes.filter(probe => (probe.round || 'initial') === round).every(probe => probe.passed),
      count: report.probes.filter(probe => (probe.round || 'initial') === round).length }));
    report.finalRoundPassed = report.rounds.at(-1)?.passed;
    report.passed = report.probes.length === profile.probes.length && report.errors.length === 0;
  } catch (error) { report.errors.push(error.stack || error.message); }
  finally {
    report.finished = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, finalRoundPassed: report.finalRoundPassed, rounds: report.rounds, probes: report.probes.length, errors: report.errors, result: path.join(output, 'result.json') }, null, 2));
  }
  if (!report.passed) { process.exitCode = 1; }
  return report;
}
module.exports = { normalizeText, parsePDFText, parseSynctex, assessProbe, main };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
