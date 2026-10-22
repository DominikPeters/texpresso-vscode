#!/usr/bin/env node
/* Background browser harness for production preview UI. The local HTTP bridge
 * replaces VS Code IPC, so its transfer timings are reported separately. */
'use strict';

const http = require('node:http'), fs = require('node:fs'), path = require('node:path');

const {Run, fixtures} = require('../profile-preview.cjs');

const {PreviewController} = require('../../out/preview-controller');

const repo = path.resolve(__dirname, '../..');

const output = path.resolve(process.argv[2] || 'artifacts/profile-browser');

if (fs.existsSync(output) && fs.readdirSync(output).length) {
  throw new Error('Choose a new browser profiling output directory');
}
fs.mkdirSync(output, {
  recursive: true
});

const binary = path.resolve(process.env.TEXPRESSO_BINARY || `native/.bundles/${process.platform}-${process.arch}-preview/bin/texpresso`);

const cases = fixtures(output, [ 10 ], (process.env.TEXPRESSO_PROFILE_KINDS || 'sparse,dense,packed,tikz').split(','));

const jobs = [];

const repeats = Number(process.env.TEXPRESSO_PROFILE_REPEATS || 5);

for (let repeat = 0; repeat < repeats; repeat++) for (const fixture of cases) for (const codec of (repeat % 2 ? [ 'svg', 'png', 'auto' ] : [ 'png', 'svg', 'auto' ]).filter(codec => (process.env.TEXPRESSO_PROFILE_CODECS || 'png,svg').split(',').includes(codec))) jobs.push({
  fixture: fixture.id,
  codec,
  repeat
});

let active, controller, panel, receive, stream, queue = [], frames = new Map, caseIndex = -1;

const results = [];

const dispose = async () => {
  controller?.dispose();
  if (active) {
    await active.dispose();
    active = undefined;
  }
  stream?.end();
  stream = undefined;
  queue = [];
  frames.clear();
};

const event = data => {
  const message = 'data: ' + JSON.stringify(data) + '\n\n';
  if (stream) stream.write(message); else queue.push(message);
};

