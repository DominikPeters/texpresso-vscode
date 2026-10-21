import type * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as path from 'path';
import type { TexpressoSession } from './session';
import type { PreviewImage, PreviewImageHeader, PreviewMessage } from './preview-protocol';

// Official VS Code product icons, bundled as SVG to avoid shipping an icon font.
const icons = require('../media/codicons.json') as Record<string, string>;
const icon = (name: string) => icons[name].replace('<svg ', '<svg aria-hidden="true" focusable="false" ');

type RegionRequest = { token: number; bounds: number[]; width: number; purpose: 'region' | 'detail' };

type PreviewEvent = PreviewMessage | PreviewImage | { sourceSequence: number };

export class PreviewController {
  private panel: vscode.WebviewPanel;
  private readonly instance = randomBytes(16).toString('hex');
  private disposed = false;
  private ready = false;
  private dirty = true;
  private page = 0;
  private width = 1200;
  private nextId = 0;
  private inFlight?: { id: number; revision: number; sequence: number; page: number; region?: RegionRequest };
  private region?: RegionRequest;
  private detail?: RegionRequest;
  private decodeTimeout?: NodeJS.Timeout;
  private state?: Extract<PreviewMessage, ['preview-state', ...unknown[]]>;
  private shown?: PreviewImageHeader;
  private target?: { revision: number; sequence: number; page: number; x: number; y: number };

