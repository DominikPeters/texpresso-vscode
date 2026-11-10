// Record the README animations (animated WebP) from the isolated demo window, without
// macOS screen-recording permission: frames and input both go through the Chrome
// DevTools Protocol. The scenes replay the original (v1) README recordings on the
// embedded preview. Each scene needs the demo window opened on its sample:
//
//   sample   scenes
//   smiley   live-preview
//   lipsum   pages, synctex-forward, theme
//   prose    synctex-backward
//   math     magnifier
//
//   TEXPRESSO_DEMO_SAMPLE=<sample> TEXPRESSO_DEMO_ARGS="--remote-debugging-port=9333 --disable-renderer-backgrounding --disable-backgrounding-occluded-windows" node scripts/open-preview-demo.cjs
//   node scripts/record-readme-media.cjs <scene> [--out file.webp] [--width 880] [--quality 75] [--keep-frames]
//   node scripts/record-readme-media.cjs --close     # quit the demo window cleanly (never kill it)
//
// Output goes to artifacts/readme-media/<scene>.webp; copy finished clips to docs/images/.
// The backgrounding flags keep an occluded window painting. Needs python3 with Pillow.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const port = process.env.CDP_PORT || 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHIFT = 8;
let WIDTH = 1095, HEIGHT = 685; // window size in CSS pixels, measured at start

async function connect(kind) {
  const url = kind === 'browser' ? (await (await fetch(`http://localhost:${port}/json/version`)).json()).webSocketDebuggerUrl :
    (await (await fetch(`http://localhost:${port}/json`)).json()).find(t => kind === 'webview' ?
      t.type === 'iframe' && t.url.startsWith('vscode-webview:') : t.type === 'page' && t.url.includes('workbench'))?.webSocketDebuggerUrl;
  if (!url) throw new Error(`No VS Code ${kind} found on the debugging port.`);
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {ws.onopen = resolve; ws.onerror = reject;});
  let id = 0; const pending = new Map();
  ws.onmessage = event => {
    const m = JSON.parse(event.data); const p = pending.get(m.id);
    if (p) {pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);}
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {pending.set(++id, {resolve, reject}); ws.send(JSON.stringify({id, method, params}));});
  return {send, close: () => ws.close()};
}