async function prepare(index) {
  await dispose();
  caseIndex = index;
  const job = jobs[index], fixture = cases.find(f => f.id === job.fixture);
  fs.writeFileSync(fixture.file, fixture.text);
  active = new Run(fixture, binary, job.codec, 1600, output, job.repeat);
  active.onPreview = event => controller?.handle(event);
  active.onState = () => controller?.update();
  panel = {
    visible: true,
    webview: {
      cspSource: 'http://127.0.0.1:9383',
      asWebviewUri: u => '/' + path.basename(u.path),
      onDidReceiveMessage: callback => {
        receive = callback;
      },
      postMessage: message => {
        message.profileSentAt = performance.now();
        if (message.type === 'image') { message.profileProcessingMs = performance.now() - active.controllerImageStart; }
        if (message.bytes) {
          frames.set(message.header.requestId, Buffer.from(message.bytes));
          message = {
            ...message,
            bytes: undefined,
            frame: '/frame/' + message.header.requestId
          };
        }
        event(message);
        return Promise.resolve(true);
      }
    },
    onDidChangeViewState() {},
    onDidDispose() {},
    dispose() {}
  };
  const api = {
    Uri: {
      joinPath: (base, ...parts) => ({
        path: [ base.path, ...parts ].join('/')
      })
    },
    ViewColumn: {
      Beside: 2
    },
    window: {
      createWebviewPanel: () => panel
    }
  };
  controller = new PreviewController(api, {
    path: repo
  }, active.session, () => {}, () => {});
  const image = controller.image;
  controller.image = function(frame) { active.controllerImageStart = performance.now(); return image.call(this, frame); };
  if (process.env.TEXPRESSO_PROFILE_DISABLE_CACHE === '1') { controller.cachePage = () => {}; }
  const instance = panel.webview.html.match(/data-instance="([^"]+)"/)[1];
  const bridge = fs.readFileSync(path.join(__dirname, 'browser-client.js'), 'utf8').replace('__JOB__', JSON.stringify({
    ...job,
    manual: process.env.TEXPRESSO_PROFILE_MANUAL === '1',
    index,
    pages: fixture.pages,
    svgDomDisabled: process.env.TEXPRESSO_PROFILE_DISABLE_SVG_DOM === '1',
    cacheDisabled: process.env.TEXPRESSO_PROFILE_DISABLE_CACHE === '1'
  }));
  return panel.webview.html.replace('default-src \'none\';', 'default-src \'none\'; connect-src \'self\';').replace('</head>', '<link rel="stylesheet" href="/theme.css"></head>').replace(/<script nonce=/, `<script nonce="${instance}">${bridge}<\/script><script nonce=`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:9383');
    const json = async () => {
      let body = '';
      for await (const part of req) body += part;
      return JSON.parse(body);
    };
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8').replace('__JOBS__', JSON.stringify(jobs)).replace('__START_DELAY__', String(Number(process.env.TEXPRESSO_PROFILE_START_DELAY_MS || 2e3))));
    } else if (url.pathname === '/preview') {
      res.setHeader('Content-Type', 'text/html');
      res.end(await prepare(Number(url.searchParams.get('index'))));
    } else if (url.pathname === '/events') {
      stream = res;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      });
      for (const data of queue) res.write(data);
      queue = [];
      req.on('close', () => {
        if (stream === res) stream = undefined;
      });
    } else if (url.pathname.startsWith('/frame/')) {
      const id = Number(url.pathname.split('/').pop()), bytes = frames.get(id);
      if (!bytes) {
        res.writeHead(404);
        res.end();
      } else {
        res.end(bytes);
        frames.delete(id);
      }
    } else if (url.pathname === '/message') {
      const m = await json();
      // Production creates the panel after capability probing. Keep that ordering
      // while including startup in the browser clock: queue all UI messages until
      // features are known, so an early SVG ready cannot be downgraded to PNG.
            const run = active;
      if (!run || m.instance !== controller?.instance) { res.writeHead(409); res.end('Preview session changed'); return; }
      if (!run.startPromise) {
        run.started = performance.now();
        run.startPromise = run.session.start();
      }
      await run.startPromise;
      if (active === run) {
        run.uiMessages ||= [];
        run.uiMessages.push({ type: m.type, id: m.id, cached: m.cached, svg: m.svg, png: m.png, at: performance.now() });
        if (process.env.TEXPRESSO_PROFILE_DISABLE_PNG_PATCH === '1') { m.pngCanvas = false; }
        if ((process.env.TEXPRESSO_PROFILE_DISABLE_SVG_DOM === '1' || process.env.TEXPRESSO_PROFILE_DISABLE_CACHE === '1')) { m.svgDom = false; }
        receive(m);
      }
      res.end('ok');
    } else if (url.pathname === '/edit') {
      const m = await json();
      if (m.mode === 'letter' || m.mode === 'backspace') {
        const match = active.text.match(new RegExp(`(Profiling marker ${String(m.page).padStart(4, '0')} )([a-z]{4,16})(\\.)`));
        if (!match) throw Error('No typing marker');
        const offset = match.index + match[1].length + match[2].length;
        if (m.mode === 'letter') { active.replace(offset, 0, m.letter); }
        else { active.replace(offset - 1, 1, ''); }
      } else if (m.mode === 'font') {
        const offset = active.text.indexOf('\\noindent');
        active.replace(offset, 0, '\\textbf{New font} ');
      } else { active.edit(m.page, !!m.coordinate); }
      res.end('ok');
    } else if (url.pathname === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ completed: results.length, total: jobs.length }));
    } else if (url.pathname === '/result') {
      const result = await json();
      const row = {
        ...result,
        nativeProfile: active.profile,
        uiMessages: active.uiMessages,
        memory: active.memory,
        node: process.memoryUsage()
      };
      results.push(row);
      fs.appendFileSync(path.join(output, 'browser.jsonl'), JSON.stringify(row) + '\n');
      res.end('ok');
    } else if (url.pathname === '/theme.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end('@layer vscode-default{img,video{max-width:100%;max-height:100%}}:root{color-scheme:dark;--vscode-foreground:#ccc;--vscode-editor-background:#1f1f1f;--vscode-input-foreground:#ccc;--vscode-input-background:#313131;--vscode-sideBar-background:#181818;--vscode-descriptionForeground:#999;--vscode-focusBorder:#007fd4;--vscode-font-family:-apple-system,BlinkMacSystemFont,sans-serif;--vscode-font-size:13px}');
    } else if ([ '/preview.js', '/preview-cache.js', '/preview-svg.js', '/preview-png.js', '/preview-lens.js', '/preview-viewport.js', '/preview.css' ].includes(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(fs.readFileSync(path.join(repo, 'media', url.pathname.slice(1))));
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end(error.stack);
  }
});

server.listen(9383, '127.0.0.1', () => console.log('Profile dashboard: http://127.0.0.1:9383'));

for (const signal of [ 'SIGINT', 'SIGTERM' ]) process.once(signal, async () => {
  await dispose();
  server.close();
  process.exit(0);
});