  constructor(api: typeof vscode, extensionUri: vscode.Uri, readonly session: TexpressoSession,
    closed: () => void, private action: (name: 'restart' | 'pause' | 'output') => void) {
    const media = api.Uri.joinPath(extensionUri, 'media');
    this.panel = api.window.createWebviewPanel('texpresso.preview', 'TeXpresso — ' + path.basename(session.document.fileName),
      { viewColumn: api.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [media] });
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(api.Uri.joinPath(media, 'preview.js'));
    const viewportScript = webview.asWebviewUri(api.Uri.joinPath(media, 'preview-viewport.js'));
    const lensScript = webview.asWebviewUri(api.Uri.joinPath(media, 'preview-lens.js'));
    const style = webview.asWebviewUri(api.Uri.joinPath(media, 'preview.css'));
    let visible = this.panel.visible;
    webview.onDidReceiveMessage(value => this.receive(value));
    this.panel.onDidChangeViewState(() => {
      if (visible === this.panel.visible) { return; }
      visible = this.panel.visible;
      this.ready = false; this.release(); this.dirty = true; this.region = undefined; this.detail = undefined; this.target = undefined;
      this.shown = undefined;
      // A restored webview announces ready; a retained live one answers ping.
      if (this.panel.visible) { void this.post({ type: 'ping' }); }
    });
    this.panel.onDidDispose(() => {
      const notify = !this.disposed;
      this.disposed = true; this.release();
      if (notify) { closed(); }
    });
    webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src ${webview.cspSource}; script-src 'nonce-${this.instance}';">
      <link rel="stylesheet" href="${style}"></head><body data-instance="${this.instance}">
      <header aria-label="Preview controls"><div class="navigation">
      <button id="previous" title="Previous page (Page Up)" aria-label="Previous page">${icon('chevron-left')}</button>
      <label>Page <input id="page" type="number" min="1" value="1" aria-label="Page number"></label><span id="total">/ …</span>
      <button id="next" title="Next page (Page Down)" aria-label="Next page">${icon('chevron-right')}</button>
      <button id="zoomOut" title="Zoom out" aria-label="Zoom out">${icon('zoom-out')}</button>
      <select id="zoom" aria-label="Zoom"><option value="width">Fit width</option><option value="page">Fit page</option>
      <option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option>
      <option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option><option value="4">400%</option></select>
      <button id="zoomIn" title="Zoom in" aria-label="Zoom in">${icon('zoom-in')}</button></div>
      <div class="actions"><button id="magnify" title="Magnifier: hold the mouse button on the page (M)" aria-label="Magnifier" aria-pressed="false">${icon('search')}</button>
      <button id="pause" title="Pause compilation" aria-label="Pause compilation"><span id="pauseIcon">${icon('debug-pause')}</span><span id="resumeIcon" hidden>${icon('play')}</span></button>
      <button id="restart" title="Restart preview" aria-label="Restart preview">${icon('refresh')}</button><button id="output" title="Show compiler output" aria-label="Show compiler output">${icon('output')}</button></div></header>
      <div id="status" role="status">Waiting for the first page…</div>
      <main id="viewport" tabindex="0" aria-label="Document preview. Control or Command click to open source.">
      <div id="sheet" hidden><img id="image" alt="Rendered LaTeX page" draggable="false"><img id="detail" alt="" draggable="false" hidden><div id="highlight" hidden></div></div>
      <p id="empty">Your document will appear here.</p></main><div id="lens" hidden><img id="lensBase" alt="" draggable="false"><img id="lensImage" alt="Magnified page region" draggable="false"></div>
      <script nonce="${this.instance}" src="${viewportScript}"></script>
      <script nonce="${this.instance}" src="${lensScript}"></script>
      <script nonce="${this.instance}" src="${script}"></script></body></html>`;
    if (session.previewState) { this.handle(session.previewState); }
  }

  handle(event: PreviewEvent): void {
    if (this.disposed) { return; }
    if ('sourceSequence' in event) {
      this.dirty = true; this.shown = undefined; this.target = undefined; this.region = undefined; this.detail = undefined;
      void this.post({ type: 'invalidate' });
    } else if ('header' in event) {
      this.image(event);
    } else {
      switch (event[0]) {
        case 'preview-state':
          this.state = event;
          if (event[4] && event[3] > 0) { this.page = Math.min(this.page, event[3] - 1); }
          this.status(); this.flush();
          break;
        case 'preview-invalidated':
          this.dirty = true; this.shown = undefined; this.target = undefined; this.region = undefined; this.detail = undefined;
          void this.post({ type: 'invalidate' });
          break;
        case 'preview-retry':
          if (this.inFlight?.id === event[1]) { this.release(); this.dirty = true; this.flush(); }
          break;
        case 'preview-error':
          if (this.inFlight?.id === event[1]) {
            const region = this.inFlight.region;
            this.release(); if (region) { this[region.purpose] = undefined; }
            void this.post({ type: region ? 'region-error' : 'error', text: event[2], purpose: region?.purpose });
            if (region) { this.flush(); }
          }
          break;
        case 'preview-forward':
          if (event[2] !== this.session.previewSequence || event[1] !== this.state?.[1]) { break; }
          this.target = { revision: event[1], sequence: event[2], page: event[3], x: event[4], y: event[5] };
          if (this.page !== event[3] || !this.shown || this.shown.revision !== event[1]) {
            this.page = event[3];
            if (!this.inFlight || this.inFlight.page !== this.page || this.inFlight.revision !== event[1] || this.inFlight.region) {
              this.dirty = true;
            }
            this.flush();
          } else { void this.post({ type: 'target', ...this.target }); this.target = undefined; }
          break;
      }
    }
  }

  update(): void { this.status(); }
  navigate(delta: number): void {
    this.page = Math.max(0, this.page + delta);
    if (this.state?.[4] && this.state[3] > 0) { this.page = Math.min(this.page, this.state[3] - 1); }
    this.dirty = true; this.shown = undefined; this.region = undefined; this.detail = undefined; this.target = undefined; this.status(); this.flush();
  }

  private receive(value: unknown): void {
    if (this.disposed || !value || typeof value !== 'object') { return; }
    const m = value as Record<string, unknown>;
    if (m.instance !== this.instance || typeof m.type !== 'string') { return; }
    switch (m.type) {
      case 'ready':
      case 'viewport':
        if (!Number.isInteger(m.page) || (m.page as number) < 0 || (m.page as number) > 100000 ||
            !Number.isFinite(m.width) || (m.width as number) < 1 || (m.width as number) > 4096) { return; }
        if (this.page !== m.page || this.width !== m.width || m.type === 'ready') { this.dirty = true; }
        if (this.page !== m.page) { this.shown = undefined; this.target = undefined; }
        this.page = m.page as number; this.width = Math.round(m.width as number);
        if (this.state?.[4] && this.state[3] > 0) { this.page = Math.min(this.page, this.state[3] - 1); }
        this.ready = true; this.status(); this.flush();
        break;
      case 'decoded':
        if (m.id === this.inFlight?.id) { this.release(); this.flush(); }
        break;
      case 'decode-error':
        if (m.id === this.inFlight?.id) {
          this.release(); void this.post({ type: 'error', text: 'Could not decode the preview image. Restart the preview to try again.' });
        }
        break;
      case 'region':
      case 'detail': {
        const h = this.shown, b = m.bounds;
        if (this.session.previewRegions && h && m.revision === h.revision && m.sequence === this.session.previewSequence &&
            m.page === h.page && Number.isSafeInteger(m.token) && (m.token as number) >= 0 &&
            Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number' && Number.isFinite(n)) &&
            b[0] >= h.bounds[0] && b[1] >= h.bounds[1] && b[2] <= h.bounds[2] && b[3] <= h.bounds[3] &&
            b[2] > b[0] && b[3] > b[1] && Number.isFinite(m.width) && (m.width as number) >= 1 && (m.width as number) <= (m.type === 'detail' ? 4096 : 1024)) {
          this[m.type] = { token: m.token as number, bounds: b, width: Math.round(m.width as number), purpose: m.type };
          this.flush();
        }
        break;
      }
      case 'cancel-region': this.region = undefined; break;
      case 'cancel-detail': this.detail = undefined; break;
      case 'inverse': {
        const h = this.shown;
        if (h && m.revision === h.revision && m.sequence === this.session.previewSequence && m.page === h.page &&
            typeof m.x === 'number' && typeof m.y === 'number' && Number.isFinite(m.x) && Number.isFinite(m.y) &&
            m.x >= h.bounds[0] && m.x <= h.bounds[2] && m.y >= h.bounds[1] && m.y <= h.bounds[3]) {
          this.session.send(['preview-inverse', h.revision, h.sequence, h.page, m.x, m.y]);
        }
        break;
      }
      case 'restart': case 'pause': case 'output': this.action(m.type); break;
    }
  }

  private flush(): void {
    if (!this.ready || !this.panel.visible || this.disposed || this.inFlight ||
        !this.state || this.state[2] !== this.session.previewSequence || this.session.state !== 'running') { return; }
    // Page updates take priority; interactive magnification precedes background detail.
    // All requests share one frame/decode credit.
    if (this.dirty) {
      this.dirty = false; this.region = undefined; this.detail = undefined;
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: this.page };
      this.session.send(['preview-render', this.nextId, this.page, this.width, this.state[1], this.state[2]]);
    } else if ((this.region || this.detail) && this.shown) {
      const region = (this.region || this.detail)!; this[region.purpose] = undefined;
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: this.page, region };
      const b = region.bounds;
      this.session.send(['preview-region', this.nextId, this.page, region.width, this.state[1], this.state[2], b[0], b[1], b[2], b[3]]);
    }
  }

  private image(frame: PreviewImage): void {
    const h = frame.header, request = this.inFlight;
    if (!request || h.requestId !== request.id) { return; }
    if (!this.ready || !this.panel.visible || h.sequence !== this.session.previewSequence || h.revision !== this.state?.[1] ||
        request.page !== this.page || h.page !== request.page || this.dirty) {
      this.release(); this.dirty = true; this.flush(); return;
    }
    this.page = h.page;
    if (!request.region) { this.shown = h; }
    // Buffer.buffer may expose a larger pooled allocation. Send only image bytes.
    const bytes = new Uint8Array(frame.bytes).buffer;
    this.decodeTimeout = setTimeout(() => {
      this.release(); this.ready = false;
      void this.post({ type: 'error', text: 'The preview did not acknowledge its image. Reopen the preview tab or restart.' });
    }, 10000);
    const target = this.target?.page === h.page && this.target.revision === h.revision &&
      this.target.sequence === h.sequence ? this.target : undefined;
    if (target && !request.region) { this.target = undefined; }
    void this.post(request.region ? { type: request.region.purpose, header: h, bytes, token: request.region.token } :
      { type: 'image', header: h, bytes, target })
      .then(delivered => { if (!delivered && this.inFlight?.id === h.requestId) { this.release(); this.ready = false; this.dirty = true; } });
    this.status();
  }

  private status(): void {
    void this.post({ type: 'state', page: this.page, count: this.state?.[3] || 0, complete: !!this.state?.[4],
      regions: this.session.previewRegions, paused: this.session.paused, phase: this.session.state });
  }
  private post(message: object): Promise<boolean> {
    return this.disposed ? Promise.resolve(false) : Promise.resolve(
      this.panel.webview.postMessage({ instance: this.instance, ...message })).catch(() => false);
  }
  private release(): void { clearTimeout(this.decodeTimeout); this.decodeTimeout = undefined; this.inFlight = undefined; }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.release(); this.panel.dispose(); } }
}
