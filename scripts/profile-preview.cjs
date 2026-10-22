#!/usr/bin/env node
/* Real editor-session benchmark. Uses local TeX Live, no network or windows.
 * npm run compile-tests first. Raw observations and fixtures go to --output. */
'use strict';

const fs = require('node:fs'), path = require('node:path');

const os = require('node:os'), cp = require('node:child_process');

const {performance} = require('node:perf_hooks');

const {gzipSync} = require('node:zlib');

const repo = path.resolve(__dirname, '..');

const {TexpressoSession} = require('../out/session');

const {SessionPaths} = require('../out/paths');

const {config, document} = require('../out/test/helpers');

const arg = name => {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? undefined : process.argv[i + 1];
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const percentile = (values, fraction) => [ ...values ].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];

function fixtures(output, pages, kinds) {
  return pages.flatMap(length => kinds.map(kind => {
    const id = `${kind}-${length}`, root = path.join(output, 'fixtures', id);
    fs.mkdirSync(root, {
      recursive: true
    });
    let text = String.raw`\documentclass[a4paper,10pt]{article}
\usepackage[margin=22mm]{geometry}
\usepackage{lipsum}
` + (kind === 'tikz' ? '\\usepackage{tikz}\n' : '') + '\\pagestyle{empty}\n\\begin{document}\n';
    for (let page = 0; page < length; page++) {
      const marker = String(page).padStart(4, '0');
      const markerLine = `\\noindent Profiling marker ${marker} aaaa.\\par\n`;
      const afterFigure = kind === 'tikz' && arg('edit-location') === 'after-figure';
      if (!afterFigure) text += markerLine;
      if (kind === 'tikz' && [ 0, Math.floor((length - 1) / 2), length - 1 ].includes(page)) text += String.raw`\begin{tikzpicture}[x=0.22cm,y=0.22cm]
\foreach \x in {0,...,24} {\foreach \y in {0,...,24} {
\draw[blue!60!black,line width=0.2pt] (\x,\y) circle[radius=0.36];
\draw[red!70!black,line width=0.15pt] (\x,\y) -- +(0.45,0.55);
}}
` + `\\draw[black,thick] (0,0) .. controls (12,1.0) .. (24,24); %COORD-${marker}\n` + '\\end{tikzpicture}\\par\n\\lipsum[1-2]\n'; else text += kind === 'sparse' ? '\\lipsum[1]\n' : kind === 'packed' ? '\\lipsum[1-8]\n' : '\\lipsum[1-5]\n';
      if (afterFigure) text += '\\par\n' + markerLine;
      if (page < length - 1) text += '\\newpage\n';
    }
    text += '\\end{document}\n';
    const file = path.join(root, 'main.tex');
    fs.writeFileSync(file, text);
    return {
      id,
      root,
      file,
      text,
      pages: length,
      kind
    };
  }));
}