class Recorder {
  constructor(cdp, dir) {this.cdp = cdp; this.dir = dir; this.top = 0; this.mouse = {x: WIDTH * .3, y: HEIGHT * .9};}
  async start() {
    fs.rmSync(this.dir, {recursive: true, force: true}); fs.mkdirSync(this.dir, {recursive: true});
    this.running = true; this.t0 = Date.now(); this.times = []; this.n = 0;
    // Injected input draws no pointer in screenshots, so the encoder paints it from this path.
    this.track = [{t: 0, ...this.mouse}]; this.clicks = [];
    this.loop = (async () => {
      while (this.running) {
        await this.hold;
        const began = Date.now();
        this.capturing = this.cdp.send('Page.captureScreenshot', {format: 'png', clip: {x: 0, y: this.top * this.zoom, width: WIDTH * this.zoom, height: (HEIGHT - this.top) * this.zoom, scale: .65}});
        const shot = await this.capturing;
        fs.writeFileSync(path.join(this.dir, String(this.n++).padStart(5, '0') + '.png'), Buffer.from(shot.data, 'base64'));
        this.times.push(began - this.t0);
        await sleep(Math.max(0, 80 - (Date.now() - began)));
      }
    })();
  }
  async stop() {this.running = false; await this.loop;}
  // A screenshot taken while a click is dispatched makes the preview iframe drop the click,
  // so clicks wait for the current capture and pause the next one.
  async exclusive(action) {
    let release; this.hold = new Promise(resolve => {release = resolve;});
    try {await this.capturing; await action();} finally {this.hold = undefined; release();}
  }
  async eval(expression) {
    const r = await this.cdp.send('Runtime.evaluate', {expression, returnByValue: true});
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluation failed');
    return r.result.value;
  }
  // Screen position of character `offset` within the first rendered editor line containing `text`.
  async locate(text, offset = 0) {
    const p = await this.eval(`(() => {
      for (const line of document.querySelectorAll('.part.editor .view-lines .view-line')) {
        const at = line.textContent.replace(/\\u00a0/g, ' ').indexOf(${JSON.stringify(text)});
        if (at < 0) continue;
        let k = at + ${offset};
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) {
          if (k <= node.length) {
            const range = document.createRange(); range.setStart(node, k); range.setEnd(node, k);
            const r = range.getBoundingClientRect(); return {x: r.left, y: r.top + r.height / 2};
          }
          k -= node.length;
        }
      }
      return null;
    })()`);
    if (!p) throw new Error(`Could not find "${text}" in the editor.`);
    return p;
  }
  // Never type unless focus is where we expect (by default, the source editor).
  async requireEditorFocus(selector = '.part.editor .monaco-editor') {
    for (let i = 0; i < 10; i++) {
      if (await this.eval(`!!document.activeElement?.closest(${JSON.stringify(selector)})`)) return;
      await sleep(100);
    }
    throw new Error(`Refusing to type: focus is not in ${selector}.`);
  }
  async type(text, delay = 110, selector) {
    await this.requireEditorFocus(selector);
    for (const ch of text) {await this.cdp.send('Input.insertText', {text: ch}); await sleep(delay + Math.random() * delay / 2);}
  }
  async command(name, wait = 800) {
    await this.key('F1', 112); await sleep(400);
    await this.type(name, 10, '.quick-input-widget'); await sleep(400);
    await this.key('Enter', 13); await sleep(wait);
  }
  // Screen position inside the preview webview: the centre of element `id`, or a fraction of its box.
  async locatePreview(id, fx = .5, fy = .5) {
    const outer = await this.eval(`(() => {const r = document.querySelector('iframe.webview')?.getBoundingClientRect(); return r && {x: r.left, y: r.top};})()`);
    if (!outer) throw new Error('No preview webview is open.');
    if (!this.webview) {
      this.webview = await connect('webview');
    }
    const r = await this.webview.send('Runtime.evaluate', {returnByValue: true, expression: `(() => {
      const frame = document.querySelector('iframe'), f = frame.getBoundingClientRect();
      const e = frame.contentDocument.getElementById(${JSON.stringify(id)})?.getBoundingClientRect();
      return e && {x: f.left + e.left + e.width * ${fx}, y: f.top + e.top + e.height * ${fy}};
    })()`});
    const p = r.result.value;
    if (!p) throw new Error(`No #${id} in the preview.`);
    return {x: outer.x + p.x, y: outer.y + p.y};
  }
  async backspace(count = 1, delay = 150) {
    await this.requireEditorFocus();
    for (let i = 0; i < count; i++) {await this.key('Backspace', 8); await sleep(delay);}
  }
  async key(key, vk, modifiers = 0, code = key) {
    for (const type of ['rawKeyDown', 'keyUp']) await this.cdp.send('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode: vk, modifiers});
  }
  note(point) {if (this.running) this.track.push({t: Date.now() - this.t0, x: point.x, y: point.y});}
  async move({x, y}, steps = 20, buttons = 0) {
    const {x: x0, y: y0} = this.mouse;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t * t * (3 - 2 * t), p = {x: x0 + (x - x0) * e, y: y0 + (y - y0) * e};
      const event = {type: 'mouseMoved', ...p, buttons, ...(buttons ? {button: 'left'} : {})};
      // Drags go into the preview iframe, which drops input sent during a screenshot.
      if (buttons) await this.exclusive(() => this.cdp.send('Input.dispatchMouseEvent', event));
      else await this.cdp.send('Input.dispatchMouseEvent', event);
      this.note(p); await sleep(25);
    }
    this.mouse = {x, y};
  }
  async click(point, modifiers = 0) {
    await this.move(point);
    const base = {...point, button: 'left', clickCount: 1, modifiers};
    await this.exclusive(async () => {
      await this.cdp.send('Input.dispatchMouseEvent', {...base, type: 'mousePressed', buttons: 1});
      if (this.running) this.clicks.push({t: Date.now() - this.t0, x: point.x, y: point.y, modifiers});
      await sleep(50);
      await this.cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseReleased'});
    });
  }
  // Press and release separately, for holding the mouse button (the magnifier).
  async press() {
    await this.exclusive(() => this.cdp.send('Input.dispatchMouseEvent', {...this.mouse, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1}));
    if (this.running) this.clicks.push({t: Date.now() - this.t0, ...this.mouse, modifiers: 0});
  }
  async release() {
    await this.exclusive(() => this.cdp.send('Input.dispatchMouseEvent', {...this.mouse, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1}));
  }
  // Click just before character `offset` of `text`.
  async clickAt(text, offset = 0, modifiers = 0) {
    const p = await this.locate(text, offset);
    await this.click({x: p.x + 1, y: p.y}, modifiers);
  }
}

