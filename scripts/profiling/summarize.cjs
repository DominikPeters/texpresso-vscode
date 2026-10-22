#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path');

const {percentile} = require('../profile-preview.cjs');

const q = values => ({
  n: values.length,
  p50: percentile(values, .5),
  p95: percentile(values, .95)
});

function summarize(directory) {
  const runs = fs.readFileSync(path.join(directory, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const groups = new Map;
  for (const run of runs) {
    const key = run.fixture + '/' + run.codec;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const result = [];
  for (const [key, runs] of groups) {
    const operations = {};
    for (const name of new Set(runs.flatMap(r => r.operations.map(o => o.name)))) {
      const rows = runs.flatMap(r => r.operations.filter(o => o.name === name));
      const stages = {};
      for (const stage of new Set(rows.flatMap(o => o.stages.map(s => s.stage)))) stages[stage] = q(rows.flatMap(o => o.stages.filter(s => s.stage === stage).map(s => s.ms)));
      const pages = {};
      for (const page of new Set(rows.map(o => o.page))) pages[page] = q(rows.filter(o => o.page === page).map(o => o.ms));
      operations[name] = {
        ...q(rows.map(o => o.ms)),
        bytes: q(rows.map(o => o.bytes)),
        pages,
        stages
      };
    }
    const peaks = runs.map(r => {
      const samples = r.memory.filter(s => s.tasks.length);
      const peak = pick => Math.max(0, ...samples.map(pick));
      return {
        viewerFootprint: peak(s => s.tasks.find(t => t.pid === r.pid)?.footprint || 0),
        viewerRss: peak(s => s.tasks.find(t => t.pid === r.pid)?.rss || 0),
        taskFootprintSum: peak(s => s.tasks.reduce((n, t) => n + t.footprint, 0)),
        taskRssSum: peak(s => s.tasks.reduce((n, t) => n + t.rss, 0)),
        taskCount: peak(s => s.tasks.length),
        viewerLifetimeFootprint: peak(s => s.tasks.find(t => t.pid === r.pid)?.peakFootprint || 0)
      };
    });
    const memory = {};
    for (const name of Object.keys(peaks[0])) if (peaks.some(p => p[name] > 0)) memory[name] = q(peaks.map(p => p[name]));
    const [fixture, codec] = key.split('/');
    result.push({
      fixture,
      codec,
      operations,
      memory
    });
  }
  return result;
}

if (require.main === module) {
  const directories = process.argv.slice(2);
  console.log(JSON.stringify(directories.map(directory => ({
    directory: path.basename(directory),
    results: summarize(directory)
  })), null, 2));
}

module.exports = {
  summarize,
  q
};
