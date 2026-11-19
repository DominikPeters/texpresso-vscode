import type * as vscode from 'vscode';
import { createHash, randomBytes } from 'crypto';
import * as path from 'path';
import type { TexpressoSession } from './session';
import { canonicalSvg, diffSvg, type SvgDocument } from './svg-patch';
import type { PreviewImage, PreviewImageHeader, PreviewMessage } from './preview-protocol';
import { AutoRenderCosts } from './auto-render-costs';
import { EditPrewarm } from './edit-prewarm';
import { RenderFallbacks, type FallbackContext, type RenderBudget } from './render-fallback';
import { RecoveryBudget } from './recovery';
import type { TikzActions } from './tikz-editor';

// Official VS Code product icons, bundled as SVG to avoid shipping an icon font.
const icons = require('../media/codicons.json') as Record<string, string>;
const icon = (name: string) => icons[name].replace('<svg ', '<svg aria-hidden="true" focusable="false" ');

/**
 * A raster wanted for a page. With `clip`, `width` is the page's grid width in device pixels and `clip` an
 * integer rectangle of that grid (a surface); without it, `width` is a capped whole-page width. `placeholder`
 * is the width of the coarse whole page shown around a partial rectangle.
 */
type Clip = [number, number, number, number];
type PageDemand = { page: number; width: number; allocation?: string; clip?: Clip; placeholder?: number };
type PresentedPage = { header: PreviewImageHeader; width: number; format: string; decoded: boolean; clip?: Clip };
const sameClip = (a?: Clip, b?: Clip) => a === b || (!!a && !!b && a.every((n, i) => n === b[i]));

type RegionRequest = { page: number; token: number; bounds: number[]; width: number; purpose: 'region' | 'detail' };

type PreparedSvg = { document?: SvgDocument; bytes: Buffer; id: string; cost: number };

type RasterBase = { id: number; rasterId: number; contentId: string; page: number; width: number; height: number; bounds: number[]; grid?: number[]; clip?: number[] };
type RasterPage = { header: PreviewImageHeader; contentId: string };

type PreviewEvent = PreviewMessage | PreviewImage | { sourceSequence: number };

export class PreviewController {
  private panel: vscode.WebviewPanel;
  private prewarm: EditPrewarm;
  private instance = randomBytes(16).toString('hex');
  private disposed = false;
  private sourceFollowing = true;
  private sourceHighlight = false;
  private sourceIntent = 0;
  private recoveryCapabilities?: { regions: boolean; svg: boolean; links: boolean; surfaces?: boolean; maxPixels?: number };
  private recoveryPagination?: { count: number; complete: boolean };
  private ready = false;
  private dirty = true;
  // Foreground render priority can differ from the browser's centered page.
  private page = 0;
  private viewportPage = 0;
  private navigationObservation?: number;
  private nextViewportRequest = 0;
  private awaitingViewport?: number;
  private viewportTimeout?: ReturnType<typeof setTimeout>;
  private sourcePage?: number;
  private width = 1200;
  private clip?: Clip;
  /** Coarse whole pages delivered for the parts a rectangle does not cover, by page. */
  private placeholders = new Map<number, { revision: number; sequence: number; width: number }>();
  private continuous = false;
  private visible: PageDemand[] = [];
  private nearby: PageDemand[] = [];
  private resident = new Set<number>();
  private presented = new Map<number, PresentedPage>();
  private failed = new Set<number>();
  private viewportEpoch = -1;
  private frontierBudget = 2;
  private prefetchReady = false;
  private prefetched = new Set<number>();
  private prefetchTimer?: ReturnType<typeof setTimeout>;
  private format: 'auto' | 'png' | 'svg' = 'auto';
  private autoPages = new Map<number, { svg: boolean; cost: number; bounds?: number[] }>();
  private renderCosts = new AutoRenderCosts();
  private upgradeTimer?: ReturnType<typeof setTimeout>;
  private upgradeReady = false;
  private gesture = false;
  private svgDecodeFailed = false;
  private svgFailures = new Set<number>();
  private fallback = new RenderFallbacks();
  private fallbackFacts = new Map<number, { bounds: number[]; complexity?: number }>();
  private allocation?: string;
  private webviewRecovery = new RecoveryBudget();
  private html = "";
  private destination?: string;
  private destinationPage?: number;
  private nextId = 0;
  private renderIntent = 0;
  private visualSnapshots = new Map<number, { sequence: number; revision: number }>();
  private inFlight?: { id: number; revision: number; sequence: number; page: number; background?: boolean; format?: string; intent?: number; visualOnly?: boolean; snapshot?: PreviewImageHeader; region?: RegionRequest; key?: string; cached?: boolean; width?: number; clip?: Clip; placeholder?: boolean; upgrade?: boolean; retrySvg?: boolean; patched?: boolean; processingMs?: number; costContext?: string; raster?: boolean; contentId?: string };
  // Encoded pages are valid only within an engine revision and source barrier.
  private pages = new Map<string, PreviewImage>();
  private pageBytes = 0;
  private svgDom = false;
  private pngCanvas = false;
  /** False until a webview has announced whether it can draw PNG pages on a canvas. */
  private pngCanvasKnown = false;
  // The acknowledged canvas of each page that the engine may patch. Surfaces are
  // identified per raster, so visible neighbours keep theirs alongside the active page.
  private rasterBases = new Map<number, RasterBase>();
  private rasterPending?: RasterBase;
  private rasterPages = new Map<string, RasterPage>();
  private svgDocuments = new Map<string, PreparedSvg>();
  private svgDocumentBytes = 0;
  private svgBase?: { contentId: string; page: number; document: SvgDocument };
  private svgPending?: { id: number; contentId: string; page: number; document: SvgDocument };
  private decodedImages = new Set<string>();
  private decodedPages = new Map<number, Set<string>>();
  private enginePage?: { revision: number; sequence: number; page: number };
  private inverse?: { revision: number; sequence: number; page: number; x: number; y: number };
  private forceNative = false;
  private region?: RegionRequest;
  private detail?: RegionRequest;
  private decodeTimeout?: NodeJS.Timeout;
  private state?: Extract<PreviewMessage, ['preview-state', ...unknown[]]>;
  private shown?: PreviewImageHeader;
  private target?: { revision: number; sequence: number; page: number; x: number; y: number; highlight: boolean; rectangles?: import('./preview-protocol').SourceRect[] };