// The original README story.
const scenes = {};
// 1. Live editing (the original smiley animation).
scenes['live-preview'] = {sample: 'smiley', async run(rec) {
  await sleep(1200);
  const sentence = 'This is an example document.';
  await rec.clickAt(sentence, 0); await sleep(500);
  // Select it from the keyboard, word by word (Option/Ctrl+Shift+Right), then the full stop.
  const word = (process.platform === 'darwin' ? 1 : 2) | SHIFT;
  for (let i = 0; i < 5; i++) {await rec.key('ArrowRight', 39, word); await sleep(220);}
  await rec.key('ArrowRight', 39, SHIFT); await sleep(700);
  await rec.type('Hello World!'); await sleep(1500);

  await rec.clickAt('\\draw (0, 0)', 5); await sleep(500);
  await rec.type('[fill]'); await sleep(1300);
  await rec.clickAt('\\draw[fill]', 10); await sleep(400);
  // "fill=y", "fill=ye"... are undefined colours, so the preview briefly reports the TeX error.
  await rec.type('=yellow'); await sleep(1500);

  await rec.clickAt('\\draw (-0.5, -0.3)', 17); await sleep(400);
  await rec.backspace(); await rec.type('2'); await sleep(900);
  await rec.clickAt('(0.5, -0.3);', 10); await sleep(400);
  await rec.backspace(); await rec.type('2'); await sleep(900);
  await rec.move({x: WIDTH * .3, y: HEIGHT * .93}); await sleep(2500);
}};

// 2. Page buttons in the preview toolbar.
scenes.pages = {sample: 'lipsum', async run(rec) {
  await sleep(1000);
  for (const id of ['next', 'next', 'next', 'previous', 'previous', 'previous']) {
    await rec.click(await rec.locatePreview(id)); await sleep(1100);
  }
  await sleep(800);
}};

// 3. Forward SyncTeX: the preview follows the editor cursor.
scenes['synctex-forward'] = {sample: 'lipsum', async run(rec) {
  await sleep(1000);
  for (const target of ['\\lipsum[4-6]', '\\lipsum[7-9]', '\\lipsum[4-6]', '\\lipsum[1-3]']) {
    await rec.clickAt(target, 9); await sleep(1600);
  }
  await sleep(600);
}};

// 4. Inverse SyncTeX: Cmd/Ctrl-click in the preview moves the editor cursor.
// Literal paragraphs (not \lipsum) so the cursor lands in the clicked text.
scenes['synctex-backward'] = {sample: 'prose', async run(rec) {
  await sleep(1000);
  const modifier = process.platform === 'darwin' ? 4 : 2;
  for (const [fx, fy] of [[.45, .62], [.7, .9], [.3, .35]]) {
    const p = await rec.locatePreview('viewport', fx, fy);
    await rec.move(p); await sleep(500);
    await rec.click(p, modifier); await sleep(1900);
  }
}};

// 5. Magnifier: turn it on, hold the mouse button and move the loupe over the details.
scenes.magnifier = {sample: 'math', async run(rec) {
  await sleep(800);
  await rec.click(await rec.locatePreview('magnify')); await sleep(700);
  const at = (fx, fy) => rec.locatePreview('sheet', fx, fy); // fractions of the page
  // The binomial sum sits mid-page; near the edges the loupe is kept inside the preview.
  await rec.move(await at(.50, .27)); await sleep(300);
  await rec.press(); await sleep(700);
  await rec.move(await at(.82, .27), 45, 1); await sleep(800);
  await rec.release(); await sleep(500);
  await rec.key('Escape', 27); await sleep(1000);
}};

// 6. Theme colours: with texpresso.useEditorTheme the preview follows the colour theme.
scenes.theme = {sample: 'lipsum', settings: {'texpresso.useEditorTheme': true}, async run(rec) {
  await sleep(1000);
  // Preferences: Color Theme (Cmd/Ctrl+K Cmd/Ctrl+T); typing its name in the palette can match the marketplace entry.
  const mod = process.platform === 'darwin' ? 4 : 2;
  await rec.key('k', 75, mod, 'KeyK'); await sleep(150); await rec.key('t', 84, mod, 'KeyT'); await sleep(1400);
  const focused = () => rec.eval(`document.querySelector('.quick-input-widget .monaco-list-row.focused .label-name')?.textContent || ''`);
  // Cursor keys preview each theme; Escape returns to the original one.
  for (const [theme, key, vk] of [['Quiet Light', 'ArrowUp', 38], ['Solarized Light', 'ArrowDown', 40], ['Abyss', 'ArrowDown', 40],
    ['Kimbie Dark', 'ArrowDown', 40], ['Monokai', 'ArrowDown', 40]]) {
    for (let i = 0; (await focused()) !== theme; i++) {
      if (i > 25) throw new Error(`Could not reach the ${theme} theme (at ${await focused()}).`);
      await rec.key(key, vk); await sleep(140);
    }
    await sleep(1500);
  }
  await rec.key('Escape', 27); await sleep(1800);
}};

