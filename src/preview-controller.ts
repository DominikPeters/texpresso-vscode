import type * as vscode from 'vscode';
import { createHash, randomBytes } from 'crypto';
import * as path from 'path';
import type { TexpressoSession } from './session';
import { canonicalSvg, diffSvg, type SvgDocument } from './svg-patch';
import type { PreviewImage, PreviewImageHeader, PreviewMessage } from './preview-protocol';
import { AutoRenderCosts } from './auto-render-costs';

// Official VS Code product icons, bundled as SVG to avoid shipping an icon font.
const icons = require('../media/codicons.json') as Record<string, string>;
const icon = (name: string) => icons[name].replace('<svg ', '<svg aria-hidden="true" focusable="false" ');

type RegionRequest = { token: number; bounds: number[]; width: number; purpose: 'region' | 'detail' };

type PreparedSvg = { document?: SvgDocument; bytes: Buffer; id: string; cost: number };

type RasterBase = { id: number; rasterId: number; contentId: string; page: number; width: number; height: number; bounds: number[] };
type RasterPage = { header: PreviewImageHeader; contentId: string };

type PreviewEvent = PreviewMessage | PreviewImage | { sourceSequence: number };

export class PreviewController {
  private panel: vscode.WebviewPanel;
  private readonly instance = randomBytes(16).toString('hex');
  private disposed = false;
  private ready = false;
  private dirty = true;
  private page = 0;
  private width = 1200;
  private format: 'auto' | 'png' | 'svg' = 'auto';
  private autoPages = new Map<number, { svg: boolean; cost: number; bounds?: number[] }>();
  private renderCosts = new AutoRenderCosts();
  private upgradeTimer?: ReturnType<typeof setTimeout>;
  private upgradeReady = false;
  private gesture = false;
  private svgDecodeFailed = false;
  private destination?: string;
  private nextId = 0;
  private inFlight?: { id: number; revision: number; sequence: number; page: number; region?: RegionRequest; key?: string; cached?: boolean; width?: number; upgrade?: boolean; patched?: boolean; processingMs?: number; costContext?: string; raster?: boolean; contentId?: string };
  // Encoded pages are valid only within an engine revision and source barrier.
  private pages = new Map<string, PreviewImage>();
  private pageBytes = 0;
  private svgDom = false;
  private pngCanvas = false;
  private rasterBase?: RasterBase;
  private rasterPending?: RasterBase;
  private rasterPages = new Map<string, RasterPage>();
  private svgDocuments = new Map<string, PreparedSvg>();
  private svgDocumentBytes = 0;
  private svgBase?: { contentId: string; page: number; document: SvgDocument };
  private svgPending?: { id: number; contentId: string; page: number; document: SvgDocument };
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
    const pngScript = webview.asWebviewUri(api.Uri.joinPath(media, 'preview-png.js'));
    const svgScript = webview.asWebviewUri(api.Uri.joinPath(media, 'preview-svg.js'));
    const cacheScript = webview.asWebviewUri(api.Uri.joinPath(media, 'preview-cache.js'));
    const lensScript = webview.asWebviewUri(api.Uri.joinPath(media, 'preview-lens.js'));
    const style = webview.asWebviewUri(api.Uri.joinPath(media, 'preview.css'));
    let visible = this.panel.visible;
    webview.onDidReceiveMessage(value => this.receive(value));
    this.panel.onDidChangeViewState(() => {
      if (visible === this.panel.visible) { return; }
      visible = this.panel.visible;
      this.interactive(); this.gesture = false; this.ready = false; this.release(); this.dirty = true; this.region = undefined; this.detail = undefined; this.target = undefined;
      this.shown = undefined; this.destination = undefined; this.decodedImages.clear(); this.rasterBase = undefined; this.svgBase = undefined; this.svgPending = undefined; this.inverse = undefined; this.forceNative = false;
      // A restored webview announces ready; a retained live one answers ping.
      if (this.panel.visible) { void this.post({ type: 'ping' }); }
    });
    this.panel.onDidDispose(() => {
      const notify = !this.disposed;
      this.disposed = true; this.interactive(); this.release(); this.clearPages(); this.svgDocuments.clear(); this.svgDocumentBytes = 0; this.decodedImages.clear(); this.rasterBase = undefined; this.svgBase = undefined; this.svgPending = undefined;
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
      <select id="format" aria-label="Rendering format" title="Rendering format"><option value="auto">Auto</option><option value="png">PNG</option><option value="svg">SVG</option></select>
      <button id="zoomIn" title="Zoom in" aria-label="Zoom in">${icon('zoom-in')}</button></div>
      <div class="actions"><button id="magnify" title="Magnifier: hold the mouse button on the page (M)" aria-label="Magnifier" aria-pressed="false">${icon('search')}</button>
      <button id="pause" title="Pause compilation" aria-label="Pause compilation"><span id="pauseIcon">${icon('debug-pause')}</span><span id="resumeIcon" hidden>${icon('play')}</span></button>
      <button id="restart" title="Restart preview" aria-label="Restart preview">${icon('refresh')}</button><button id="output" title="Show compiler output" aria-label="Show compiler output">${icon('output')}</button></div></header>
      <div id="status" role="alert" hidden></div>
      <main id="viewport" tabindex="0" aria-label="Document preview. Control or Command click to open source.">
      <div id="sheet" hidden><div id="raster" hidden></div><div id="vector" hidden role="img" aria-label="Rendered LaTeX page"></div><img id="image" alt="Rendered LaTeX page" draggable="false" hidden><img id="detail" alt="" draggable="false" hidden><div id="links"></div><div id="highlight" hidden></div></div>
      <p id="empty">Your document will appear here.</p></main><div id="lens" hidden><canvas id="lensCanvas" hidden></canvas><div id="lensVector" hidden></div><img id="lensBase" alt="" draggable="false"><img id="lensImage" alt="Magnified page region" draggable="false"></div>
      <script nonce="${this.instance}" src="${viewportScript}"></script>
      <script nonce="${this.instance}" src="${lensScript}"></script>
      <script nonce="${this.instance}" src="${cacheScript}"></script>
      <script nonce="${this.instance}" src="${pngScript}"></script>
      <script nonce="${this.instance}" src="${svgScript}"></script>
      <script nonce="${this.instance}" src="${script}"></script></body></html>`;
    if (session.previewState) { this.handle(session.previewState); }
  }

  handle(event: PreviewEvent): void {
    if (this.disposed) { return; }
    if ('sourceSequence' in event) {
      this.interactive(); this.clearPages(); this.enginePage = undefined; this.inverse = undefined;
      this.dirty = true; this.shown = undefined; this.target = undefined; this.region = undefined; this.detail = undefined; this.destination = undefined; this.svgDecodeFailed = false;
      void this.post({ type: 'invalidate' });
    } else if ('header' in event) {
      this.image(event);
    } else {
      switch (event[0]) {
        case 'preview-state':
          if (this.state && (this.state[1] !== event[1] || this.state[2] !== event[2])) { this.interactive(); this.clearPages(); this.enginePage = undefined; }
          if (this.enginePage?.page !== event[5]) { this.enginePage = undefined; }
          this.state = event;
          if (event[4] && event[3] > 0) { this.page = Math.min(this.page, event[3] - 1); }
          this.status(); this.flush();
          break;
        case 'preview-invalidated':
          this.interactive(); this.clearPages(); this.enginePage = undefined; this.inverse = undefined;
          this.dirty = true; this.shown = undefined; this.target = undefined; this.region = undefined; this.detail = undefined; this.destination = undefined; this.svgDecodeFailed = false;
          void this.post({ type: 'invalidate' });
          break;
        case 'preview-retry':
          if (this.inFlight?.id === event[1]) { this.release(); this.dirty = true; this.flush(); }
          break;
        case 'preview-error':
          if (this.inFlight?.id === event[1]) {
            // Older engines can report a failure for work superseded by a source
            // barrier. It must not swallow the newer dirty request or display a
            // transient error for source which is no longer being compiled.
            if (this.inFlight.sequence !== this.session.previewSequence || this.inFlight.revision !== this.state?.[1] ||
                this.inFlight.sequence !== this.state?.[2] || this.inFlight.page !== this.page) {
              this.release(); this.dirty = true; this.flush(); break;
            }
            const region = this.inFlight.region, upgrade = this.inFlight.upgrade;
            this.release();
            if (upgrade) { this.rememberAuto(this.page, false, this.shown?.vectorCost || 0); void this.post({ type: 'refinement-end' }); this.flush(); break; }
            if (region) { this[region.purpose] = undefined; }
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
          this.interactive();
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
    this.interactive();
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
      case 'interaction':
        if (typeof m.active === 'boolean') { this.gesture = m.active; }
        this.interactive(); this.scheduleUpgrade(); break;
      case 'ready':
      case 'viewport':
        if (!Number.isInteger(m.page) || (m.page as number) < 0 || (m.page as number) > 100000 ||
            !Number.isFinite(m.width) || (m.width as number) < 1 || (m.width as number) > 4096) { return; }
        if (m.type === 'ready') { this.decodedImages.clear(); this.rasterBase = undefined; this.svgBase = undefined; this.svgPending = undefined; this.svgDom = m.svgDom === true; this.pngCanvas = m.pngCanvas === true; }
        const format = m.format === 'svg' && this.session.previewSvg ? 'svg' : m.format === 'png' ? 'png' : 'auto';
        if (format !== this.format) { this.svgDecodeFailed = false; }
        if (this.page !== m.page || this.width !== m.width || this.format !== format || m.type === 'ready') { this.dirty = true; }
        if (this.page !== m.page || this.width !== m.width || this.format !== format || m.type === 'ready') { this.interactive(); }
        this.format = format;
        if (this.page !== m.page) { this.inverse = undefined; this.forceNative = false; this.shown = undefined; this.target = undefined; this.svgDecodeFailed = false; }
        this.page = m.page as number; this.width = Math.round(m.width as number);
        if (this.state?.[4] && this.state[3] > 0) { this.page = Math.min(this.page, this.state[3] - 1); }
        this.ready = true; this.status(); this.flush();
        break;
      case 'decoded':
        if (!this.inFlight || m.id !== this.inFlight.id) { break; }
        if (!this.inFlight.region) {
          if (this.shown?.requestId === m.id && this.shown.page === this.page && this.inFlight.page === this.page &&
              this.shown.revision === this.state?.[1] && this.shown.sequence === this.session.previewSequence) {
            this.session.previewDecoded?.(this.shown, typeof m.svg === 'string');
            if (!this.inFlight.cached && this.inFlight.costContext && this.shown.exportMs !== undefined &&
                typeof m.renderMs === 'number' && Number.isFinite(m.renderMs) && m.renderMs >= 0 &&
                (this.shown.mime === 'image/png' || typeof m.svg === 'string')) {
              this.renderCosts.record(this.inFlight.costContext, this.shown.mime === 'image/png' ? 'png' : 'svg',
                this.shown.mime === 'image/png' ? !!this.shown.patch : !!this.inFlight.patched,
                { native: this.shown.exportMs, host: this.inFlight.processingMs || 0, webview: m.renderMs });
            }
            if (this.shown.mime === 'image/svg+xml' && (!this.inFlight.cached || this.inFlight.upgrade)) {
              const cost = this.shown.vectorCost || 0;
              const renderMs = typeof m.renderMs === 'number' && Number.isFinite(m.renderMs) && m.renderMs >= 0 ? m.renderMs : 0;
              this.rememberAuto(this.page, typeof m.svg === 'string' && (this.shown.exportMs || 0) + (this.inFlight.processingMs || 0) + renderMs <= (this.inFlight.patched ? 24 : 80), cost);
            }
          }
          if (this.svgPending && this.svgPending.id === m.id && this.svgPending.contentId === m.svg) { this.svgBase = this.svgPending; }
          else if (this.svgBase?.contentId !== m.svg) { this.svgBase = undefined; }
          this.svgPending = undefined;
          this.rasterBase = this.rasterPending?.id === m.id && this.rasterPending.contentId === m.png ? this.rasterPending : undefined;
          this.rasterPending = undefined;
        }
        if (m.id === this.inFlight?.id && Array.isArray(m.cached)) {
          this.decodedImages = new Set(m.cached.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)).slice(0, 4));
        }
        if (m.id === this.inFlight?.id) { if (!this.inFlight?.region) { this.destination = undefined; } this.release(); this.flush(); this.scheduleUpgrade(); }
        break;
      case 'cache-miss':
        if (this.inFlight && m.id === this.inFlight.id && !this.inFlight.region) {
          if (m.pngUnsupported === true) { this.pngCanvas = false; }
          else if (this.inFlight.raster) { this.forceNative = true; }
          this.decodedImages.clear(); this.rasterBase = undefined; this.svgBase = undefined; this.svgPending = undefined; this.release(); this.dirty = true; this.flush();
        }
        break;
      case 'decode-error':
        if (m.id === this.inFlight?.id) {
          const svg = this.shown && this.shown.requestId === m.id && this.shown.mime === 'image/svg+xml';
          this.svgBase = undefined; this.svgPending = undefined; this.release();
          if (svg) { this.rememberAuto(this.page, false, this.shown?.vectorCost || 0); this.svgDecodeFailed = true; this.dirty = true; this.flush(); }
          else { void this.post({ type: 'error', text: 'Could not decode the preview image. Restart the preview to try again.' }); }
        }
        break;
      case 'link': {
        const h = this.shown;
        if (!this.session.previewLinks || !h || h.revision !== m.revision || h.sequence !== m.sequence ||
            h.sequence !== this.session.previewSequence || h.page !== m.page || !Number.isInteger(m.index)) { break; }
        this.interactive();
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
          this.interactive();
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
          this.interactive();
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
      const learned = this.autoPages.get(this.page);
      // Full-mount costs cannot predict a warm edit. Only compare naturally
      // observed matching phases, viewport and page-complexity class.
      const previous = this.svgBase?.page === this.page || this.rasterBase?.page === this.page;
      const context = this.costContext(this.page, this.width, this.shown?.bounds || learned?.bounds, learned?.cost);
      const preferPng = context && this.renderCosts.preferPng(context, !!previous);
      const useSvg = learned?.svg && !preferPng;
      const limit = preferPng ? 0 : learned ? learned.svg ? Math.min(200000, Math.max(16000, Math.ceil(learned.cost * 1.3))) : 0 : 16000;
      const verb = this.svgDecodeFailed ? 'preview-render' : this.format === 'svg' ? 'preview-svg' :
        this.format === 'auto' && this.session.previewAuto && this.session.previewSvg ? 'preview-auto' : 'preview-render';
      const key = this.pageKey(verb === 'preview-auto' ? `auto:${limit}` : verb === 'preview-svg' ? 'svg' : 'png');
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: this.page, key, width: this.width };
      const cached = !this.forceNative && (verb === 'preview-auto' ?
        (useSvg ? this.pages.get(this.pageKey('svg')) : undefined) || this.pages.get(key) || this.pages.get(this.pageKey('png')) : this.pages.get(key));
      const rasterKey = this.pageKey('png');
      const raster = !this.forceNative && (this.rasterPages.get(key) || this.rasterPages.get(rasterKey));
      const reference = raster && this.decodedImages.has(raster.contentId) && verb !== 'preview-svg' ? raster : undefined;
      const force = this.forceNative; this.forceNative = false;
      if (!cached && reference) {
        this.inFlight.cached = true; this.inFlight.contentId = reference.contentId;
        this.image({ header: { ...reference.header, requestId: this.nextId }, bytes: Buffer.alloc(0) });
      } else if (cached) {
        this.cachePage(key, cached);
        this.inFlight.cached = true;
        this.image({ header: { ...cached.header, requestId: this.nextId }, bytes: cached.bytes });
      } else {
        this.enginePage = undefined;
        const patches = this.pngCanvas && this.session.previewPngPatches;
        const base = !force && this.rasterBase?.page === this.page && this.decodedImages.has(this.rasterBase.contentId) ? this.rasterBase.rasterId : 0;
        if (verb === 'preview-auto') {
          if (patches) { this.session.send([verb, this.nextId, this.page, this.width, this.state[1], this.state[2], limit, base]); }
          else { this.session.send([verb, this.nextId, this.page, this.width, this.state[1], this.state[2], limit]); }
        } else if (verb === 'preview-render' && patches) { this.session.send(['preview-png', this.nextId, this.page, this.width, this.state[1], this.state[2], base]); }
        else { this.session.send([verb, this.nextId, this.page, this.width, this.state[1], this.state[2]]); }
      }
    } else if ((this.region || this.detail) && this.shown) {
      const region = (this.region || this.detail)!; this[region.purpose] = undefined;
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: this.page, region };
      const b = region.bounds;
      this.enginePage = undefined;
      this.session.send(['preview-region', this.nextId, this.page, region.width, this.state[1], this.state[2], b[0], b[1], b[2], b[3]]);
    } else if (this.upgradeReady && this.canUpgrade()) {
      this.upgradeReady = false;
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: this.page,
        key: this.pageKey('svg'), upgrade: true, width: this.width };
      const cached = this.pages.get(this.pageKey('svg'));
      if (cached) {
        this.inFlight.cached = true;
        this.image({ header: { ...cached.header, requestId: this.nextId }, bytes: cached.bytes });
      } else { this.session.send(['preview-svg', this.nextId, this.page, this.width, this.state[1], this.state[2]]); }
    }
  }

  private image(frame: PreviewImage): void {
    const started = performance.now();
    const h = frame.header, request = this.inFlight;
    if (!request || h.requestId !== request.id) { return; }
    // An obsolete viewport can still supply a useful page/size for a later
    // revisit. Never retain it across a source barrier or engine revision.
    if (!h.patch && !request.cached && request.key && h.sequence === this.session.previewSequence &&
        h.revision === this.state?.[1] && h.page === request.page) { this.cachePage(request.key, frame); this.cachePage(this.pageKey(h.mime === 'image/svg+xml' ? 'svg' : 'png', h.page, request.width), frame); }
    if (!this.ready || !this.panel.visible || h.sequence !== this.session.previewSequence || h.revision !== this.state?.[1] ||
        request.page !== this.page || h.page !== request.page || this.dirty) {
      this.release(); this.dirty = true; this.flush(); return;
    }
    if (!request.cached) {
      this.enginePage = { revision: h.revision, sequence: h.sequence, page: h.page };
    }
    this.page = h.page;
    if (!request.region && this.svgDecodeFailed) { h.fallback = 'SVG could not be decoded by the preview'; }
    // Buffer.buffer may expose a larger pooled allocation. Send only image bytes.
    const prepared = this.svgDom && !request.region && h.mime === 'image/svg+xml' ? this.prepareSvg(frame.bytes) : undefined;
    if (request.upgrade && (!prepared?.document || h.mime !== 'image/svg+xml')) {
      this.rememberAuto(this.page, false, h.vectorCost || this.shown?.vectorCost || 0);
      void this.post({ type: 'refinement-end' }); this.release(); this.flush(); return;
    }
    const svgDocument = prepared?.document, payload = prepared?.bytes || frame.bytes;
    const displayHeader = { ...h, byteLength: payload.length };
    if (!request.region) { this.shown = displayHeader; }
    let rasterPatch: { base: string; rect: number[] } | undefined;
    if (h.patch) {
      const base = this.rasterBase;
      if (!this.pngCanvas || !base || h.patch.base !== base.rasterId || h.page !== base.page ||
          h.width !== base.width || h.height !== base.height || h.bounds.some((n, i) => n !== base.bounds[i]) || !this.decodedImages.has(base.contentId)) {
        this.rasterBase = undefined; this.forceNative = true; this.release(); this.dirty = true; this.flush(); return;
      }
      rasterPatch = { base: base.contentId, rect: h.patch.rect };
      // Older full PNG bytes cannot reconstruct an updated canvas. Retain the
      // decoded-page reference instead; a missing canvas requests a keyframe.
      for (const [key, cached] of this.pages) {
        if (cached.header.mime === 'image/png' && cached.header.page === h.page &&
            cached.header.width === h.width && cached.header.height === h.height) {
          this.pageBytes -= cached.bytes.length; this.pages.delete(key);
        }
      }
    }
    const contentId = !request.region ? request.contentId || (rasterPatch ? frame.bytes.length ?
      createHash('sha256').update('png-patch').update(rasterPatch.base).update(JSON.stringify(rasterPatch.rect)).update(payload).digest('hex') : rasterPatch.base :
      prepared?.id || createHash('sha256').update(h.mime).update(payload).digest('hex')) : undefined;
    request.raster = !request.region && this.pngCanvas && h.rasterId !== undefined;
    this.rasterPending = request.raster && contentId ? { id: h.requestId, rasterId: h.rasterId!, contentId, page: h.page, width: h.width, height: h.height, bounds: h.bounds } : undefined;
    if (request.raster && contentId && request.key) {
      const cachedHeader = { ...displayHeader }; delete cachedHeader.patch;
      for (const key of [request.key, this.pageKey('png', h.page, request.width)]) {
        this.rasterPages.delete(key); this.rasterPages.set(key, { header: cachedHeader, contentId });
      }
      while (this.rasterPages.size > 8) { this.rasterPages.delete(this.rasterPages.keys().next().value as string); }
    }
    const svgPatch = svgDocument && contentId && !this.decodedImages.has(contentId) && this.svgBase?.page === h.page
      ? diffSvg(this.svgBase.document, svgDocument, this.svgBase.contentId) : undefined;
    request.patched = !!svgPatch;
    // A native frame can still be a decoded-content hit or a no-op patch. Its
    // near-zero browser work is neither a full mount nor a meaningful edit.
    request.costContext = (contentId && this.decodedImages.has(contentId)) || svgPatch?.operations.length === 0 ||
      (h.patch && !h.byteLength) ? undefined : this.costContext(h.page, request.width || this.width, h.bounds,
      h.vectorCost ?? this.autoPages.get(h.page)?.cost);
    this.svgPending = svgDocument && contentId ? { id: h.requestId, page: h.page, contentId, document: svgDocument } : undefined;
    const bytes = (contentId && this.decodedImages.has(contentId)) || svgPatch || request.contentId ? undefined : new Uint8Array(payload).buffer;
    if (!request.cached && this.inverse && this.inverse.revision === h.revision &&
        this.inverse.sequence === h.sequence && this.inverse.page === h.page) {
      const point = this.inverse; this.inverse = undefined;
      this.session.send(['preview-inverse', h.revision, h.sequence, h.page, point.x, point.y]);
    }
    request.processingMs = performance.now() - started;
    this.decodeTimeout = setTimeout(() => {
      this.release(); this.ready = false;
      void this.post({ type: 'error', text: 'The preview did not acknowledge its image. Reopen the preview tab or restart.' });
    }, 10000);
    const target = this.target?.page === h.page && this.target.revision === h.revision &&
      this.target.sequence === h.sequence ? this.target : undefined;
    if (target && !request.region) { this.target = undefined; }
    void this.post(request.region ? { type: request.region.purpose, header: displayHeader, bytes, token: request.region.token } :
      { type: 'image', header: displayHeader, bytes, contentId, inlineSvg: !!svgDocument, inlinePng: request.raster, rasterPatch, svgPatch, target, destination: this.destination, refining: this.canUpgrade() })
      .then(delivered => { if (!delivered && this.inFlight?.id === h.requestId) { this.release(); this.ready = false; this.dirty = true; } });
    this.status();
  }

  private prepareSvg(bytes: Buffer): PreparedSvg {
    const rawId = createHash('sha256').update('image/svg+xml').update(bytes).digest('hex');
    const cached = this.svgDocuments.get(rawId);
    if (cached) { this.svgDocuments.delete(rawId); this.svgDocuments.set(rawId, cached); return cached; }
    // A prior budget/feature fallback may already be a decoded SVG image.
    // Preserve that fast cache path instead of upgrading it during navigation.
    if (this.decodedImages.has(rawId)) { return { bytes, id: rawId, cost: 0 }; }
    const source = bytes.toString('utf8'), document = canonicalSvg(source);
    if (!document) { return { bytes, id: rawId, cost: 0 }; }
    const payload = document.text === source ? bytes : Buffer.from(document.text, 'utf8');
    const id = payload === bytes ? rawId : createHash('sha256').update('image/svg+xml').update(payload).digest('hex');
    // Include string storage and an estimate for indexed nodes, in addition to
    // encoded bytes. Only two prepared documents are retained between frames.
    const cost = document.text.length * 2 + payload.length + document.root.count * 128;
    const prepared = { document, bytes: payload, id, cost };
    if (cost <= 8 * 1024 * 1024) {
      this.svgDocuments.set(rawId, prepared); this.svgDocumentBytes += cost;
      while (this.svgDocuments.size > 2 || this.svgDocumentBytes > 8 * 1024 * 1024) {
        const oldest = this.svgDocuments.keys().next().value as string;
        this.svgDocumentBytes -= this.svgDocuments.get(oldest)!.cost; this.svgDocuments.delete(oldest);
      }
    }
    return prepared;
  }

  private pageKey(codec: string, page = this.page, width = this.width): string {
    return `${this.state![1]}:${this.state![2]}:${page}:${codec === 'svg' ? 0 : width}:${codec}`;
  }
  private costContext(page: number, width: number, bounds?: number[], cost?: number): string | undefined {
    // Manual PNG can contribute after Auto/SVG established this page's complexity.
    // A different density class or physical raster width starts fresh evidence.
    return bounds && cost !== undefined ? `${page}:${width}:${bounds.join(',')}:${Math.round(Math.log(Math.max(1, cost)) / Math.log(1.25))}` : undefined;
  }
  private rememberAuto(page: number, svg: boolean, cost: number): void {
    const bounds = this.shown?.page === page ? this.shown.bounds : this.autoPages.get(page)?.bounds;
    this.autoPages.delete(page); this.autoPages.set(page, { svg, cost, bounds });
    if (this.autoPages.size > 32) { this.autoPages.delete(this.autoPages.keys().next().value as number); }
  }
  private interactive(): void {
    clearTimeout(this.upgradeTimer); this.upgradeTimer = undefined; this.upgradeReady = false;
    // A background request may be superseded. Late frames/ACKs cannot consume
    // the foreground request's credit, and the native pending slot is replaceable.
    if (this.inFlight?.upgrade) { this.release(); this.svgPending = undefined; }
  }
  private canUpgrade(): boolean {
    const h = this.shown, learned = this.autoPages.get(this.page);
    const context = this.costContext(this.page, this.width, h?.bounds || learned?.bounds, learned?.cost);
    // Keep the comparison raster when PNG is measurably better for edits.
    // An idle SVG would discard that native base and force a full PNG next time.
    if (context && (this.renderCosts.preferPng(context, true) || this.renderCosts.preferPng(context, false))) { return false; }
    return !this.gesture && this.format === 'auto' && this.session.previewSvg && this.svgDom && !this.svgDecodeFailed &&
      !!h && h.mime === 'image/png' && h.svgEligible === true && !h.fallback &&
      h.page === this.page && h.revision === this.state?.[1] && h.sequence === this.session.previewSequence &&
      (!learned || learned.svg || (h.vectorCost || 0) < learned.cost * 0.75);
  }
  private scheduleUpgrade(): void {
    clearTimeout(this.upgradeTimer); this.upgradeTimer = undefined;
    if (!this.canUpgrade() || this.inFlight || this.dirty || !this.ready || !this.panel.visible || this.disposed) { return; }
    this.upgradeTimer = setTimeout(() => {
      this.upgradeTimer = undefined;
      if (!this.canUpgrade()) { return; }
      this.upgradeReady = true; this.flush();
    }, 350);
  }

  private clearPages(): void { this.rasterPages.clear(); this.pages.clear(); this.pageBytes = 0; this.inverse = undefined; this.forceNative = false; }
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
  private release(): void { clearTimeout(this.decodeTimeout); this.decodeTimeout = undefined; this.inFlight = undefined; this.rasterPending = undefined; }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.interactive(); this.release(); this.clearPages(); this.svgDocuments.clear(); this.svgDocumentBytes = 0; this.decodedImages.clear(); this.rasterBase = undefined; this.svgBase = undefined; this.svgPending = undefined; this.panel.dispose(); } }
}