  constructor(private api: typeof vscode, extensionUri: vscode.Uri, public session: TexpressoSession,
    closed: () => void, private action: (name: 'restart' | 'pause' | 'output') => void, private navigated?: () => void, private tikz?: TikzActions,
    private renderingFormat?: 'auto' | 'png' | 'svg') {
    if (this.renderingFormat !== undefined && !['auto', 'png', 'svg'].includes(this.renderingFormat)) { this.renderingFormat = 'png'; }
    this.prewarm = new EditPrewarm(() => ({
      available: !!this.session.previewPrepareEdit && !this.disposed && this.panel?.visible && !this.session.paused && this.session.state === 'running',
      idle: this.ready && !this.dirty && !this.inFlight && !this.region && !this.detail && !this.inverse && !this.destination && !this.gesture &&
        !!this.presented.get(this.page)?.decoded && this.shown?.sequence === this.session.previewSequence && this.state?.[2] === this.session.previewSequence,
      revision: this.state?.[1] || 0, sequence: this.session.previewSequence
    }), command => this.session.send(command), () => ++this.nextId,
    () => { this.enginePage = undefined; this.cancelPrefetch(); clearTimeout(this.upgradeTimer); this.upgradeTimer = undefined; this.upgradeReady = false; },
    () => { this.flush(); this.scheduleUpgrade(); this.schedulePrefetch(); });
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
      visible = this.panel.visible; this.renderIntent++; this.sourcePage = undefined;
      this.releaseViewport();
      this.interactive(); this.gesture = false; this.ready = false; this.release(); this.dirty = true; this.region = undefined; this.detail = undefined; this.target = undefined;
      this.shown = undefined; this.presented.clear(); this.resident.clear(); this.visible = []; this.nearby = []; this.cancelPrefetch(); this.destination = undefined; this.destinationPage = undefined; this.decodedImages.clear(); this.decodedPages.clear(); this.rasterBases.clear(); this.svgBase = undefined; this.svgPending = undefined; this.inverse = undefined; this.forceNative = false;
      // A restored webview announces ready; a retained live one answers ping.
      if (this.panel.visible) { void this.post({ type: 'ping' }); }
      else { void this.post({ type: 'invalidate', retire: true, sequence: this.session.previewSequence,
        revision: this.state?.[2] === this.session.previewSequence ? this.state[1] : undefined }); }
    });
    this.panel.onDidDispose(() => {
      const notify = !this.disposed;
      this.disposed = true; this.releaseViewport(); this.interactive(); this.cancelPrefetch(); this.release(); this.clearPages(); this.svgDocuments.clear(); this.svgDocumentBytes = 0; this.decodedImages.clear(); this.decodedPages.clear(); this.rasterBases.clear(); this.svgBase = undefined; this.svgPending = undefined;
      if (notify) { closed(); }
    });
    this.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${this.instance}';">
      <link rel="stylesheet" href="${style}"></head><body data-instance="${this.instance}" data-rendering-format="${this.renderingFormat || ''}" data-surfaces="${this.surfacesOffered()}" data-max-pixels="${this.session.previewMaxPixels || ''}">
      <header aria-label="Preview controls"><div class="navigation">
      <button id="previous" title="Previous page" aria-label="Previous page">${icon('chevron-left')}</button>
      <label>Page <input id="page" type="number" min="1" value="1" aria-label="Page number"></label><span id="total">/ …</span>
      <button id="next" title="Next page" aria-label="Next page">${icon('chevron-right')}</button>
      <button id="zoomOut" title="Zoom out" aria-label="Zoom out">${icon('zoom-out')}</button>
      <select id="zoom" aria-label="Zoom"><option value="width">Fit width</option><option value="text">Fit to text width</option><option value="page">Fit page</option>
      <option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option>
      <option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option><option value="4">400%</option></select>
      <button id="zoomIn" title="Zoom in" aria-label="Zoom in">${icon('zoom-in')}</button></div>
      <div class="actions"><button id="magnify" title="Magnifier: hold the mouse button on the page (M)" aria-label="Magnifier" aria-pressed="false">${icon('search')}</button>
      <button id="pause" title="Pause compilation" aria-label="Pause compilation"><span id="pauseIcon">${icon('debug-pause')}</span><span id="resumeIcon" hidden>${icon('play')}</span></button>
      <button id="restart" title="Restart preview" aria-label="Restart preview">${icon('refresh')}</button><button id="output" title="Show compiler output" aria-label="Show compiler output">${icon('output')}</button></div></header>
      <div id="status" role="alert" hidden></div>
      <main id="viewport" tabindex="0" aria-label="Document preview. Control or Command click to open source.">
      <div id="sheet" hidden><div id="placeholder" hidden></div><div id="raster" hidden></div><div id="vector" hidden role="img" aria-label="Rendered LaTeX page"></div><img id="image" alt="Rendered LaTeX page" draggable="false" hidden><img id="detail" alt="" draggable="false" hidden><div id="links"></div><div id="highlight" hidden></div><div id="tikzHighlight" class="tikz-highlight" hidden></div><button id="tikzAction" class="tikz-action" type="button" hidden><img class="tikz-editor-icon" src="${webview.asWebviewUri(api.Uri.joinPath(media, 'tikz-editor.png'))}" alt="" draggable="false"><span>Edit in TikZ Editor</span></button></div>
      <p id="empty">Your document will appear here.</p></main><div id="lens" hidden><canvas id="lensCanvas" hidden></canvas><div id="lensVector" hidden></div><img id="lensBase" alt="" draggable="false"><img id="lensImage" alt="Magnified page region" draggable="false"></div>
      <script nonce="${this.instance}" src="${viewportScript}"></script>
      <script nonce="${this.instance}" src="${lensScript}"></script>
      <script nonce="${this.instance}" src="${cacheScript}"></script>
      <script nonce="${this.instance}" src="${pngScript}"></script>
      <script nonce="${this.instance}" src="${svgScript}"></script>
      <script nonce="${this.instance}" src="${script}"></script></body></html>`;
    webview.html = this.html;
    if (session.previewState) { this.handle(session.previewState); }
  }

  /** Rebind without destroying the last good browser surfaces or viewport. */
  replaceSession(session: TexpressoSession): void {
    this.releaseViewport();
    const capabilities = this.uiCapabilities(); this.renderIntent++; this.visualSnapshots.clear();
    if (this.state) { this.recoveryPagination = { count: this.state[3], complete: this.state[4] }; }
    this.interactive(); this.release(); this.session = session; this.state = undefined;
    this.recoveryCapabilities = capabilities;
    this.clearPages(); this.fallback.clear(); this.fallbackFacts.clear(); this.enginePage = undefined;
    this.svgDocuments.clear(); this.svgDocumentBytes = 0; this.decodedImages.clear(); this.decodedPages.clear();
    this.rasterBases.clear(); this.svgBase = undefined; this.svgPending = undefined; this.sourceFollowing = false; this.sourcePage = undefined;
    this.target = undefined; this.inverse = undefined; this.region = undefined; this.detail = undefined;
    this.destination = undefined; this.destinationPage = undefined; this.shown = undefined;
    this.ready = false; this.dirty = true; this.svgDecodeFailed = false;
    void this.post({ type: 'invalidate', retire: true, reset: true, sequence: session.previewSequence }); void this.post({ type: 'ping' });
  }

  private recoverWebview(): void {
    this.releaseViewport();
    this.session.debugPreviewRecovery?.('webview acknowledgment timeout');
    if (!this.webviewRecovery.take()) {
      this.release(); this.ready = false;
      void this.post({ type: 'error', text: 'The preview stopped responding after two recovery attempts. Restart the preview to try again.' });
      return;
    }
    this.renderIntent++; this.sourcePage = undefined;
    this.interactive(); this.release(); this.ready = false; this.dirty = true;
    this.presented.clear(); this.decodedImages.clear(); this.decodedPages.clear(); this.resident.clear();
    this.rasterBases.clear(); this.svgBase = undefined; this.svgPending = undefined;
    // VS Code ignores identical HTML assignments. A fresh document identity
    // forces reload and rejects queued ready/ACK messages from the old page.
    const previous = this.instance; this.instance = randomBytes(16).toString('hex');
    this.html = this.html.replaceAll(previous, this.instance);
    this.panel.webview.html = this.html;
  }

  handle(event: PreviewEvent): void {
    if (this.disposed) { return; }
    if ('sourceSequence' in event) {
      this.interactive(); this.clearPages(); this.enginePage = undefined; this.inverse = undefined;
      this.dirty = true; this.shown = undefined; this.target = undefined; this.region = undefined; this.detail = undefined; this.destination = undefined; this.destinationPage = undefined; this.svgDecodeFailed = false;
      void this.post({ type: 'invalidate', sequence: event.sourceSequence });
    } else if ('header' in event) {
      this.image(event);
    } else {
      switch (event[0]) {
        case 'preview-prepared': this.prewarm.handle(event); break;
        case 'preview-state':
          if (event[2] !== this.session.previewSequence || (this.state && event[1] < this.state[1])) { break; }
          if (this.state && (this.state[1] !== event[1] || this.state[2] !== event[2])) { this.interactive(); this.clearPages(); this.enginePage = undefined; }
          if (this.enginePage?.page !== event[5]) { this.enginePage = undefined; }
          this.state = event; this.recoveryPagination = undefined;
          if (event[4]) {
            this.viewportPage = Math.min(this.viewportPage, Math.max(0, event[3] - 1));
            if (this.sourcePage !== undefined && this.sourcePage >= event[3]) { this.sourcePage = undefined; }
            if (event[3] === 0) { if (this.page !== 0) { this.renderIntent++; } this.selectPage(0); this.dirty = false; }
            if (event[3] > 0 && this.page >= event[3]) { this.renderIntent++; this.selectPage(event[3] - 1); this.dirty = true; }
            this.visible = this.visible.filter(d => d.page < event[3]); this.nearby = this.nearby.filter(d => d.page < event[3]);
          }
          this.status(); this.flush(); this.prewarm.refresh();
          break;
        case 'preview-invalidated':
          if (event[2] !== this.session.previewSequence || (this.state && event[1] < this.state[1])) { break; }
          this.interactive(); this.clearPages(); this.enginePage = undefined; this.inverse = undefined;
          this.dirty = true; this.shown = undefined; this.target = undefined; this.region = undefined; this.detail = undefined; this.destination = undefined; this.destinationPage = undefined; this.svgDecodeFailed = false;
          void this.post({ type: 'invalidate', sequence: event[2], revision: event[1] });
          break;
        case 'preview-cancelled':
        case 'preview-retry':
          if (this.inFlight?.id === event[1]) { const background = this.inFlight.background; this.release(); if (!background) { this.dirty = true; } this.flush(); }
          break;
        case 'preview-error':
          if (this.inFlight?.id === event[1]) {
            // Older engines can report a failure for work superseded by a source
            // barrier. It must not swallow the newer dirty request or display a
            // transient error for source which is no longer being compiled.
            if (this.inFlight.sequence !== this.session.previewSequence || this.inFlight.revision !== this.state?.[1] ||
                this.inFlight.sequence !== this.state?.[2] || (!this.continuous && this.inFlight.page !== this.page)) {
              this.release(); this.dirty = true; this.flush(); break;
            }
            const region = this.inFlight.region, upgrade = this.inFlight.upgrade, background = this.inFlight.background, page = this.inFlight.page;
            if (!region && !upgrade && !this.inFlight.placeholder) { this.failed.add(page); }
            this.release();
            if (background) { this.flush(); break; }
            if (upgrade) { this.rememberAuto(this.page, false, this.shown?.vectorCost || 0); void this.post({ type: 'refinement-end' }); this.flush(); break; }
            if (region) { this[region.purpose] = undefined; }
            void this.post({ type: region ? 'region-error' : 'error', text: event[2], page, purpose: region?.purpose });
            if (region) { this.flush(); }
          }
          break;
        case 'preview-destination':
          if (event[1] !== this.state?.[1] || event[2] !== this.session.previewSequence || event[3] !== this.destination) { break; }
          if (event[4] < 0) { this.destination = undefined; this.destinationPage = undefined; void this.post({ type: 'link-error', text: 'This link target is not available in the document yet.' }); }
          else { this.sourcePage = undefined; this.viewportPage = event[4]; this.renderIntent++; if (this.page !== event[4]) { this.svgDecodeFailed = false; } this.selectPage(event[4]); this.destinationPage = event[4]; this.shown = undefined; this.target = undefined; this.dirty = true; this.jump({ type: 'jump', page: this.page, destination: this.destination }); this.status(); this.flush(); }
          break;
        case 'preview-forward':
          if (!this.sourceFollowing) { break; }
          this.interactive();
          this.enginePage = undefined;
          if (event[2] !== this.session.previewSequence || event[1] !== this.state?.[1]) { break; }
          this.sourcePage = event[3];
          this.target = { revision: event[1], sequence: event[2], page: event[3], x: event[4], y: event[5], highlight: this.sourceHighlight,
            ...(event[6] ? { rectangles: event[6] } : {}) };
          if (this.continuous) { this.shown = this.presented.get(event[3])?.header; this.jump({ type: 'jump', page: event[3], target: this.target }); }
          if (this.page !== event[3] || !this.shown || this.shown.revision !== event[1]) {
            if (this.page !== event[3]) { this.renderIntent++; this.svgDecodeFailed = false; }
            this.selectPage(event[3]);
            if (!this.inFlight || this.inFlight.page !== this.page || this.inFlight.revision !== event[1] || this.inFlight.region) {
              this.dirty = true;
            }
            this.flush();
          } else { void this.post({ type: 'target', ...this.target }); this.target = undefined; }
          this.prewarm.refresh(true);
          break;
      }
    }
  }

  prepareEdit(document?: vscode.TextDocument, utf16Offset = 0): void {
    const version = document?.version;
    this.prewarm.select(document ? `${document.uri.toString()}:${version ?? this.session.previewSequence}:${utf16Offset}` : undefined,
      document ? () => document.version === version ? this.session.sync.sourcePosition(document, utf16Offset) : undefined : undefined);
  }
  beginSourceFollow(explicit = false): void { this.sourceIntent++; this.sourceFollowing = true; this.sourceHighlight = explicit; this.prewarm.interrupt(); }
  interruptPreparation(): void { this.prewarm.interrupt(); }
  private manualNavigation(): void {
    this.sourcePage = undefined;
    this.renderIntent++;
    if (!this.sourceFollowing) { return; }
    this.sourceFollowing = false; this.target = undefined; this.navigated?.();
    if (this.session.previewBackground) {
      this.session.send(['preview-cancel', 0, this.page]); this.enginePage = undefined;
      // Cancel-all also retires a foreground native render, without a retry
      // acknowledgment. Release its credit so navigation can request pixels.
      if (this.inFlight) { this.release(); this.svgPending = undefined; this.dirty = true; }
    }
  }
  update(): void { if (this.session.paused) { this.interactive(); } this.status(); this.prewarm.refresh(); }
  navigate(delta: number): void {
    this.interactive(); this.destination = undefined; this.destinationPage = undefined;
    this.svgDecodeFailed = false; this.inverse = undefined; this.forceNative = false;
    let page = Math.max(0, (this.continuous ? this.viewportPage : this.page) + delta);
    if (this.state?.[4]) { page = Math.min(page, Math.max(0, this.state[3] - 1)); }
    this.selectPage(page); this.viewportPage = page; this.navigationObservation = page;
    this.manualNavigation();
    this.dirty = true; this.shown = undefined; this.region = undefined; this.detail = undefined; this.target = undefined; this.jump({ type: 'jump', page: this.page }); this.status(); this.flush();
  }

  private selectPage(page: number): void {
    // A source target can select a visible neighbor before its viewport update.
    // Keep the page paired with its own raster demand instead of rendering it at
    // the previous active page's width and immediately replacing that keyframe.
    const demand = this.continuous ? this.visible.find(d => d.page === page) || this.nearby.find(d => d.page === page) : undefined;
    this.page = page;
    if (demand) { this.width = demand.width; this.clip = demand.clip; }
  }

  private jump(message: { type: 'jump'; page: number; target?: unknown; destination?: string }): void {
    // Nearby pages have only a coarse prefetch demand. After a jump the browser
    // must first tell us the target's sharp grid/clip; rendering immediately
    // would replace a cached sharp canvas with that coarse whole-page raster.
    this.releaseViewport();
    const viewportRequest = this.continuous && this.surfaces() ? ++this.nextViewportRequest : undefined;
    this.awaitingViewport = viewportRequest;
    if (viewportRequest !== undefined) {
      this.viewportTimeout = setTimeout(() => {
        if (this.awaitingViewport === viewportRequest && !this.disposed) { this.recoverWebview(); }
      }, 10000);
    }
    void this.post({ ...message, ...(viewportRequest === undefined ? {} : { viewportRequest }) });
  }
  private releaseViewport(): void {
    clearTimeout(this.viewportTimeout); this.viewportTimeout = undefined; this.awaitingViewport = undefined;
  }

  private receive(value: unknown): void {
    if (this.disposed || !value || typeof value !== 'object') { return; }
    const m = value as Record<string, unknown>;
    if (m.instance !== this.instance || typeof m.type !== 'string') { return; }
    const pending = this.inFlight;
    // Physical SVG allocation is source-independent: a late budget rejection
    // can still prevent repeated large exports while typing. View changes and
    // content/decode failures have no such transferable evidence.
    const context = pending && m.type === 'rasterize' ? this.fallbackContext(pending.page, pending.width || this.width) : undefined;
    const budgetEvidence = m.type === 'rasterize' && m.reason === 'budget' && pending && pending.id === m.id &&
      pending.snapshot?.mime === 'image/svg+xml' && !pending.region && !pending.background && !pending.upgrade && !pending.cached &&
      pending.intent === this.renderIntent && pending.page === this.page && pending.width === this.width && sameClip(pending.clip, this.clip) && pending.format === this.format &&
      (!this.continuous || this.visible.some(demand => demand.page === pending.page)) &&
      typeof m.allocation === 'string' && m.allocation === context?.allocation &&
      (!context?.bounds || context.bounds.every((value, index) => value === pending.snapshot!.bounds[index]));
    if (!budgetEvidence && ['cache-miss', 'decode-error', 'rasterize'].includes(m.type) && pending && pending.id === m.id &&
        (pending.sequence !== this.session.previewSequence || pending.revision !== this.state?.[1] ||
          (pending.intent !== undefined && pending.intent !== this.renderIntent))) {
      // A source barrier preserves useful decodes. Its late failure must return
      // the credit without teaching the new source a codec or page failure.
      if (m.type === 'cache-miss') {
        this.decodedImages.clear(); this.decodedPages.clear(); this.rasterBases.clear(); this.svgBase = undefined;
      }
      this.svgPending = undefined;
      if (this.presented.get(pending.page)?.header.requestId === pending.id) { this.presented.delete(pending.page); }
      this.release(); if (!pending.background) { this.dirty = true; } this.flush(); return;
    }
    switch (m.type) {
      case 'interaction':
        if (typeof m.active === 'boolean') { this.gesture = m.active; }
        this.interactive(); this.prewarm.refresh(); this.scheduleUpgrade(); break;
      case 'ready':
      case 'viewport':
        if (this.awaitingViewport !== undefined && m.viewportRequest !== this.awaitingViewport) { return; }
        const activeClip = this.clipOf(m.clip, m.width);
        if (!Number.isInteger(m.page) || (m.page as number) < 0 || (m.page as number) > 100000 ||
            !Number.isFinite(m.width) || (m.width as number) < 1 || (m.width as number) > (activeClip ? 65536 : 4096)) { return; }
        this.releaseViewport();
        const previousAllocation = this.visible.find(d => d.page === this.page)?.allocation ||
          this.nearby.find(d => d.page === this.page)?.allocation || this.allocation;
        if (m.continuous === true) { this.continuous = true; }
        if (m.type === 'ready' || m.jump === true || m.scroll === true) { this.sourcePage = undefined; }
        this.viewportPage = m.page as number;
        if (this.state?.[4]) { this.viewportPage = Math.min(this.viewportPage, Math.max(0, this.state[3] - 1)); }
        let page = this.viewportPage, width = Math.round(m.width as number), clip = activeClip;
        if (this.continuous) {
          this.visible = this.demands(m.visible, 12);
          if (!this.visible.some(d => d.page === this.viewportPage)) { this.visible.unshift({ page: this.viewportPage, width, clip }); this.visible = this.visible.slice(0, 12); }
          this.nearby = this.demands(m.nearby, 2).filter(d => !this.visible.some(v => v.page === d.page));
          const source = this.sourcePage === undefined ? undefined : this.visible.find(d => d.page === this.sourcePage);
          if (source) { page = source.page; width = source.width; clip = source.clip; }
          else { this.sourcePage = undefined; }
        }
        const allocation = this.visible.find(d => d.page === page)?.allocation ||
          (typeof m.allocation === 'string' && m.allocation.length <= 256 ? m.allocation : undefined);
        const format = m.format === 'svg' && this.uiCapabilities().svg ? 'svg' : m.format === 'png' ? 'png' : 'auto';
        const changed = this.page !== page || this.width !== width || !sameClip(this.clip, clip) || this.format !== format || previousAllocation !== allocation || m.type === 'ready';
        if (changed) { this.renderIntent++; this.dirty = true; this.interactive(); }
        if (format !== this.format) { this.svgDecodeFailed = false; this.fallback.clear(); }
        if (this.page !== page) { this.inverse = undefined; this.forceNative = false; this.shown = undefined; if (m.scroll === true || m.jump === true) { this.target = undefined; } this.svgDecodeFailed = false; }
        this.format = format; this.page = page; this.width = width; this.clip = clip; this.allocation = allocation;
        if (m.type === 'ready') { this.placeholders.clear(); this.presented.clear(); this.failed.clear(); this.decodedImages.clear(); this.decodedPages.clear(); this.rasterBases.clear(); this.svgBase = undefined; this.svgPending = undefined; this.svgDom = m.svgDom === true; this.pngCanvas = m.pngCanvas === true; this.pngCanvasKnown = true; }
        if (this.continuous) {
          for (const demand of [...this.visible, ...this.nearby]) {
            if (this.fallback.has(demand.page) && !this.fallback.usePng(demand.page, this.fallbackContext(demand.page, demand.width))) {
              // Allocation alone can change while the capped PNG width remains
              // identical. Retire its presentation so the now-admissible SVG is
              // actually retried, rather than accepted as a finished PNG page.
              this.svgFailures.delete(demand.page); this.presented.delete(demand.page); this.prefetched.delete(demand.page);
            }
          }
          this.resident = new Set(Array.isArray(m.resident) ? m.resident.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 100000).slice(0, 12) : this.visible.map(d => d.page));
          if (m.scroll === true && Number.isSafeInteger(m.epoch) && m.epoch !== this.viewportEpoch) { this.frontierBudget = 1; this.prefetched.clear(); }
          if (Number.isSafeInteger(m.epoch)) { this.viewportEpoch = m.epoch as number; }
          if (m.jump === true || m.scroll === true) { this.manualNavigation(); this.destination = undefined; this.destinationPage = undefined; }
          if (m.jump === true) { this.failed.clear(); this.prefetched.clear(); }
          this.shown = this.presented.get(this.page)?.header;
          const pending = this.inFlight;
          const pendingActive = pending && !pending.region && !pending.placeholder && pending.page === this.page && pending.width === this.width && sameClip(pending.clip, this.clip) &&
            pending.revision === this.state?.[1] && pending.sequence === this.session.previewSequence && pending.format === this.format;
          this.dirty = !this.failed.has(this.page) && !pendingActive && !this.isPresented({ page: this.page, width: this.width, clip: this.clip });
          this.schedulePrefetch();
        }
        // A retained surface can become foreground after its decode ACK was
        // processed while a previous viewport was still active. Observe the
        // actual browser viewport without requiring another image/decode.
        if (this.navigationObservation === this.viewportPage &&
            this.isPresented({ page: this.viewportPage, width: Math.round(m.width as number), clip: activeClip })) {
          this.session.previewVisible?.(this.presented.get(this.viewportPage)!.header);
          this.navigationObservation = undefined;
        }
        this.ready = true; this.status(); this.flush(); this.prewarm.refresh();
        break;
      case 'decoded':
        if (!this.inFlight || m.id !== this.inFlight.id) { break; }
        if (!this.inFlight.region && !this.inFlight.placeholder) {
          const snapshot = this.inFlight.snapshot;
          const current = !this.inFlight.visualOnly && m.stale !== true && m.displayed !== false &&
            snapshot?.revision === this.state?.[1] && snapshot?.sequence === this.session.previewSequence;
          if (snapshot && m.displayed !== false) {
            const previous = this.visualSnapshots.get(snapshot.page);
            if (!previous || snapshot.sequence > previous.sequence || (snapshot.sequence === previous.sequence && snapshot.revision >= previous.revision)) {
              this.visualSnapshots.delete(snapshot.page); this.visualSnapshots.set(snapshot.page, { sequence: snapshot.sequence, revision: snapshot.revision });
              while (this.visualSnapshots.size > 64) { this.visualSnapshots.delete(this.visualSnapshots.keys().next().value as number); }
            }
          }
          const presented = this.presented.get(this.inFlight.page);
          if (current && presented?.header.requestId === m.id) {
            presented.decoded = true; this.resident.add(this.inFlight.page);
            void this.prepareTikz(presented.header);
            const id = this.inFlight.contentId;
            if (id) {
              this.decodedPages.delete(this.inFlight.page); this.decodedPages.set(this.inFlight.page, new Set([id]));
              while (this.decodedPages.size > 16) { this.decodedPages.delete(this.decodedPages.keys().next().value as number); }
            }
          }
          if (current && !this.inFlight.background && this.shown?.requestId === m.id && this.shown.page === this.page && this.inFlight.page === this.page &&
              this.shown.revision === this.state?.[1] && this.shown.sequence === this.session.previewSequence) {
            if (this.navigationObservation === this.shown.page) { this.navigationObservation = undefined; }
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
          if (!this.inFlight.background && this.svgPending && this.svgPending.id === m.id && this.svgPending.contentId === m.svg) { this.svgBase = this.svgPending; }
          else if (!this.inFlight.background && this.svgBase?.contentId !== m.svg) { this.svgBase = undefined; }
          this.svgPending = undefined;
          // Legacy speculation never identifies a raster; a surface always does, whichever slot rendered it.
          if ((!this.inFlight.background || this.inFlight.clip) && !this.inFlight.cached) {
            if (this.rasterPending?.id === m.id && this.rasterPending.contentId === m.png) { this.rasterBases.set(this.inFlight.page, this.rasterPending); }
            else { this.rasterBases.delete(this.inFlight.page); }
          }
          this.rasterPending = undefined;
        }
        if (m.id === this.inFlight?.id && Array.isArray(m.cached)) {
          this.decodedImages = new Set(m.cached.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)).slice(0, 8));
          // Page navigation must not accumulate patch metadata for canvases
          // that have already left the browser's bounded decoded cache.
          for (const [page, base] of this.rasterBases) {
            if (!this.decodedImages.has(base.contentId)) { this.rasterBases.delete(page); }
          }
        }
        if (m.id === this.inFlight?.id) {
          const request = this.inFlight;
          if (!request.region && !request.placeholder && request.page === this.destinationPage) { this.destination = undefined; this.destinationPage = undefined; }
          // A PNG metadata refresh can prove a previously rejected SVG now fits.
          // Manual SVG mode gets exactly one fresh request after this ACK, while
          // retaining the ordinary single decode credit and source barriers.
          if (request.retrySvg && this.format === 'svg' && request.revision === this.state?.[1] &&
              request.sequence === this.state?.[2] && request.sequence === this.session.previewSequence &&
              !this.fallback.has(request.page)) {
            this.presented.delete(request.page); this.prefetched.delete(request.page);
            if (request.page === this.page) { this.dirty = true; }
          }
          const foreground = !request.background && !request.placeholder && !request.cached && !request.visualOnly && m.stale !== true && m.displayed !== false &&
            request.sequence === this.session.previewSequence && request.revision === this.state?.[1];
          this.release(); this.prewarm.refresh(foreground); this.flush(); this.scheduleUpgrade(); this.schedulePrefetch();
        }
        break;
      case 'cache-miss':
        if (this.inFlight && m.id === this.inFlight.id && !this.inFlight.region) {
          const failedPage = this.inFlight.page, background = this.inFlight.background; this.presented.delete(failedPage);
          if (m.pngUnsupported === true) { this.pngCanvas = false; this.status(); }
          else if (this.inFlight.raster) { this.forceNative = true; }
          this.decodedImages.clear(); this.decodedPages.clear(); this.rasterBases.clear(); this.svgBase = undefined; this.svgPending = undefined; this.release(); if (!background) { this.dirty = true; } this.flush();
        }
        break;
      case 'decode-error':
        if (this.inFlight && m.id === this.inFlight.id) {
          if (this.inFlight.background) {
            const page = this.inFlight.page;
            if (this.presented.get(page)?.header.mime === 'image/svg+xml' && !this.svgFailures.has(page)) { this.svgFailures.add(page); }
            else { this.failed.add(page); }
            this.presented.delete(page); this.release(); this.flush(); break;
          }
          const svg = this.shown && this.shown.requestId === m.id && this.shown.mime === 'image/svg+xml';
          this.svgBase = undefined; this.svgPending = undefined; this.release();
          if (svg) { this.rememberAuto(this.page, false, this.shown?.vectorCost || 0); this.svgDecodeFailed = true; this.dirty = true; this.flush(); }
          else { this.failed.add(this.page); this.presented.delete(this.page); void this.post({ type: 'error', page: this.page, text: 'Could not decode the preview image. Restart the preview to try again.' }); }
        }
        break;
      case 'rasterize': {
        const matching = this.inFlight && m.id === this.inFlight.id && m.page === this.inFlight.page && !this.inFlight.region;
        const shown = typeof m.page === 'number' ? this.presented.get(m.page)?.header : undefined;
        if (this.continuous && (matching || (shown?.requestId === m.id && shown?.sequence === this.session.previewSequence && shown.revision === this.state?.[1]))) {
          const page = m.page as number;
          const cause = m.reason === 'budget' ? 'budget' : 'decode';
          if (cause === 'decode' && this.svgFailures.has(page)) { break; }
          if (cause === 'decode') { this.svgFailures.add(page); }
          if (typeof m.allocation === 'string' && m.allocation.length <= 256) {
            for (const demand of [...this.visible, ...this.nearby]) { if (demand.page === page) { demand.allocation = m.allocation; } }
            if (page === this.page) { this.allocation = m.allocation; }
          }
          this.fallback.reject(page, this.fallbackContext(page, (matching ? this.inFlight?.width : this.presented.get(page)?.width) || this.width, shown),
            cause, m.budget as RenderBudget | undefined);
          this.presented.delete(page); this.prefetched.delete(page);
          if (matching) { this.release(); }
          if (page === this.page) { this.dirty = true; }
          this.flush();
        }
        break;
      }
      case 'evicted':
        if (this.continuous && Number.isInteger(m.page)) { this.resident.delete(m.page as number); this.presented.delete(m.page as number); this.decodedPages.delete(m.page as number); }
        if (Array.isArray(m.cached)) { this.decodedImages = new Set(m.cached.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)).slice(0, 8)); }
        break;
      case 'link': {
        const h = this.headerFor(m.page);
        if (!this.session.previewLinks || !h || h.revision !== m.revision || h.sequence !== m.sequence ||
            h.sequence !== this.session.previewSequence || h.page !== m.page || !Number.isInteger(m.index)) { break; }
        this.interactive();
        const link = h.annotations?.links[m.index as number];
        if (!link) { break; }
        if (link.uri.startsWith('#')) {
          if (link.uri.length === 1) { break; }
          this.destination = link.uri.slice(1); this.destinationPage = undefined;
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
      case 'tikz-open': {
        const h = this.headerFor(m.page), session = this.session;
        if (!this.tikz || !h || m.revision !== h.revision || m.sequence !== h.sequence ||
            !Number.isSafeInteger(m.index) || (m.index as number) < 0 || !this.tikzCurrent(session, h)) { break; }
        void this.tikz.open(session, h, m.index as number, () => this.tikzCurrent(session, h)).catch(() => undefined);
        break;
      }
      case 'region':
      case 'detail': {
        const h = this.headerFor(m.page), b = m.bounds;
        if (this.session.previewRegions && h && m.revision === h.revision && m.sequence === this.session.previewSequence &&
            m.page === h.page && Number.isSafeInteger(m.token) && (m.token as number) >= 0 &&
            Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number' && Number.isFinite(n)) &&
            b[0] >= h.bounds[0] && b[1] >= h.bounds[1] && b[2] <= h.bounds[2] && b[3] <= h.bounds[3] &&
            b[2] > b[0] && b[3] > b[1] && Number.isFinite(m.width) && (m.width as number) >= 1 && (m.width as number) <= (m.type === 'detail' ? 4096 : 1024)) {
          this.interactive();
          this[m.type] = { page: h.page, token: m.token as number, bounds: b, width: Math.round(m.width as number), purpose: m.type };
          this.flush();
        }
        break;
      }
      case 'cancel-region': if (m.page === undefined || m.page === this.region?.page) { this.region = undefined; } break;
      case 'cancel-detail': if (m.page === undefined || m.page === this.detail?.page) { this.detail = undefined; } break;
      case 'inverse': {
        const h = this.headerFor(m.page);
        if (h && m.revision === h.revision && m.sequence === this.session.previewSequence && m.page === h.page &&
            typeof m.x === 'number' && typeof m.y === 'number' && Number.isFinite(m.x) && Number.isFinite(m.y) &&
            m.x >= h.bounds[0] && m.x <= h.bounds[2] && m.y >= h.bounds[1] && m.y <= h.bounds[3]) {
          this.interactive();
          if (this.session.previewSynctexPrecision) {
            const session = this.session, intent = this.renderIntent, sourceIntent = this.sourceIntent;
            this.session.inversePrecise(h.revision, h.sequence, h.page, m.x, m.y, () =>
              !this.disposed && this.panel.visible && this.session === session && this.renderIntent === intent && this.sourceIntent === sourceIntent &&
              this.headerFor(h.page)?.requestId === h.requestId);
          } else if (this.enginePage?.revision === h.revision && this.enginePage.sequence === h.sequence && this.enginePage.page === h.page) {
            this.session.send(['preview-inverse', h.revision, h.sequence, h.page, m.x, m.y]);
          } else {
            // A cache hit need not move the native viewer. Load its hit-testing
            // display list only when inverse search actually needs it.
            this.inverse = { revision: h.revision, sequence: h.sequence, page: h.page, x: m.x, y: m.y };
            this.forceNative = true; this.dirty ||= !this.continuous; this.flush();
          }
        }
        break;
      }
      case 'restart': case 'pause': case 'output': this.action(m.type); break;
    }
  }

  private flush(): void {
    if (!this.ready || !this.panel.visible || this.disposed || this.inFlight || this.awaitingViewport !== undefined ||
        !this.state || this.state[2] !== this.session.previewSequence || this.session.state !== 'running') { return; }
    // Page updates take priority; interactive magnification precedes background detail.
    // All requests share one frame/decode credit.
    if (this.continuous && this.state[4] && this.state[3] === 0) { this.dirty = false; return; }
    const active: PageDemand = { page: this.page, width: this.width, clip: this.clip };
    const missing = this.continuous && !this.region ? this.visible.find(d => !this.isPresented(d) && !this.failed.has(d.page)) : undefined;
    const speculative = this.continuous && !this.dirty && !missing && !this.region && !this.detail && !this.inverse && !this.upgradeReady && !this.gesture && this.prefetchReady && !this.prewarm.pending;
    // Once everything on screen is sharp and nothing else is waiting, refresh the coarse page around a
    // partial rectangle. It is off screen or in motion by definition, so it never delays visible pixels.
    const placeholder = speculative && this.surfaces() && this.session.previewBackground
      ? this.visible.find(d => d.clip && d.placeholder && !this.failed.has(d.page) && !this.placeholderCurrent(d.page) &&
        // Only a raster rectangle leaves part of its page uncovered; a vector page is sharp everywhere.
        this.presented.get(d.page)?.header.clip !== undefined) : undefined;
    const background = speculative && !placeholder
      ? this.nearby.find(d => !this.prefetched.has(d.page) && !this.isPresented(d, false) && !this.failed.has(d.page) && (d.page < this.state![3] || (!this.state![4] && d.page === this.state![3] && this.frontierBudget > 0))) : undefined;
    const inverseDemand = this.inverse ? this.visible.find(d => d.page === this.inverse!.page) : undefined;
    const demand: PageDemand | undefined = this.inverse ? inverseDemand || { page: this.inverse.page, width: this.width, clip: this.inverse.page === this.page ? this.clip : undefined }
      : this.dirty ? active : missing || background;
    if (demand) {
      this.prewarm.interrupt();
      const { page } = demand;
      // A rectangle is only meaningful to an engine and canvas that support surfaces.
      const clip = this.surfaces() ? demand.clip : undefined, width = clip ? demand.width : Math.min(demand.width, 4096);
      const secondary = !!background || (this.continuous && page !== this.page && !this.inverse);
      if (page === this.page) { this.dirty = false; }
      if (!background) {
        this.region = undefined;
        // A replacement of this same page resets the browser's detail cache.
        // Rendering another visible page must retain its queued crop: the
        // browser is still waiting for that token and will not request it again.
        if (this.detail?.page === page) { this.detail = undefined; }
      }
      if (background) { this.prefetched.add(page); }
      if (background && page >= this.state[3]) { this.frontierBudget--; }
      const learned = this.autoPages.get(page);
      // Full-mount costs cannot predict a warm edit. Only compare naturally
      // observed matching phases, viewport and page-complexity class.
      const previous = this.svgBase?.page === page || this.rasterBases.has(page);
      const context = this.costContext(page, width, this.shown?.bounds || learned?.bounds, learned?.cost);
      const preferPng = context && this.renderCosts.preferPng(context, !!previous);
      const budgetFallback = this.fallback.usePng(page, this.fallbackContext(page, width));
      const useSvg = learned?.svg && !preferPng && !budgetFallback && !this.svgFailures.has(page);
      const limit = preferPng || budgetFallback ? 0 : learned ? learned.svg ? Math.min(200000, Math.max(16000, Math.ceil(learned.cost * 1.3))) : 0 : 16000;
      const verb = budgetFallback && this.session.previewAuto ? 'preview-auto' : budgetFallback ? 'preview-render' : (secondary && this.format === 'auto') || this.svgFailures.has(page) ? 'preview-render' : this.svgDecodeFailed ? 'preview-render' : this.format === 'svg' ? 'preview-svg' :
        this.format === 'auto' && this.session.previewAuto && this.session.previewSvg ? 'preview-auto' : 'preview-render';
      const key = this.pageKey(verb === 'preview-auto' ? `auto:${limit}` : verb === 'preview-svg' ? 'svg' : 'png', page, width, clip);
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page, key, width, clip, background: secondary, format: this.format, intent: this.renderIntent };
      const cached = !this.forceNative && (verb === 'preview-auto' ?
        (useSvg ? this.pages.get(this.pageKey('svg', page, width, clip)) : undefined) || this.pages.get(key) || this.pages.get(this.pageKey('png', page, width, clip)) : this.pages.get(key));
      const rasterKey = this.pageKey('png', page, width, clip);
      const raster = !this.forceNative && (this.rasterPages.get(key) || this.rasterPages.get(rasterKey));
      const reference = raster && this.hasDecoded(raster.contentId, page) && verb !== 'preview-svg' ? raster : undefined;
      const force = this.forceNative; this.forceNative = false;
      if ((cached || reference) && this.continuous && this.session.previewBackground && !secondary && !force && this.enginePage?.page !== page) {
        this.session.send(['preview-cancel', 0, page]); this.enginePage = undefined;
      }
      if (!cached && reference) {
        this.inFlight.cached = true; this.inFlight.contentId = reference.contentId;
        this.image({ header: { ...reference.header, requestId: this.nextId }, bytes: Buffer.alloc(0) });
      } else if (cached) {
        this.cachePage(key, cached);
        this.inFlight.cached = true;
        this.image({ header: { ...cached.header, requestId: this.nextId }, bytes: cached.bytes });
      } else {
        if (!secondary || !this.session.previewBackground) { this.enginePage = undefined; }
        if (clip) {
          // One command for every codec choice, so an SVG that cannot represent the page falls back to
          // the sharp rectangle rather than to a capped whole page. Neighbours use the speculative slot
          // and are identified like the active page, so an edit that reflows them is patched too.
          const codec = verb === 'preview-svg' ? 1 : verb === 'preview-auto' ? 2 : 0;
          this.session.send(['preview-surface', this.nextId, page, width, this.state[1], this.state[2], ...clip, codec,
            codec === 2 ? limit : 0, this.baseFor(page, force), secondary && this.session.previewBackground ? 1 : 0]);
          return;
        }
        if (secondary && this.session.previewBackground) {
          this.session.send(['preview-background', this.nextId, page, width, this.state[1], this.state[2], verb === 'preview-svg' ? 1 : 0, limit]);
          return;
        }
        const patches = this.pngCanvas && this.session.previewPngPatches;
        const base = this.baseFor(page, force);
        if (verb === 'preview-auto') {
          if (patches) { this.session.send([verb, this.nextId, page, width, this.state[1], this.state[2], limit, base]); }
          else { this.session.send([verb, this.nextId, page, width, this.state[1], this.state[2], limit]); }
        } else if (verb === 'preview-render' && patches) { this.session.send(['preview-png', this.nextId, page, width, this.state[1], this.state[2], base]); }
        else { this.session.send([verb, this.nextId, page, width, this.state[1], this.state[2]]); }
      }
    } else if (placeholder) {
      this.prewarm.interrupt();
      const width = Math.min(placeholder.placeholder!, 4096);
      // Remember the attempt, not only success: a refused or failed coarse page is not worth a retry loop.
      this.placeholders.delete(placeholder.page);
      this.placeholders.set(placeholder.page, { revision: this.state[1], sequence: this.state[2], width });
      while (this.placeholders.size > 16) { this.placeholders.delete(this.placeholders.keys().next().value as number); }
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: placeholder.page, background: true, placeholder: true, width };
      this.session.send(['preview-background', this.nextId, placeholder.page, width, this.state[1], this.state[2], 0, 0]);
    } else if ((this.region || this.detail) && this.headerFor((this.region || this.detail)!.page)) {
      this.prewarm.interrupt();
      const region = (this.region || this.detail)!; this[region.purpose] = undefined;
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: region.page, region };
      const b = region.bounds;
      this.enginePage = undefined;
      this.session.send(['preview-region', this.nextId, region.page, region.width, this.state[1], this.state[2], b[0], b[1], b[2], b[3]]);
    } else if (this.upgradeReady && this.canUpgrade()) {
      this.upgradeReady = false;
      this.inFlight = { id: ++this.nextId, revision: this.state[1], sequence: this.state[2], page: this.page,
        key: this.pageKey('svg'), upgrade: true, width: this.width, format: this.format };
      const cached = this.pages.get(this.pageKey('svg'));
      const clip = this.surfaces() ? this.clip : undefined;
      this.inFlight.clip = clip;
      if (cached) {
        this.inFlight.cached = true;
        this.image({ header: { ...cached.header, requestId: this.nextId }, bytes: cached.bytes });
      } else if (clip) { this.session.send(['preview-surface', this.nextId, this.page, this.width, this.state[1], this.state[2], ...clip, 1, 0, 0, 0]); }
      else { this.session.send(['preview-svg', this.nextId, this.page, Math.min(this.width, 4096), this.state[1], this.state[2]]); }
    }
  }

  private image(frame: PreviewImage): void {
    const started = performance.now();
    const h = frame.header, request = this.inFlight;
    if (!request || h.requestId !== request.id) { return; }
    if (request.placeholder) {
      // Coarse pixels for the current source only; they carry no metadata and never become the page.
      if (!this.ready || !this.panel.visible || h.mime !== 'image/png' || h.page !== request.page ||
          h.sequence !== this.session.previewSequence || h.revision !== this.state?.[1]) { this.release(); this.flush(); return; }
      this.decodeTimeout = setTimeout(() => { this.recoverWebview(); }, 10000);
      void this.post({ type: 'placeholder', page: h.page, bytes: new Uint8Array(frame.bytes).buffer,
        header: { requestId: h.requestId, page: h.page, revision: h.revision, sequence: h.sequence, mime: h.mime, width: h.width, height: h.height } })
        .then(delivered => { if (!delivered && this.inFlight?.id === h.requestId) { this.release(); this.ready = false; this.dirty = true; } });
      return;
    }
    // An obsolete viewport can still supply a useful page/size for a later
    // revisit. Never retain it across a source barrier or engine revision.
    if (!h.patch && !request.cached && request.key && h.sequence === this.session.previewSequence &&
        h.revision === this.state?.[1] && h.page === request.page) { this.cachePage(request.key, frame); this.cachePage(this.pageKey(h.mime === 'image/svg+xml' ? 'svg' : 'png', h.page, request.width, request.clip), frame); }
    const currentSource = h.sequence === this.session.previewSequence && h.revision === this.state?.[1];
    const lastVisual = this.visualSnapshots.get(h.page);
    const monotonic = !lastVisual || h.sequence > lastVisual.sequence || (h.sequence === lastVisual.sequence && h.revision >= lastVisual.revision);
    const visualOnly = !currentSource && !request.region && !request.background && !request.upgrade && !request.cached &&
      request.intent === this.renderIntent && request.page === this.page && request.width === this.width && sameClip(request.clip, this.clip) && request.format === this.format &&
      (!this.continuous || this.visible.some(demand => demand.page === h.page)) &&
      h.sequence === request.sequence && h.revision === request.revision && h.sequence <= this.session.previewSequence && monotonic;
    if (this.surfaces() && request.background && !request.region && !request.clip && h.mime === 'image/png' &&
        this.presented.get(h.page)?.header.clip) {
      // A late coarse prefetch may be cached, but cannot replace sharp pixels
      // already held for that page, even while they are stale during an edit.
      this.release(); this.flush(); return;
    }
    if (!this.ready || !this.panel.visible || (!currentSource && !visualOnly) ||
        (!this.continuous && request.page !== this.page) || h.page !== request.page || (this.dirty && request.page === this.page && !visualOnly)) {
      this.release(); if (!request.background) { this.dirty = true; } this.flush(); return;
    }
    request.visualOnly = visualOnly;
    if (!visualOnly && !request.cached && !request.background) {
      this.enginePage = { revision: h.revision, sequence: h.sequence, page: h.page };
    }
    if (!this.continuous) { this.page = h.page; }
    if (!request.region && !visualOnly) {
      this.fallbackFacts.delete(h.page);
      this.fallbackFacts.set(h.page, { bounds: h.bounds, complexity: h.vectorCost });
      while (this.fallbackFacts.size > 64) { this.fallbackFacts.delete(this.fallbackFacts.keys().next().value as number); }
      const budgetRejected = this.fallback.cause(h.page) === 'budget';
      const remainsRejected = this.fallback.usePng(h.page, this.fallbackContext(h.page, request.width || this.width, h));
      request.retrySvg = budgetRejected && !remainsRejected && !request.cached && h.mime === 'image/png' && request.format === 'svg';
    }
    if (!request.region && (this.svgDecodeFailed || this.svgFailures.has(h.page))) { h.fallback = this.svgDecodeFailed ? 'SVG could not be decoded by the preview' : 'SVG exceeded the preview budget or could not be decoded'; }
    // Buffer.buffer may expose a larger pooled allocation. Send only image bytes.
    const prepared = this.svgDom && !request.region && h.mime === 'image/svg+xml' ? this.prepareSvg(frame.bytes) : undefined;
    if (request.upgrade && (!prepared?.document || h.mime !== 'image/svg+xml')) {
      this.rememberAuto(this.page, false, h.vectorCost || this.shown?.vectorCost || 0);
      void this.post({ type: 'refinement-end' }); this.release(); this.flush(); return;
    }
    const svgDocument = prepared?.document, payload = prepared?.bytes || frame.bytes;
    const displayHeader = { ...h, byteLength: payload.length };
    request.snapshot = displayHeader;
    if (!request.region) {
      if (h.page === this.page) { this.shown = displayHeader; }
      this.presented.delete(h.page); this.presented.set(h.page, { header: displayHeader, width: request.width || this.width, format: request.format || this.format, decoded: false, clip: request.clip });
      while (this.presented.size > 16) { this.presented.delete(this.presented.keys().next().value as number); }
    }
    let rasterPatch: { base: string; rect: number[] } | undefined;
    if (h.patch) {
      const base = this.rasterBases.get(h.page);
      const sameRect = (a?: number[], b?: number[]) => a === b || (!!a && !!b && a.length === b.length && a.every((n, i) => n === b[i]));
      if (!this.pngCanvas || !base || h.patch.base !== base.rasterId || h.page !== base.page ||
          h.width !== base.width || h.height !== base.height || h.bounds.some((n, i) => n !== base.bounds[i]) ||
          !sameRect(h.grid, base.grid) || !sameRect(h.clip, base.clip) || !this.decodedImages.has(base.contentId)) {
        // The canvas this patch describes is not the one on screen: ask for complete pixels.
        this.rasterBases.delete(h.page); this.forceNative = true; this.release();
        if (!request.background) { this.dirty = true; } else { this.presented.delete(h.page); }
        this.flush(); return;
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
    request.raster = !request.region && this.pngCanvas && h.mime === 'image/png';
    this.rasterPending = request.raster && h.rasterId !== undefined && (!request.background || !!h.clip) && contentId
      ? { id: h.requestId, rasterId: h.rasterId!, contentId, page: h.page, width: h.width, height: h.height, bounds: h.bounds, grid: h.grid, clip: h.clip } : undefined;
    if (!visualOnly && request.raster && contentId && request.key) {
      const cachedHeader = { ...displayHeader }; delete cachedHeader.patch;
      for (const key of [request.key, this.pageKey('png', h.page, request.width, request.clip)]) {
        this.rasterPages.delete(key); this.rasterPages.set(key, { header: cachedHeader, contentId });
      }
      while (this.rasterPages.size > 8) { this.rasterPages.delete(this.rasterPages.keys().next().value as string); }
    }
    const svgPatch = !request.background && svgDocument && contentId && !this.hasDecoded(contentId, h.page) && this.svgBase?.page === h.page && (!this.continuous || this.hasDecoded(this.svgBase.contentId, h.page))
      ? diffSvg(this.svgBase.document, svgDocument, this.svgBase.contentId) : undefined;
    request.patched = !!svgPatch;
    // A native frame can still be a decoded-content hit or a no-op patch. Its
    // near-zero browser work is neither a full mount nor a meaningful edit.
    request.costContext = visualOnly || request.background || (contentId && this.hasDecoded(contentId, h.page)) || (svgPatch?.operations.length === 0 && !svgPatch.transforms?.length) ||
      (h.patch && !h.byteLength) ? undefined : this.costContext(h.page, request.width || this.width, h.bounds,
      h.vectorCost ?? this.autoPages.get(h.page)?.cost);
    this.svgPending = svgDocument && contentId ? { id: h.requestId, page: h.page, contentId, document: svgDocument } : undefined;
    const bytes = (contentId && this.hasDecoded(contentId, h.page)) || svgPatch || request.contentId ? undefined : new Uint8Array(payload).buffer;
    request.contentId = contentId;
    if (!request.cached && this.inverse && this.inverse.revision === h.revision &&
        this.inverse.sequence === h.sequence && this.inverse.page === h.page) {
      const point = this.inverse; this.inverse = undefined;
      this.session.send(['preview-inverse', h.revision, h.sequence, h.page, point.x, point.y]);
    }
    request.processingMs = performance.now() - started;
    this.decodeTimeout = setTimeout(() => {
      this.recoverWebview();
    }, 10000);
    const target = !visualOnly && this.target?.page === h.page && this.target.revision === h.revision &&
      this.target.sequence === h.sequence ? this.target : undefined;
    if (target && !request.region) { this.target = undefined; }
    void this.post(request.region ? { type: request.region.purpose, header: displayHeader, bytes, token: request.region.token } :
      { type: 'image', header: displayHeader, bytes, contentId, inlineSvg: !!svgDocument, inlinePng: request.raster, rasterPatch, svgPatch, target, destination: !visualOnly && h.page === this.destinationPage ? this.destination : undefined, visualOnly, background: !!request.background, refining: this.canUpgrade() })
      .then(delivered => { if (!delivered && this.inFlight?.id === h.requestId) { this.release(); this.ready = false; this.dirty = true; } });
    this.status();
  }

  /** Surfaces need the engine capability and a canvas to place the rectangle on. */
  private surfaces(): boolean { return !!this.session.previewSurfaces && this.pngCanvas && !!this.session.previewPngPatches; }
  /**
   * What the webview is told to lay out for. Until it has announced its canvas support the answer is the
   * engine's, so a fresh page starts on the device grid instead of switching layouts after its first frame.
   */
  private surfacesOffered(): boolean {
    return !!this.session.previewSurfaces && !!this.session.previewPngPatches && (this.pngCanvas || !this.pngCanvasKnown);
  }
  private baseFor(page: number, force: boolean): number {
    const base = this.rasterBases.get(page);
    return !force && base && this.decodedImages.has(base.contentId) ? base.rasterId : 0;
  }
  private placeholderCurrent(page: number): boolean {
    const p = this.placeholders.get(page);
    return !!p && p.revision === this.state?.[1] && p.sequence === this.state?.[2];
  }
  /** A webview-supplied rectangle of the grid `width`, or undefined unless it is one this session can render. */
  private clipOf(value: unknown, width: unknown): Clip | undefined {
    if (!this.session.previewSurfaces || !Array.isArray(value) || value.length !== 4 || !value.every(n => Number.isSafeInteger(n) && n >= 0) ||
        !Number.isSafeInteger(width)) { return undefined; }
    const [x0, y0, x1, y1] = value as Clip;
    return x1 > x0 && y1 > y0 && x1 <= (width as number) && (width as number) <= 65536 && y1 <= 1048576 && x1 - x0 <= 8192 && y1 - y0 <= 8192 &&
      (x1 - x0) * (y1 - y0) <= this.session.previewMaxPixels ? [x0, y0, x1, y1] : undefined;
  }
  private hasDecoded(id: string, page: number): boolean {
    return this.decodedImages.has(id) && (!this.continuous || this.decodedPages.get(page)?.has(id) === true);
  }
  private fallbackContext(page: number, width: number, header?: PreviewImageHeader): FallbackContext {
    const demand = this.visible.find(d => d.page === page) || this.nearby.find(d => d.page === page);
    const facts = this.fallbackFacts.get(page);
    return { width, bounds: header?.bounds || facts?.bounds,
      complexity: header?.vectorCost ?? facts?.complexity,
      allocation: demand?.allocation || (page === this.page ? this.allocation : undefined) };
  }
  private demands(value: unknown, limit: number): PageDemand[] {
    if (!Array.isArray(value)) { return []; }
    const seen = new Set<number>();
    return value.slice(0, limit).filter((d): d is PageDemand => !!d && typeof d === 'object' &&
      Number.isInteger(d.page) && d.page >= 0 && d.page <= 100000 && Number.isFinite(d.width) && d.width >= 1 && d.width <= (this.clipOf(d.clip, d.width) ? 65536 : 4096) &&
      (!this.state?.[4] || d.page < this.state[3]) && !seen.has(d.page) && !!seen.add(d.page)).map(d => {
      const clip = this.clipOf(d.clip, d.width);
      return { page: d.page, width: Math.round(d.width), allocation: typeof d.allocation === 'string' && d.allocation.length <= 256 ? d.allocation : undefined,
        ...(clip ? { clip } : {}),
        ...(clip && Number.isFinite(d.placeholder) && d.placeholder! >= 1 && d.placeholder! <= 4096 ? { placeholder: Math.round(d.placeholder!) } : {}) };
    });
  }
  private isPresented(d: PageDemand, resident = true): boolean {
    const p = this.presented.get(d.page);
    return !!p && p.decoded && p.header.revision === this.state?.[1] && p.header.sequence === this.session.previewSequence &&
      ((p.width === d.width && sameClip(p.clip, d.clip)) || p.header.mime === 'image/svg+xml') && p.format === this.format && (!resident || this.resident.has(d.page));
  }
  private headerFor(page: unknown): PreviewImageHeader | undefined {
    const header = this.continuous && typeof page === 'number' ? this.presented.get(page)?.header : this.shown;
    return header?.revision === this.state?.[1] && header?.sequence === this.session.previewSequence ? header : undefined;
  }
  private cancelPrefetch(): void {
    clearTimeout(this.prefetchTimer); this.prefetchTimer = undefined; this.prefetchReady = false;
  }
  private schedulePrefetch(): void {
    if (this.prewarm.pending || this.prefetchTimer || !this.continuous || this.gesture || !this.ready || !this.panel.visible || this.session.paused) { return; }
    // Speculation must be cancellable and preserve the foreground raster.
    // Older engines still render every visible page, without speculative demand.
    if (!this.session.previewBackground) { return; }
    this.prefetchTimer = setTimeout(() => { this.prefetchTimer = undefined; this.prefetchReady = true; this.flush(); }, 150);
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

  private pageKey(codec: string, page = this.page, width = this.width, clip = page === this.page ? this.clip : undefined): string {
    return `${this.state![1]}:${this.state![2]}:${page}:${codec === 'svg' ? 0 : clip ? `${width}@${clip.join(',')}` : width}:${codec}`;
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
    this.prewarm.interrupt();
    clearTimeout(this.upgradeTimer); this.upgradeTimer = undefined; this.upgradeReady = false;
    // A background request may be superseded. Late frames/ACKs cannot consume
    // the foreground request's credit, and the native pending slot is replaceable.
    this.cancelPrefetch();
    if (this.inFlight?.background) {
      if (this.session.previewBackground) { this.session.send(['preview-cancel', this.inFlight.id, this.page]); }
      this.release();
    }
    if (this.inFlight?.upgrade) { this.release(); this.svgPending = undefined; }
  }
  private canUpgrade(): boolean {
    const h = this.shown, learned = this.autoPages.get(this.page);
    const context = this.costContext(this.page, this.width, h?.bounds || learned?.bounds, learned?.cost);
    // Keep the comparison raster when PNG is measurably better for edits.
    // An idle SVG would discard that native base and force a full PNG next time.
    if (context && (this.renderCosts.preferPng(context, true) || this.renderCosts.preferPng(context, false))) { return false; }
    return !this.fallback.usePng(this.page, this.fallbackContext(this.page, this.width, h)) && !this.prewarm.pending && !this.gesture && this.format === 'auto' && this.session.previewSvg && this.svgDom && !this.svgDecodeFailed &&
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

  private clearPages(): void { this.fallback.sourceChanged(); this.presented.clear(); this.failed.clear(); this.svgFailures.clear(); this.prefetched.clear(); this.cancelPrefetch(); this.rasterPages.clear(); this.pages.clear(); this.pageBytes = 0; this.inverse = undefined; this.forceNative = false; }
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

  private uiCapabilities(): { regions: boolean; svg: boolean; links: boolean; surfaces?: boolean; maxPixels?: number } {
    // A replacement has false defaults until its capability probe completes.
    // Publishing those defaults would change a saved SVG selection to PNG.
    if (this.session.state === 'starting' && this.recoveryCapabilities) { return this.recoveryCapabilities; }
    this.recoveryCapabilities = undefined;
    return { regions: !!this.session.previewRegions, svg: !!this.session.previewSvg, links: !!this.session.previewLinks,
      surfaces: this.surfacesOffered(), maxPixels: this.session.previewMaxPixels };
  }
  private status(): void {
    void this.post({ type: 'state', page: this.continuous ? this.viewportPage : this.page, count: this.state?.[3] ?? this.recoveryPagination?.count ?? 0,
      complete: this.state?.[4] ?? this.recoveryPagination?.complete ?? false,
      renderingFormat: this.renderingFormat,
      ...this.uiCapabilities(), sequence: this.session.previewSequence, revision: this.state?.[2] === this.session.previewSequence ? this.state[1] : undefined, paused: this.session.paused, phase: this.session.state });
  }
  setRenderingFormat(format: 'auto' | 'png' | 'svg'): void {
    this.renderingFormat = ['auto', 'png', 'svg'].includes(format) ? format : 'png';
    this.status();
  }
  private post(message: object): Promise<boolean> {
    return this.disposed ? Promise.resolve(false) : Promise.resolve(
      this.panel.webview.postMessage({ instance: this.instance, ...message })).catch(() => false);
  }
  private tikzCurrent(session: TexpressoSession, h: PreviewImageHeader): boolean {
    return !this.disposed && this.panel.visible && this.session === session && session.state === 'running' &&
      h.revision === this.state?.[1] && h.sequence === this.state?.[2] && h.sequence === session.previewSequence &&
      this.headerFor(h.page)?.requestId === h.requestId;
  }
  private async prepareTikz(h: PreviewImageHeader): Promise<void> {
    const session = this.session;
    if (!this.tikz || !h.annotations?.figures?.length || !this.tikzCurrent(session, h)) { return; }
    const indices = await this.tikz.prepare(session, h).catch(() => []);
    if (this.tikzCurrent(session, h)) {
      await this.post({ type: 'tikz-targets', page: h.page, id: h.requestId, revision: h.revision, sequence: h.sequence, indices });
    }
  }
  private release(): void { clearTimeout(this.decodeTimeout); this.decodeTimeout = undefined; this.inFlight = undefined; this.rasterPending = undefined; }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.releaseViewport(); this.interactive(); this.cancelPrefetch(); this.release(); this.clearPages(); this.svgDocuments.clear(); this.svgDocumentBytes = 0; this.decodedImages.clear(); this.decodedPages.clear(); this.rasterBases.clear(); this.svgBase = undefined; this.svgPending = undefined; this.panel.dispose(); } }
}