function encode(rec, out, width, quality) {
  const names = fs.readdirSync(rec.dir).filter(f => f.endsWith('.png')).sort();
  const frames = names.map((name, i) => ({file: path.join(rec.dir, name), ms: (rec.times[i + 1] ?? rec.times[i] + 300) - rec.times[i]}));
  const list = path.join(rec.dir, 'frames.json');
  // The pointer is an I-beam over the source text and an arrow elsewhere, as on screen.
  const pointer = {width: WIDTH, top: rec.top, track: rec.track, clicks: rec.clicks, text: rec.textArea, times: rec.times};
  fs.writeFileSync(list, JSON.stringify({frames, pointer}));
  fs.mkdirSync(path.dirname(out), {recursive: true});
  const r = spawnSync('python3', ['-I', path.join(__dirname, 'frames-to-webp.py'), list, out, String(width), String(quality)], {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(r.stderr + '\nNeeds Python 3 with Pillow (pip install pillow).');
  console.log(`${out}: ${(fs.statSync(out).size / 1e6).toFixed(2)} MB; ${r.stderr.trim()}`);
}

(async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  if (args.includes('--close')) { // Ask VS Code to quit cleanly; never kill the window.
    const browser = await connect('browser');
    browser.send('Browser.close').catch(() => {}); await sleep(1500); browser.close(); return;
  }
  const name = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'live-preview';
  const scene = scenes[name];
  if (!scene) throw new Error(`Unknown scene ${name}. Available: ${Object.keys(scenes).join(', ')}`);
  const out = path.resolve(option('--out', `artifacts/readme-media/${name}.webp`));
  const frames = path.resolve('artifacts/readme-media/frames');
  const settingsFile = path.resolve(__dirname, '../artifacts/preview-demo/sample/.vscode/settings.json');
  const originalSettings = fs.readFileSync(settingsFile, 'utf8');
  const cdp = await connect('page');
  const rec = new Recorder(cdp, frames);
  try {
    const title = await rec.eval(`document.title`);
    if (!title.includes(`readme-${scene.sample}.tex`)) {
      throw new Error(`Scene ${name} needs the demo started with TEXPRESSO_DEMO_SAMPLE=${scene.sample} (window: ${title}).`);
    }
    // Electron has no CDP window resizing, and viewport emulation breaks clicks into the preview's
    // iframe. The launcher instead sets window.zoomLevel 1.5, so a 1440x900 window lays out at ~1100x685.
    [WIDTH, HEIGHT] = (await rec.eval('[innerWidth, innerHeight]')).map(Math.floor);
    // Screenshot clips are in unzoomed window pixels; input coordinates are CSS pixels.
    rec.zoom = (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport.zoom || 1;
    if (Math.abs(WIDTH - 1095) > 10 || Math.abs(HEIGHT - 685) > 10) console.warn(`Unusual window size ${WIDTH}x${HEIGHT}; expected ~1095x685.`);
    // Start each take from the sample on disk (the demo never saves it), page 1, top of the file.
    await rec.clickAt('\\begin{document}', 0); await rec.command('File: Revert File'); await sleep(1500);
    await rec.requireEditorFocus(); await rec.key('Home', 36, 4 /* Cmd: top of file */); await sleep(300);
    for (let i = 0; i < 4; i++) {await rec.click(await rec.locatePreview('previous')); await sleep(200);}
    // Leave the magnifier off, whatever an earlier take or test did.
    const pressed = await rec.webview.send('Runtime.evaluate', {returnByValue: true,
      expression: `document.querySelector('iframe').contentDocument.getElementById('magnify').getAttribute('aria-pressed')`});
    if (pressed.result.value === 'true') {await rec.click(await rec.locatePreview('magnify')); await sleep(300);}
    await rec.clickAt('\\begin{document}', 0); await sleep(1500);
    if (scene.settings) {
      fs.writeFileSync(settingsFile, JSON.stringify({...JSON.parse(originalSettings), ...scene.settings}, null, 2));
      await sleep(2500);
    }
    rec.mouse = {x: WIDTH * .3, y: HEIGHT * .93};
    rec.textArea = await rec.eval(`(() => {const r = document.querySelector('.part.editor .monaco-editor .view-lines')?.closest('.monaco-scrollable-element')?.getBoundingClientRect(); return r && {left: r.left, top: r.top, right: r.right, bottom: r.bottom};})()`);
    rec.top = Math.ceil(await rec.eval(`document.querySelector('.part.titlebar')?.getBoundingClientRect().bottom || 0`));
    await rec.start();
    try {await scene.run(rec);} finally {await rec.stop();}
    encode(rec, out, Number(option('--width', 880)), Number(option('--quality', 75)));
    if (!args.includes('--keep-frames')) fs.rmSync(frames, {recursive: true, force: true});
  } finally {
    if (scene.settings) fs.writeFileSync(settingsFile, originalSettings);
    rec.webview?.close(); cdp.close();
  }
})().catch(error => {console.error(error.message); process.exitCode = 1;});
