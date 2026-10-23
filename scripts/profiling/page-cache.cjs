#!/usr/bin/env node
'use strict';
// Opt-in native request-to-frame cache comparison. Local TeX Live; no downloads
// or native preview windows. Compile TypeScript tests before running this file.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { createHash } = require('node:crypto'), { performance } = require('node:perf_hooks');
const { Run } = require('../profile-preview.cjs');
const repo = path.resolve(__dirname, '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const fixtureText = String.raw`\documentclass{article}
\usepackage{lipsum,tikz}
\pagestyle{empty}
\begin{document}
First page.\lipsum[1-2]
\begin{tikzpicture}\draw[blue] (0,0) -- (3,1);\end{tikzpicture}
\newpage
Second page.\lipsum[3-4]
\begin{tikzpicture}\draw[red] (0,0) .. controls (1,3) and (2,-1) .. (3,1);\end{tikzpicture}
\newpage Third page.\end{document}
`;

function options(args) {
  const value = { baseline: process.env.TEXPRESSO_CACHE_BASELINE, candidate: process.env.TEXPRESSO_CACHE_CANDIDATE,
    output: process.env.TEXPRESSO_CACHE_OUTPUT, width: 1600, repeats: 8, formats: 'png,svg' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !Object.hasOwn(value, key) || i + 1 >= args.length) { throw Error('Unknown/missing option: ' + args[i]); }
    value[key] = args[++i];
  }
  for (const key of ['baseline', 'candidate', 'output']) {
    if (!value[key]) { throw Error('Required option --' + key); }
    value[key] = path.resolve(value[key]);
  }
  for (const [key, max] of [['width', 4096], ['repeats', 50]]) {
    value[key] = Number(value[key]);
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > max) { throw Error('Invalid --' + key); }
  }
  value.formats = value.formats.split(',');
  if (!value.formats.length || value.formats.some(format => !['png', 'svg'].includes(format)) || new Set(value.formats).size !== value.formats.length) { throw Error('Choose --formats png,svg, png or svg'); }
  if (fs.realpathSync(value.baseline) === fs.realpathSync(value.candidate)) { throw Error('Baseline and candidate must be different executables'); }
  return value;
}
function residentBytes(pid) {
  if (!['darwin', 'linux'].includes(process.platform)) { return null; }
  try {
    const kb = Number(cp.execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch { return null; }
}
async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/profiling/page-cache.cjs --baseline BINARY --candidate BINARY --output FRESH_DIR [--width 1600] [--repeats 8] [--formats png,svg]');
    console.log('Paths may also use TEXPRESSO_CACHE_BASELINE, TEXPRESSO_CACHE_CANDIDATE and TEXPRESSO_CACHE_OUTPUT.');
    return;
  }
  const config = options(args), output = config.output;
  if (fs.existsSync(output) && fs.readdirSync(output).length) { throw Error('Choose a fresh --output directory'); }
  fs.mkdirSync(output, { recursive: true });
  const file = path.join(output, 'main.tex'); fs.writeFileSync(file, fixtureText);
  const report = { created: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    scriptSha256: digest(fs.readFileSync(__filename)), config, endpoint: 'Native request through complete stdout frame in production TexpressoSession; excludes VS Code/browser paint',
    rssScope: 'Frontend ps RSS snapshots in bytes; excludes workers, compiler-checkpoint children and browser/GPU memory', runs: [] };
  const hashes = new Map();
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  try {
    for (const codec of config.formats) {
      for (const variant of ['baseline', 'candidate']) {
        const binary = config[variant], run = new Run({ file, text: fixtureText, id: 'cache-comparison' }, binary, codec, config.width, output, 0);
        try {
          await run.session.start(); await run.render(0); const reference = await run.render(1);
          const imageHash = digest(reference.bytes), expected = hashes.get(codec);
          if (expected && imageHash !== expected) { throw Error(codec + ': baseline/candidate bytes differ'); }
          hashes.set(codec, imageHash);
          const before = residentBytes(run.pid), samples = [], timings = [];
          for (let i = 0; i < config.repeats; i++) {
            let start = performance.now(), frame = await run.render(1);
            timings.push({ operation: 'warm', ms: performance.now() - start, request: frame.header.requestId });
            if (digest(frame.bytes) !== imageHash) { throw Error('Warm frame bytes differ'); }
            await run.render(0); start = performance.now(); frame = await run.render(1);
            timings.push({ operation: 'return', ms: performance.now() - start, request: frame.header.requestId });
            if (digest(frame.bytes) !== imageHash) { throw Error('Return frame bytes differ'); }
            samples.push(residentBytes(run.pid));
          }
          // stderr stage records can arrive just after the binary stdout frame.
          await new Promise(resolve => setTimeout(resolve, 10));
          const worker = path.join(path.dirname(binary), 'texpresso-xetex' + (binary.endsWith('.exe') ? '.exe' : ''));
          const rss = [before, ...samples].filter(value => value !== null);
          const item = { codec, variant, binary, binarySha256: digest(fs.readFileSync(binary)), workerSha256: fs.existsSync(worker) ? digest(fs.readFileSync(worker)) : null,
            sourceSha256: digest(Buffer.from(fixtureText)), imageSha256: imageHash, width: config.width, timings,
            nativeRss: { unit: 'bytes', before, samples, peak: rss.length ? Math.max(...rss) : null },
            medians: Object.fromEntries(['warm', 'return'].map(operation => [operation, median(timings.filter(t => t.operation === operation).map(t => t.ms))])),
            profile: run.profile, cacheHits: run.profile.filter(p => p.stage.includes('cache-hit')).length,
            retainedListBytes: Math.max(0, ...run.profile.filter(p => p.stage.startsWith('page-list-cache-')).map(p => p.bytes)),
            retainedExportBytes: Math.max(0, ...run.profile.filter(p => p.stage.startsWith('page-export-cache-')).map(p => p.bytes)) };
          report.runs.push(item); save();
          fs.writeFileSync(path.join(output, `${variant}-${codec}.json`), JSON.stringify(item, null, 2));
          console.log(JSON.stringify({ variant, codec, medians: item.medians, cacheHits: item.cacheHits }));
        } catch (error) {
          report.failedRun = { variant, codec }; throw error;
        } finally {
          fs.writeFileSync(path.join(output, `${variant}-${codec}.log`), run.trace);
          await run.dispose();
        }
      }
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack || error.message; throw error; }
  finally { report.finished = new Date().toISOString(); save(); }
}
if (require.main === module) { main(process.argv.slice(2)).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; }); }
module.exports = { options, residentBytes, main };
