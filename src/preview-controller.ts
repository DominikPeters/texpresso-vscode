import type * as vscode from 'vscode';
import { createHash, randomBytes } from 'crypto';
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
  private format: 'png' | 'svg' = 'png';
  private svgDecodeFailed = false;
  private destination?: string;
  private nextId = 0;
  private inFlight?: { id: number; revision: number; sequence: number; page: number; region?: RegionRequest; key?: string; cached?: boolean };
  // Encoded pages are valid only within an engine revision and source barrier.
  private pages = new Map<string, PreviewImage>();
  private pageBytes = 0;
  private decodedImages = new Set<string>();
  private enginePage?: { revision: number; sequence: number; page: number };
  private inverse?: { revision: number; sequence: number; page: number; x: number; y: number };
  private forceNative = false;
  private region?: RegionRequest;
  private detail?: RegionRequest;
  private decodeTimeout?: NodeJS.Timeout;
  private state?: Extract<PreviewMessage, ['preview-state', ...unknown[]]>;
  private shown?: PreviewImageHeader;
  private target?: { revision: number; sequence: number; page: number; x: number; y: number };

  constructor(private api: typeof vscode, extensionUri: vscode.Uri, readonly session: TexpressoSession,
    closed: () => void, private action: (name: 'restart' | 'pause' | 'output') => void) {
    const media = api.Uri.joinPath(extensionUri, 'media');
    this.panel = api.window.createWebviewPanel('texpresso.preview', 'TeXpresso — ' + path.basename(session.document.fileName),
      { viewColumn: api.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [media] });
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(api.Uri.joinPath(media, 'preview.js'));
    const viewportScript = webview.asWebviewUri(api.Uri.joinPath(media, 'preview-viewport.js'));
    const cacheScript = webview.asWebviewUri(api.Uri.joinPath(media, 'preview-cache.js'));
    const lensScript = webview.asWebviewUri(api.Uri.joinPath(media, 'preview-lens.js'));
    const style = webview.asWebviewUri(api.Uri.joinPath(media, 'preview.css'));
    let visible = this.panel.visible;
    webview.onDidReceiveMessage(value => this.receive(value));
    this.panel.onDidChangeViewState(() => {
      if (visible === this.panel.visible) { return; }
      visible = this.panel.visible;
      this.ready = false; this.release(); this.dirty = true; this.region = undefined; this.detail = undefined; this.target = undefined;
      this.shown = undefined; this.destination = undefined; this.decodedImages.clear(); this.inverse = undefined; this.forceNative = false;
      // A restored webview announces ready; a retained live one answers ping.
      if (this.panel.visible) { void this.post({ type: 'ping' }); }
    });
    this.panel.onDidDispose(() => {
      const notify = !this.disposed;
      this.disposed = true; this.release(); this.clearPages(); this.decodedImages.clear();
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
      <select id="format" aria-label="Rendering format" title="Rendering format"><option value="png">PNG</option><option value="svg">SVG</option></select>
      <button id="zoomIn" title="Zoom in" aria-label="Zoom in">${icon('zoom-in')}</button></div>
      <div class="actions"><button id="magnify" title="Magnifier: hold the mouse button on the page (M)" aria-label="Magnifier" aria-pressed="false">${icon('search')}</button>
      <button id="pause" title="Pause compilation" aria-label="Pause compilation"><span id="pauseIcon">${icon('debug-pause')}</span><span id="resumeIcon" hidden>${icon('play')}</span></button>
      <button id="restart" title="Restart preview" aria-label="Restart preview">${icon('refresh')}</button><button id="output" title="Show compiler output" aria-label="Show compiler output">${icon('output')}</button></div></header>
      <div id="status" role="status">Waiting for the first page…</div>
      <main id="viewport" tabindex="0" aria-label="Document preview. Control or Command click to open source.">
      <div id="sheet" hidden><img id="image" alt="Rendered LaTeX page" draggable="false"><img id="detail" alt="" draggable="false" hidden><div id="links"></div><div id="highlight" hidden></div></div>
      <p id="empty">Your document will appear here.</p></main><div id="lens" hidden><img id="lensBase" alt="" draggable="false"><img id="lensImage" alt="Magnified page region" draggable="false"></div>
      <script nonce="${this.instance}" src="${viewportScript}"></script>
      <script nonce="${this.instance}" src="${lensScript}"></script>
      <script nonce="${this.instance}" src="${cacheScript}"></script>
      <script nonce="${this.instance}" src="${script}"></script></body></html>`;
    if (session.previewState) { this.handle(session.previewState); }
  }

  handle(event: PreviewEvent): void {
    if (this.disposed) { return; }
    if ('sourceSequence' in event) {
      this.clearPages(); this.enginePage = undefined; this.inverse = undefined;
      this.dirty = true; this.shown = undefined; this.target = undefined; this.region = undefined; this.detail = undefined; this.destination = undefined; this.svgDecodeFailed = false;
      void this.post({ type: 'invalidate' });
    } else if ('header' in event) {
      this.image(event);
    } else {
      switch (event[0]) {
        case 'preview-state':
          if (this.state && (this.state[1] !== event[1] || this.state[2] !== event[2])) { this.clearPages(); this.enginePage = undefined; }
          if (this.enginePage?.page !== event[5]) { this.enginePage = undefined; }
          this.state = event;
          if (event[4] && event[3] > 0) { this.page = Math.min(this.page, event[3] - 1); }
          this.status(); this.flush();
          break;
        case 'preview-invalidated':
          this.clearPages(); this.enginePage = undefined; this.inverse = undefined;
          this.dirty = true; this.shown = undefined; this.target = undefined; this.region = undefined; this.detail = undefined; this.destination = undefined; this.svgDecodeFailed = false;
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
        case 'preview-destination':
          if (event[1] !== this.state?.[1] || event[2] !== this.session.previewSequence || event[3] !== this.destination) { break; }
          if (event[4] < 0) { this.destination = undefined; void this.post({ type: 'link-error', text: 'This link target is not available in the document yet.' }); }
          else { if (this.page !== event[4]) { this.svgDecodeFailed = false; } this.page = event[4]; this.shown = undefined; this.target = undefined; this.dirty = true; this.status(); this.flush(); }
          break;
        case 'preview-forward':
          this.enginePage = undefined;
          if (event[2] !== this.session.previewSequence || event[1] !== this.state?.[1]) { break; }
          this.target = { revision: event[1], sequence: event[2], page: event[3], x: event[4], y: event[5] };
          if (this.page !== event[3] || !this.shown || this.shown.revision !== event[1]) {
            if (this.page !== event[3]) { this.svgDecodeFailed = false; }
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
    this.svgDecodeFailed = false; this.inverse = undefined; this.forceNative = false;
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
        if (m.type === 'ready') { this.decodedImages.clear(); }
        const format = m.format === 'svg' && this.session.previewSvg ? 'svg' : 'png';
        if (format !== this.format) { this.svgDecodeFailed = false; }
        if (this.page !== m.page || this.width !== m.width || this.format !== format || m.type === 'ready') { this.dirty = true; }
        this.format = format;
        if (this.page !== m.page) { this.inverse = undefined; this.forceNative = false; this.shown = undefined; this.target = undefined; this.svgDecodeFailed = false; }
        this.page = m.page as number; this.width = Math.round(m.width as number);
        if (this.state?.[4] && this.state[3] > 0) { this.page = Math.min(this.page, this.state[3] - 1); }
        this.ready = true; this.status(); this.flush();
        break;
      case 'decoded':
        if (m.id === this.inFlight?.id && Array.isArray(m.cached)) {
          this.decodedImages = new Set(m.cached.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)).slice(0, 4));
        }
        if (m.id === this.inFlight?.id) { if (!this.inFlight?.region) { this.destination = undefined; } this.release(); this.flush(); }
        break;
      case 'cache-miss':
        if (this.inFlight && m.id === this.inFlight.id && !this.inFlight.region) {
          this.decodedImages.clear(); this.release(); this.dirty = true; this.flush();
        }
        break;
      case 'decode-error':
        if (m.id === this.inFlight?.id) {
          const svg = this.shown && this.shown.requestId === m.id && this.shown.mime === 'image/svg+xml';
          this.release();
          if (svg) { this.svgDecodeFailed = true; this.dirty = true; this.flush(); }
          else { void this.post({ type: 'error', text: 'Could not decode the preview image. Restart the preview to try again.' }); }
        }
        break;
      case 'link': {
        const h = this.shown;
        if (!this.session.previewLinks || !h || h.revision !== m.revision || h.sequence !== m.sequence ||
            h.sequence !== this.session.previewSequence || h.page !== m.page || !Number.isInteger(m.index)) { break; }
        const link = h.annotations?.links[m.index as number];
        if (!link) { break; }
        if (link.uri.startsWith('#')) {
          if (link.uri.length === 1) { break; }
          this.destination = link.uri.slice(1);
          this.session.send(['preview-destination', h.revision, h.sequence, this.destination]);
        } else {
          try {
            const url = new URL(link.uri);
            if (['http:', 'https:', 'mailto:'].includes(url.protocol) && !/[\x00-\x1f\x7f]/.test(link.uri)) {
              void Promise.resolve(this.api.env.openExternal(this.api.Uri.parse(url.href))).then(opened => {
                if (!opened) { void this.post({ type: 'link-error', text: 'VS Code could not open this link.' }); }
              }, () => { void this.post({ type: 'link-error', text: 'VS Code could not open this link.' }); });
            }
          } catch { /* Unsupported or malformed document links remain inert. */ }
        }
        break;
      }
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
          if (this.enginePage?.revision === h.revision && this.enginePage.sequence === h.sequence && this.enginePage.page === h.page) {
            this.session.send(['preview-inverse', h.revision, h.sequence, h.page, m.x, m.y]);
          } else {
            // A cache hit need not move the native viewer. Load its hit-testing
            // display list only when inverse search actually needs it.
            this.inverse = { revision: h.revision, sequence: h.sequence, page: h.page, x: m.x, y: m.y };
            this.forceNative = true; this.dirty = true; this.flush();
          }
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
      const verb = this.format === 'svg' && !this.svgDecodeFailed ? 'preview-svg' : 'preview-render';
      const key = `${this.state[1]}:${this.state[2]}:${this.page}:${this.width}:${verb}`;
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: this.page, key };
      const cached = !this.forceNative && this.pages.get(key);
      this.forceNative = false;
      if (cached) {
        this.pages.delete(key); this.pages.set(key, cached);
        this.inFlight.cached = true;
        this.image({ header: { ...cached.header, requestId: this.nextId }, bytes: cached.bytes });
      } else {
        this.enginePage = undefined;
        this.session.send([verb, this.nextId, this.page, this.width, this.state[1], this.state[2]]);
      }
    } else if ((this.region || this.detail) && this.shown) {
      const region = (this.region || this.detail)!; this[region.purpose] = undefined;
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: this.page, region };
      const b = region.bounds;
      this.enginePage = undefined;
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
    if (!request.cached) {
      this.enginePage = { revision: h.revision, sequence: h.sequence, page: h.page };
      if (request.key) { this.cachePage(request.key, frame); }
    }
    this.page = h.page;
    if (!request.region) { this.shown = h; if (this.svgDecodeFailed) { h.fallback = 'SVG could not be decoded by the preview'; } }
    // Buffer.buffer may expose a larger pooled allocation. Send only image bytes.
    const contentId = !request.region ? createHash('sha256').update(h.mime).update(frame.bytes).digest('hex') : undefined;
    const bytes = contentId && this.decodedImages.has(contentId) ? undefined : new Uint8Array(frame.bytes).buffer;
    if (!request.cached && this.inverse && this.inverse.revision === h.revision &&
        this.inverse.sequence === h.sequence && this.inverse.page === h.page) {
      const point = this.inverse; this.inverse = undefined;
      this.session.send(['preview-inverse', h.revision, h.sequence, h.page, point.x, point.y]);
    }
    this.decodeTimeout = setTimeout(() => {
      this.release(); this.ready = false;
      void this.post({ type: 'error', text: 'The preview did not acknowledge its image. Reopen the preview tab or restart.' });
    }, 10000);
    const target = this.target?.page === h.page && this.target.revision === h.revision &&
      this.target.sequence === h.sequence ? this.target : undefined;
    if (target && !request.region) { this.target = undefined; }
    void this.post(request.region ? { type: request.region.purpose, header: h, bytes, token: request.region.token } :
      { type: 'image', header: h, bytes, contentId, target, destination: this.destination })
      .then(delivered => { if (!delivered && this.inFlight?.id === h.requestId) { this.release(); this.ready = false; this.dirty = true; } });
    this.status();
  }

  private clearPages(): void { this.pages.clear(); this.pageBytes = 0; this.inverse = undefined; this.forceNative = false; }
  private cachePage(key: string, frame: PreviewImage): void {
    const previous = this.pages.get(key);
    if (previous) { this.pageBytes -= previous.bytes.length; this.pages.delete(key); }
    // Metadata is bounded by the protocol; cap both entry count and image bytes.
    if (frame.bytes.length > 8 * 1024 * 1024) { return; }
    this.pages.set(key, { header: { ...frame.header }, bytes: frame.bytes }); this.pageBytes += frame.bytes.length;
    while (this.pages.size > 8 || this.pageBytes > 8 * 1024 * 1024) {
      const oldest = this.pages.keys().next().value as string;
      this.pageBytes -= this.pages.get(oldest)!.bytes.length; this.pages.delete(oldest);
    }
  }

  private status(): void {
    void this.post({ type: 'state', page: this.page, count: this.state?.[3] || 0, complete: !!this.state?.[4],
      regions: this.session.previewRegions, svg: this.session.previewSvg, links: this.session.previewLinks, paused: this.session.paused, phase: this.session.state });
  }
  private post(message: object): Promise<boolean> {
    return this.disposed ? Promise.resolve(false) : Promise.resolve(
      this.panel.webview.postMessage({ instance: this.instance, ...message })).catch(() => false);
  }
  private release(): void { clearTimeout(this.decodeTimeout); this.decodeTimeout = undefined; this.inFlight = undefined; }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.release(); this.clearPages(); this.decodedImages.clear(); this.panel.dispose(); } }
}