class Run {
  constructor(fixture, binary, codec, width, output, repeat) {
    this.output = output;
    this.fixture = fixture;
    this.text = fixture.text;
    this.codec = codec;
    this.width = width;
    this.id = 0;
    this.waiters = new Set;
    this.frames = new Map;
    this.retries = new Set;
    this.profile = [];
    this.rawProfile = '';
    this.memory = [];
    this.operations = [];
    this.trace = '';
    this.repeat = repeat;
    this.main = document(fixture.file, this.text);
    this.main.getText = () => this.text;
    this.session = new TexpressoSession(this.main, {
      ...config,
      command: binary,
      previewLocation: 'editor',
      packageProvider: 'texlive',
      watchDependencies: false
    }, new SessionPaths(fixture.file, false), () => [ this.main ], {
      state: () => {
        this.onState?.();
        this.notify();
      },
      output: () => {},
      synctex: () => {},
      error: error => {
        this.failure = error;
        this.notify();
      },
      debug: text => {
        this.trace = (this.trace + text).slice(-4e4);
        this.rawProfile += text;
        const lines = this.rawProfile.split('\n');
        this.rawProfile = lines.pop();
        for (const line of lines) if (line.startsWith('[profile] ')) this.profile.push({
          ...JSON.parse(line.slice(10)),
          at: performance.now()
        });
      },
      preview: event => {
        if ('header' in event) this.frames.set(event.header.requestId, event); else if (Array.isArray(event)) {
          if (event[0] === 'preview-state') this.state = event;
          if (event[0] === 'preview-retry') this.retries.add(event[1]);
          if (event[0] === 'preview-error') this.failure = new Error(event[2]);
        }
        this.onPreview?.(event);
        this.notify();
      }
    }, undefined, (command, args, options) => {
      const child = cp.spawn(command, args, {
        ...options,
        env: {
          ...process.env,
          TEXPRESSO_PROFILE: '1',
          SDL_VIDEODRIVER: 'dummy'
        }
      });
      this.pid = child.pid;
      if (child.pid && process.platform === 'darwin' && fs.existsSync(path.join(output, 'memory-sampler'))) {
        this.sampler = cp.spawn(path.join(output, 'memory-sampler'), [ String(child.pid) ]);
        let pending = '';
        this.sampler.stdout.on('data', bytes => {
          pending += bytes;
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines) this.memory.push(JSON.parse(line));
        });
        this.sampler.stderr.on('data', () => {});
      }
      return child;
    });
  }
  notify() {
    for (const waiter of [ ...this.waiters ]) waiter();
  }
  until(check, description) {
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = () => {
        if (this.failure || check()) {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          this.failure ? reject(this.failure) : resolve();
        }
      };
      timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timeout: ${description}\n${this.trace.slice(-6e3)}`));
      }, 18e4);
      this.waiters.add(waiter);
      waiter();
    });
  }
  async render(page) {
    for (let attempt = 0; attempt < 100; attempt++) {
      await this.until(() => this.state && this.state[2] === this.session.previewSequence, 'source barrier');
      const id = ++this.id;
      this.session.send([ this.codec === 'svg' ? 'preview-svg' : 'preview-render', id, page, this.width, this.state[1], this.state[2] ]);
      await this.until(() => this.frames.has(id) || this.retries.has(id), 'render');
      if (this.frames.has(id)) {
        const frame = this.frames.get(id);
        this.frames.delete(id);
        return frame;
      }
    }
    throw new Error('Too many obsolete requests');
  }
  async operation(name, page, action) {
    const monoStart = Number(process.hrtime.bigint()) / 1e6;
    const start = name === 'initial' ? this.started : performance.now(), profileIndex = this.profile.length;
    fs.writeFileSync(path.join(this.output, 'live.json'), JSON.stringify({
      pid: this.pid,
      fixture: this.fixture.id,
      codec: this.codec,
      operation: name,
      page
    }));
    if (action) action();
    const frame = await this.render(page), end = performance.now();
    // Pipe-write diagnostic follows the binary frame on a different pipe.
        await delay(5);
    const row = {
      name,
      page,
      ms: end - start,
      monoStart,
      monoEnd: Number(process.hrtime.bigint()) / 1e6,
      request: frame.header.requestId,
      revision: frame.header.revision,
      bytes: frame.bytes.length,
      mime: frame.header.mime,
      width: frame.header.width,
      height: frame.header.height,
      stages: this.profile.slice(profileIndex).filter(p => p.at <= end + 5),
      node: process.memoryUsage()
    };
    this.operations.push(row);
    this.lastFrame = frame;
    return frame;
  }
  edit(page, coordinate = false) {
    const marker = String(page).padStart(4, '0');
    const pattern = coordinate ? new RegExp(`(12,)([12]\\.0)(\\) \\.\\. \\(24,24\\); %COORD-${marker})`) : new RegExp(`(Profiling marker ${marker} )([a-z]{4,16})(\\.)`);
    const match = this.text.match(pattern);
    if (!match) throw new Error('No edit target ' + pattern);
    const offset = match.index + match[1].length, old = match[2], replacement = coordinate ? old === '1.0' ? '2.0' : '1.0' : old === 'aaaa' ? 'bbbb' : 'aaaa';
    this.replace(offset, old.length, replacement);
  }
  replace(offset, length, replacement) {
    const position = offset => {
      const before = this.text.slice(0, offset);
      return { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 };
    };
    const range = { start: position(offset), end: position(offset + length) };
    this.text = this.text.slice(0, offset) + replacement + this.text.slice(offset + length);
    this.session.sync.change(this.main, [{ rangeOffset: offset, rangeLength: length, text: replacement, range }]);
  }

  async dispose() {
    this.sampler?.kill();
    try {
      await this.session.dispose();
    } catch (error) {
      // macOS can deny signal(0) for a group containing only reaped tasks.
      // Ignore that diagnostic only after verifying the owned group is empty.
      const remaining = cp.execFileSync('ps', [ '-eo', 'pid=,pgid=,stat=' ], {
        encoding: 'utf8'
      }).split('\n').filter(line => {
        const fields = line.trim().split(/\s+/);
        return Number(fields[1]) === this.pid && !fields[2]?.startsWith('Z');
      });
      if (error.code !== 'EPERM' || remaining.length) throw error;
      console.warn('Teardown: signal(0) denied after all owned processes exited');
    }
  }
  result() {
    return {
      fixture: this.fixture.id,
      kind: this.fixture.kind,
      pages: this.fixture.pages,
      codec: this.codec,
      repeat: this.repeat,
      pid: this.pid,
      operations: this.operations,
      memory: this.memory,
      profile: this.profile
    };
  }
  async execute() {
    try {
      this.started = performance.now();
      await this.session.start();
      await this.operation('initial', 0);
      for (let i = 0; i < Number(arg('exports') || 5); i++) await this.operation('export-cached-list', 0);
      if (arg('exports-only') === '1') return this.result();
      const last = this.fixture.pages - 1, middle = Math.floor(last / 2);
      if (last) {
        await this.operation('page-next-new', 1);
        await this.operation('page-jump-last-new', last);
        await this.operation('page-middle-compiled', middle);
        await this.operation('page-first-compiled', 0);
        await this.operation('page-last-compiled', last);
      }
      for (const page of [ ...new Set([ last, middle, 0 ]) ]) {
        await this.operation('prepare-edit', page);
        for (let i = 0; i < 3; i++) await this.operation('edit-text', page, () => this.edit(page));
        if (this.fixture.kind === 'tikz' && arg('text-only') !== '1') for (let i = 0; i < 3; i++) await this.operation('edit-coordinate', page, () => this.edit(page, true));
      }
      // Revisit last page after early edit to expose invalidation/recompile cost.
            if (last) await this.operation('page-last-after-early-edit', last);
      return this.result();
    } catch (error) {
      error.message += '\n' + this.trace.slice(-8e3);
      throw error;
    } finally {
      await this.dispose();
    }
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/profile-preview.cjs [--binary PATH] [--output NEW_DIRECTORY] [--pages 1,10,100] [--kinds sparse,dense,packed,tikz] [--repeats 5] [--width 1600] [--edit-location after-figure] [--text-only 1]');
    return;
  }
  const output = path.resolve(arg('output') || `artifacts/profile-${Date.now()}`);
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Choose a new output directory');
  fs.mkdirSync(output, {
    recursive: true
  });
  const binary = path.resolve(arg('binary') || process.env.TEXPRESSO_BINARY || `native/.bundles/${process.platform}-${process.arch}-preview/bin/texpresso`);
  if (process.platform === 'darwin') cp.execFileSync('xcrun', [ 'clang', '-O2', 'scripts/profiling/memory.c', '-o', path.join(output, 'memory-sampler') ], {
    cwd: repo
  });
  const list = fixtures(output, (arg('pages') || '1,10,100').split(',').map(Number), (arg('kinds') || 'sparse,dense,packed,tikz').split(','));
  const repeats = Number(arg('repeats') || 5), width = Number(arg('width') || 1600);
  const metadata = {
    created: (new Date).toISOString(),
    binary,
    platform: process.platform,
    architecture: process.arch,
    cpu: os.cpus()[0]?.model,
    memory: os.totalmem(),
    node: process.version,
    width,
    repeats,
    binarySha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    engineSourceDirty: !!cp.execFileSync('git', [ '-C', 'native/texpresso', 'status', '--porcelain' ], {
      cwd: repo,
      encoding: 'utf8'
    }).trim(),
    engine: cp.execFileSync('git', [ '-C', 'native/texpresso', 'rev-parse', 'HEAD' ], {
      cwd: repo,
      encoding: 'utf8'
    }).trim(),
    extension: cp.execFileSync('git', [ 'rev-parse', 'HEAD' ], {
      cwd: repo,
      encoding: 'utf8'
    }).trim(),
    argv: process.argv.slice(2)
  };
  fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
  const results = [];
  for (let repeat = 0; repeat < repeats; repeat++) for (const fixture of list) for (const codec of repeat % 2 ? [ 'svg', 'png' ] : [ 'png', 'svg' ]) {
    fs.writeFileSync(fixture.file, fixture.text);
    const run = new Run(fixture, binary, codec, width, output, repeat), result = await (running = run).execute();
    running = undefined;
    results.push(result);
    fs.appendFileSync(path.join(output, 'runs.jsonl'), JSON.stringify(result) + '\n');
    if (!repeat) {
      const frame = run.lastFrame;
      fs.writeFileSync(path.join(output, fixture.id + '.' + codec), frame.bytes);
      if (codec === 'svg') fs.writeFileSync(path.join(output, fixture.id + '.svg.gz'), gzipSync(frame.bytes, {
        level: 1
      }));
    }
    const initial = result.operations[0].ms, edit = result.operations.filter(r => r.name === 'edit-text').map(r => r.ms);
    console.log(`${repeat + 1}/${repeats} ${fixture.id} ${codec}: initial ${initial.toFixed(1)}ms, edit p50 ${edit.length ? percentile(edit, .5).toFixed(1) + 'ms' : 'n/a'}`);
  }
  const summary = [];
  for (const fixture of list) for (const codec of [ 'png', 'svg' ]) {
    const selected = results.filter(r => r.fixture === fixture.id && r.codec === codec);
    const names = [ ...new Set(selected.flatMap(r => r.operations.map(o => o.name))) ];
    for (const name of names) {
      const rows = selected.flatMap(r => r.operations.filter(o => o.name === name));
      summary.push({
        fixture: fixture.id,
        codec,
        operation: name,
        n: rows.length,
        p50: percentile(rows.map(r => r.ms), .5),
        p95: percentile(rows.map(r => r.ms), .95),
        bytes: percentile(rows.map(r => r.bytes), .5)
      });
    }
  }
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('Results: ' + output);
}

module.exports = {
  Run,
  fixtures,
  percentile
};

let running;

if (require.main === module) {
  for (const signal of [ 'SIGINT', 'SIGTERM' ]) process.once(signal, async () => {
    try {
      await (running?.dispose());
    } finally {
      process.exit(130);
    }
  });
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
