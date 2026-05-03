/// <reference lib="dom" />
// @ts-nocheck
// TeXpresso Webview Frontend

declare function acquireVsCodeApi(): any;
const vscode = acquireVsCodeApi();

// ---- i18n ----
const i18nData: Record<string, Record<string, string>> = {
    zh: {
        home: '首页', prevPage: '前一页', nextPage: '后一页',
        endPage: '末页', pageInput: '页码', totalPages: '总页数',
        resetZoom: '重置缩放', options: '选项',
        fitWidth: '适应宽度', fitHeight: '适应高度',
        disableSynctex: '关闭 SyncTeX', enableSynctex: '开启 SyncTeX',
        darkMode: '深色模式', lightMode: '浅色模式',
        language: 'English', loading: '渲染中…',
    },
    en: {
        home: 'Home', prevPage: 'Prev', nextPage: 'Next',
        endPage: 'End', pageInput: 'Page', totalPages: 'total',
        resetZoom: 'Reset Zoom', options: 'Options',
        fitWidth: 'Fit Width', fitHeight: 'Fit Height',
        disableSynctex: 'Disable SyncTeX', enableSynctex: 'Enable SyncTeX',
        darkMode: 'Dark Mode', lightMode: 'Light Mode',
        language: '中文', loading: 'Rendering…',
    },
};
let locale: 'zh' | 'en' = 'zh';
function t(key: string): string { return i18nData[locale][key] || key; }
function updateLocale() {
    const btnHome = document.getElementById('btn-home')!;
    btnHome.title = t('home');
    document.getElementById('btn-prev')!.title = t('prevPage');
    document.getElementById('btn-next')!.title = t('nextPage');
    document.getElementById('btn-end')!.title = t('endPage');
    (document.getElementById('page-input') as HTMLInputElement).title = t('pageInput');
    document.getElementById('total-pages')!.title = t('totalPages');
    document.getElementById('btn-zoom-reset')!.title = t('resetZoom');
    document.getElementById('btn-options')!.textContent = t('options') + ' ▾';
    document.getElementById('btn-fit-width')!.textContent = t('fitWidth');
    document.getElementById('btn-fit-height')!.textContent = t('fitHeight');
    const btnST = document.getElementById('btn-disable-synctex');
    if (btnST) btnST.textContent = synctexEnabled ? t('disableSynctex') : t('enableSynctex');
    const btnDM = document.getElementById('btn-dark-mode');
    if (btnDM) btnDM.textContent = darkMode ? t('lightMode') : t('darkMode');
    document.getElementById('btn-language')!.textContent = t('language');
    const ld = document.getElementById('loading');
    if (ld) ld.textContent = t('loading');
    try { localStorage.setItem('texpresso-locale', locale); } catch (_) { }
}

const saved = (() => { try { return localStorage.getItem('texpresso-locale'); } catch (_) { return null; } })();
if (saved === 'en' || saved === 'zh') locale = saved;

// ---- QOI Decoder ----
function decodeQOI(data: Uint8Array): { pixels: Uint8ClampedArray; width: number; height: number } {
    if (data[0] !== 113 || data[1] !== 111 || data[2] !== 105 || data[3] !== 102) {
        throw new Error('Not a QOI file');
    }
    const width = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
    const height = (data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11];
    const channels = data[12];
    const len = width * height * 4;
    const pixels = new Uint8ClampedArray(len);
    const index: [number, number, number, number][] = new Array(64).fill(null).map(() => [0, 0, 0, 255]);
    let r = 0, g = 0, b = 0, a = 255;
    let p = 14, run = 0;
    const size = data.length - 8;
    for (let pos = 0; pos < len; pos += 4) {
        if (run > 0) { run--; }
        else if (p < size) {
            const b1 = data[p++];
            if (b1 === 0xfe) { r = data[p++]; g = data[p++]; b = data[p++]; }
            else if (b1 === 0xff) { r = data[p++]; g = data[p++]; b = data[p++]; a = data[p++]; }
            else {
                const tag = b1 >> 6;
                if (tag === 0) { const idx = b1 & 0x3f;[r, g, b, a] = index[idx]; }
                else if (tag === 1) { r += ((b1 >> 4) & 3) - 2; g += ((b1 >> 2) & 3) - 2; b += (b1 & 3) - 2; r &= 255; g &= 255; b &= 255; }
                else if (tag === 2) { const b2 = data[p++]; const dg = (b1 & 0x3f) - 32; const drdg = ((b2 >> 4) & 0xf) - 8; const dbdg = (b2 & 0xf) - 8; g = (g + dg) & 255; r = (r + g + drdg - (g - dg)) & 255; b = (b + g + dbdg - (g - dg)) & 255; }
                else { run = b1 & 0x3f; }
            }
            const idx = (r * 3 + g * 5 + b * 7 + a * 11) % 64;
            index[idx] = [r, g, b, a];
        }
        pixels[pos] = r;
        pixels[pos + 1] = g;
        pixels[pos + 2] = b;
        pixels[pos + 3] = a;
    }
    return { pixels, width, height };
}

// ---- View State ----
const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const container = document.getElementById('canvas-container')!;
const ctx = canvas.getContext('2d')!;

let currentPage = 0;
let totalPages = 1;
let pageWidth = 612;
let pageHeight = 792;
let renderWidth = 612;
let renderHeight = 792;
let pageImage: ImageBitmap | null = null;
let fitMode: 'width' | 'height' | 'custom' = 'width';
let zoomLevel = 1;         // display zoom (1.0 = fit-width)
let resMultiplier = 2.5;   // C-side render resolution multiplier
let maxResCap = 12;        // maximum resolution multiplier (configurable)
let panX = 0, panY = 0;
let darkMode = false;
let scrollSpeed = 0.3;
let synctexEnabled = true;
let isPanning = false;
let panStartX = 0, panStartY = 0, panStartPanX = 0, panStartPanY = 0;
let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
let zoomDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
let smoothScrollAnim: number | null = null;
let scrollVelocity = 0;
let scrollVelocityX = 0;

// LRU cache
const CACHE_SIZE = 10;
const pageCache: Map<string, ImageBitmap> = new Map();
function cacheKey(page: number, rw: number, rh: number): string { return `${page}-${rw}-${rh}`; }

function resizeCanvas() {
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = rect.height * (window.devicePixelRatio || 1);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    render();
}

function getDisplayScale(): number {
    if (!pageImage) return 1;
    const cw = canvas.width / (window.devicePixelRatio || 1);
    const ch = canvas.height / (window.devicePixelRatio || 1);
    if (fitMode === 'width') return cw / pageImage.width;
    if (fitMode === 'height') return ch / pageImage.height;
    return (cw / pageImage.width) * zoomLevel;
}

function requestResolution() {
    // Non-linear: sub-linear resolution growth to avoid excessive load
    // zoom 1x -> 1x, zoom 2x -> 1.5x, zoom 4x -> 2x, max configurable
    const effectiveZoom = fitMode === 'custom' ? zoomLevel : 1;
    const dampedZoom = effectiveZoom <= 1
        ? effectiveZoom
        : 1 + Math.sqrt(effectiveZoom - 1) * 0.7;
    const cappedZoom = Math.min(dampedZoom, maxResCap);
    const targetW = Math.round(pageWidth * resMultiplier * cappedZoom);
    const targetH = Math.round(pageHeight * resMultiplier * cappedZoom);
    if (Math.abs(targetW - renderWidth) > renderWidth * 0.15 ||
        Math.abs(targetH - renderHeight) > renderHeight * 0.15) {
        if (zoomDebounceTimeout) clearTimeout(zoomDebounceTimeout);
        zoomDebounceTimeout = setTimeout(() => {
            vscode.postMessage({ type: 'set-output-size', width: targetW, height: targetH });
        }, 250);
    }
    // Update resolution input immediately
    const resInp = document.getElementById('res-input') as HTMLInputElement;
    if (resInp && pageWidth > 0) {
        const expectedMult = (targetW / pageWidth);
        resInp.value = expectedMult.toFixed(2);
    }
}

function render() {
    const cw = canvas.width / (window.devicePixelRatio || 1);
    const ch = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, cw, ch);

    if (!pageImage) return;

    const scale = getDisplayScale();
    const iw = pageImage.width * scale;
    const ih = pageImage.height * scale;
    const ox = panX + (cw - iw) / 2;
    const oy = panY + (ch - ih) / 2;

    ctx.drawImage(pageImage, ox, oy, iw, ih);
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

async function loadQOIBase64(qoiBase64: string): Promise<void> {
    const cacheK = cacheKey(currentPage, renderWidth, renderHeight);
    const cached = pageCache.get(cacheK);
    if (cached) {
        pageImage = cached;
        render();
        // Hide loading on cache hit too
        const ld = document.getElementById('loading');
        if (ld) ld.style.display = 'none';
        return;
    }

    const data = base64ToUint8Array(qoiBase64);
    const decoded = decodeQOI(data);
    const imgData = new ImageData(decoded.pixels, decoded.width, decoded.height);
    const bitmap = await createImageBitmap(imgData);

    pageImage = bitmap;
    if (pageCache.size >= CACHE_SIZE) {
        const firstKey = pageCache.keys().next().value;
        pageCache.delete(firstKey);
    }
    pageCache.set(cacheK, bitmap);
    render();
    const ld = document.getElementById('loading');
    if (ld) ld.style.display = 'none';
}

async function loadQOI(qoiUri: string): Promise<void> {
    const cacheK = cacheKey(currentPage, renderWidth, renderHeight);
    const cached = pageCache.get(cacheK);
    if (cached) {
        pageImage = cached;
        render();
        const ld = document.getElementById('loading');
        if (ld) ld.style.display = 'none';
        return;
    }

    const resp = await fetch(qoiUri);
    const buf = await resp.arrayBuffer();
    const data = new Uint8Array(buf);
    const decoded = decodeQOI(data);
    const imgData = new ImageData(decoded.pixels, decoded.width, decoded.height);
    const bitmap = await createImageBitmap(imgData);

    pageImage = bitmap;
    if (pageCache.size >= CACHE_SIZE) {
        const firstKey = pageCache.keys().next().value;
        pageCache.delete(firstKey);
    }
    pageCache.set(cacheK, bitmap);
    render();
    const ld = document.getElementById('loading');
    if (ld) ld.style.display = 'none';
}

async function applyDirtyRects(rects: any[]): Promise<void> {
    if (!rects || rects.length === 0) return;
    if (!pageImage) return;

    // Composite dirty rects into pageImage on an offscreen canvas,
    // so that subsequent render() calls (e.g. from panning) use the
    // updated image instead of reverting to the original.
    const offscreen = document.createElement('canvas');
    offscreen.width = pageImage.width;
    offscreen.height = pageImage.height;
    const octx = offscreen.getContext('2d')!;
    octx.drawImage(pageImage, 0, 0);

    for (const rect of rects) {
        const data = base64ToUint8Array(rect.qoiBase64);
        const decoded = decodeQOI(data);
        const imgData = new ImageData(decoded.pixels, decoded.width, decoded.height);
        const bitmap = await createImageBitmap(imgData);
        octx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h);
        bitmap.close();
    }

    const updated = await createImageBitmap(offscreen);
    pageImage = updated;
    const cacheK = cacheKey(currentPage, renderWidth, renderHeight);
    pageCache.set(cacheK, updated);
    render();
}

function screenToDocument(cx: number, cy: number): { docX: number; docY: number } {
    // cx, cy are in CSS pixel space (already divided by dpr)
    const cw = canvas.width / (window.devicePixelRatio || 1);
    const ch = canvas.height / (window.devicePixelRatio || 1);
    if (!pageImage) return { docX: 0, docY: 0 };

    const scale = getDisplayScale();
    const iw = pageImage.width * scale;
    const ih = pageImage.height * scale;
    // Image offset on canvas (CSS pixels)
    const ox = panX + (cw - iw) / 2;
    const oy = panY + (ch - ih) / 2;
    // Position within the rendered image (in image pixels)
    const imgX = (cx - ox) / scale;
    const imgY = (cy - oy) / scale;
    // Convert image pixels to TeX points (document coordinates)
    return {
        docX: (imgX / renderWidth) * pageWidth,
        docY: (imgY / renderHeight) * pageHeight,
    };
}

function applySmoothScroll() {
    const vy = Math.abs(scrollVelocity);
    const vx = Math.abs(scrollVelocityX);
    if (vy < scrollSpeed && vx < scrollSpeed) {
        scrollVelocity = 0;
        scrollVelocityX = 0;
        smoothScrollAnim = null;
        return;
    }
    if (vy >= scrollSpeed) {
        panY -= scrollVelocity;
        scrollVelocity *= 0.92;
    }
    if (vx >= scrollSpeed) {
        panX -= scrollVelocityX;
        scrollVelocityX *= 0.92;
    }
    clampPan();
    render();
    smoothScrollAnim = requestAnimationFrame(applySmoothScroll);
}

function clampPan() {
    if (!pageImage) return;
    const cw = canvas.width / (window.devicePixelRatio || 1);
    const ch = canvas.height / (window.devicePixelRatio || 1);
    const scale = getDisplayScale();
    const iw = pageImage.width * scale;
    const ih = pageImage.height * scale;
    // Clamp pan to keep image edges within canvas bounds
    // (No black background visible beyond page edges)
    const maxPanX = Math.max(0, (iw - cw) / 2);
    const maxPanY = Math.max(0, (ih - ch) / 2);
    if (iw <= cw) {
        panX = 0;
    } else {
        panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
    }
    if (ih <= ch) {
        panY = 0;
    } else {
        panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
    }
}

// ---- Event Handlers ----
container.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
        // Ctrl+wheel: multiplicative zoom centered on cursor
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (fitMode !== 'custom') {
            fitMode = 'custom';
            zoomLevel = 1;
        }

        // Exact inverse zoom factors to prevent drift
        const zoomFactor = e.deltaY > 0 ? (1.0 / 1.025) : 1.025;
        const oldZoom = zoomLevel;
        zoomLevel = Math.max(0.1, Math.min(20, zoomLevel * zoomFactor));
        const r = zoomLevel / oldZoom;

        const cw = canvas.width / (window.devicePixelRatio || 1);
        const ch = canvas.height / (window.devicePixelRatio || 1);

        // Compute image offset before zoom, then cursor-center it
        const oldScale = getDisplayScale();
        const newScale = (cw / pageImage!.width) * zoomLevel;
        const scaleRatio = newScale / oldScale;

        // Image offset in CSS pixels before zoom
        const oldIw = pageImage!.width * oldScale;
        const oldIh = pageImage!.height * oldScale;
        const oldOx = panX + (cw - oldIw) / 2;
        const oldOy = panY + (ch - oldIh) / 2;

        // New offset after zoom (cursor-centered)
        const newOx = oldOx * scaleRatio + mx * (1 - scaleRatio);
        const newOy = oldOy * scaleRatio + my * (1 - scaleRatio);

        // New pan values
        const newIw = pageImage!.width * newScale;
        const newIh = pageImage!.height * newScale;
        panX = newOx - (cw - newIw) / 2;
        panY = newOy - (ch - newIh) / 2;

        clampPan();
        render();
        requestResolution();
    } else {
        // No Ctrl: smooth scroll vertically and horizontally
        e.preventDefault();
        const dy = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 40) * scrollSpeed;
        scrollVelocity += dy;
        scrollVelocity = Math.max(-8, Math.min(8, scrollVelocity));
        if (e.deltaX) {
            const dx = Math.sign(e.deltaX) * Math.min(Math.abs(e.deltaX), 40) * scrollSpeed;
            scrollVelocityX += dx;
            scrollVelocityX = Math.max(-8, Math.min(8, scrollVelocityX));
        }
        if (!smoothScrollAnim) {
            smoothScrollAnim = requestAnimationFrame(applySmoothScroll);
        }
    }
}, { passive: false });

container.addEventListener('mousedown', (e) => {
    if (e.ctrlKey || e.button === 1) {
        isPanning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panStartPanX = panX;
        panStartPanY = panY;
        container.classList.add('panning');
        e.preventDefault();
    }
});

window.addEventListener('mousemove', (e) => {
    if (isPanning) {
        panX = panStartPanX + (e.clientX - panStartX);
        panY = panStartPanY + (e.clientY - panStartY);
        clampPan();
        render();
    }
});

window.addEventListener('mouseup', () => {
    if (isPanning) {
        isPanning = false;
        container.classList.remove('panning');
    }
});

container.addEventListener('click', (e) => {
    if (e.ctrlKey) return;
    if (!synctexEnabled) return;
    const rect = canvas.getBoundingClientRect();
    // mx, my in CSS pixel space (not adjusted for dpr)
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { docX, docY } = screenToDocument(mx, my);
    vscode.postMessage({ type: 'synctex-backward', page: currentPage, x: docX, y: docY });
});

window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT') return;
    switch (e.key) {
        case 'ArrowLeft': case 'PageUp':
            e.preventDefault();
            vscode.postMessage({ type: 'previous-page' });
            break;
        case 'ArrowRight': case 'PageDown':
            e.preventDefault();
            vscode.postMessage({ type: 'next-page' });
            break;
        case 'Home':
            e.preventDefault();
            vscode.postMessage({ type: 'go-home' });
            break;
        case 'End':
            e.preventDefault();
            vscode.postMessage({ type: 'go-end' });
            break;
        case '0':
            if (e.ctrlKey) {
                e.preventDefault();
                resetZoomState();
            }
            break;
    }
});

function resetZoomState() {
    fitMode = 'width';
    zoomLevel = 1;
    panX = panY = 0;
    resMultiplier = 2.5;
    const ri = document.getElementById('res-input') as HTMLInputElement;
    if (ri) ri.value = '2.50';
    const targetW = Math.round(pageWidth * 2.5);
    const targetH = Math.round(pageHeight * 2.5);
    vscode.postMessage({ type: 'set-output-size', width: targetW, height: targetH });
    render();
}

// ---- Button Handlers ----
document.getElementById('btn-home')!.addEventListener('click', () => vscode.postMessage({ type: 'go-home' }));
document.getElementById('btn-prev')!.addEventListener('click', () => vscode.postMessage({ type: 'previous-page' }));
document.getElementById('btn-next')!.addEventListener('click', () => vscode.postMessage({ type: 'next-page' }));
document.getElementById('btn-end')!.addEventListener('click', () => vscode.postMessage({ type: 'go-end' }));
document.getElementById('btn-zoom-reset')!.addEventListener('click', () => resetZoomState());

// Options dropdown
const optionsBtn = document.getElementById('btn-options')!;
const optionsMenu = document.getElementById('options-menu')!;
optionsBtn.addEventListener('click', () => optionsMenu.classList.toggle('show'));
document.addEventListener('click', (e) => {
    if (!optionsMenu.contains(e.target as Node) && e.target !== optionsBtn) {
        optionsMenu.classList.remove('show');
    }
});

document.getElementById('btn-fit-width')!.addEventListener('click', () => {
    fitMode = 'width';
    vscode.postMessage({ type: 'set-fit-mode', mode: 'width' });
    optionsMenu.classList.remove('show');
    render();
});

document.getElementById('btn-fit-height')!.addEventListener('click', () => {
    fitMode = 'height';
    vscode.postMessage({ type: 'set-fit-mode', mode: 'height' });
    optionsMenu.classList.remove('show');
    render();
});

document.getElementById('btn-disable-synctex')!.addEventListener('click', () => {
    synctexEnabled = !synctexEnabled;
    const btnST = document.getElementById('btn-disable-synctex');
    if (btnST) btnST.textContent = synctexEnabled ? t('disableSynctex') : t('enableSynctex');
    try { localStorage.setItem('texpresso-synctex', synctexEnabled ? '1' : '0'); } catch (_) { }
    optionsMenu.classList.remove('show');
});

document.getElementById('btn-dark-mode')!.addEventListener('click', () => {
    darkMode = !darkMode;
    const btnDM = document.getElementById('btn-dark-mode');
    if (btnDM) btnDM.textContent = darkMode ? t('lightMode') : t('darkMode');
    const canvasEl = document.getElementById('preview-canvas') as HTMLElement;
    if (canvasEl) {
        canvasEl.style.filter = darkMode ? 'invert(1) hue-rotate(180deg)' : 'none';
    }
    try { localStorage.setItem('texpresso-dark-mode', darkMode ? '1' : '0'); } catch (_) { }
    optionsMenu.classList.remove('show');
    render();
});

document.getElementById('btn-language')!.addEventListener('click', () => {
    locale = locale === 'zh' ? 'en' : 'zh';
    updateLocale();
    optionsMenu.classList.remove('show');
});

// Page input
const pageInput = document.getElementById('page-input') as HTMLInputElement;
let pageInputTimeout: ReturnType<typeof setTimeout> | null = null;
pageInput.addEventListener('input', () => {
    if (pageInputTimeout) clearTimeout(pageInputTimeout);
    pageInputTimeout = setTimeout(() => {
        const n = parseInt(pageInput.value, 10);
        if (n >= 1) {
            currentPage = n - 1;
            vscode.postMessage({ type: 'set-page', page: n - 1 });
        }
    }, 300);
});

pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (pageInputTimeout) { clearTimeout(pageInputTimeout); pageInputTimeout = null; }
        const n = parseInt(pageInput.value, 10);
        if (n >= 1) {
            currentPage = n - 1;
            vscode.postMessage({ type: 'set-page', page: n - 1 });
        }
    }
});

// Resolution multiplier input
const resInput = document.getElementById('res-input') as HTMLInputElement;
let resInputTimeout: ReturnType<typeof setTimeout> | null = null;
resInput.addEventListener('input', () => {
    if (resInputTimeout) clearTimeout(resInputTimeout);
    resInputTimeout = setTimeout(() => {
        const v = parseFloat(resInput.value);
        if (v >= 1 && v <= maxResCap) {
            resMultiplier = v;
            requestResolution();
        }
    }, 400);
});
resInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (resInputTimeout) { clearTimeout(resInputTimeout); resInputTimeout = null; }
        const v = parseFloat(resInput.value);
        if (v >= 1 && v <= maxResCap) {
            resMultiplier = v;
            requestResolution();
        }
    }
});

// ---- Message Handler ----
window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
        case 'config':
            if (msg.maxResCap) {
                maxResCap = msg.maxResCap;
                const ri4 = document.getElementById('res-input') as HTMLInputElement;
                if (ri4) ri4.max = String(msg.maxResCap);
            }
            if (msg.defaultResolution) {
                resMultiplier = msg.defaultResolution;
                const ri5 = document.getElementById('res-input') as HTMLInputElement;
                if (ri5) ri5.value = msg.defaultResolution.toFixed(2);
            }
            if (msg.scrollSpeed !== undefined) {
                scrollSpeed = msg.scrollSpeed;
            }
            break;

        case 'dark-mode':
            darkMode = msg.dark === 'true' || msg.dark === true;
            const cv = document.getElementById('preview-canvas') as HTMLElement;
            if (cv) cv.style.filter = darkMode ? 'invert(1) hue-rotate(180deg)' : 'none';
            render();
            break;

        case 'page-update':
            // Hide loading indicator
            const ld3 = document.getElementById('loading');
            if (ld3) ld3.style.display = 'none';

            currentPage = msg.page;
            totalPages = msg.totalPages;
            if (msg.pageWidth && msg.pageHeight) {
                pageWidth = msg.pageWidth;
                pageHeight = msg.pageHeight;
            }
            renderWidth = msg.renderWidth;
            renderHeight = msg.renderHeight;
            pageInput.value = String(currentPage + 1);
            (document.getElementById('total-pages') as HTMLSpanElement).textContent =
                '/ ' + String(totalPages);
            pageInput.max = String(totalPages);
            if (msg.qoiBase64) {
                loadQOIBase64(msg.qoiBase64);
            } else if (msg.qoiUri) {
                loadQOI(msg.qoiUri);
            }
            // Sync resolution input
            const resInp = document.getElementById('res-input') as HTMLInputElement;
            if (resInp && pageWidth > 0) {
                const m = renderWidth / pageWidth;
                if (Math.abs(parseFloat(resInp.value || '2.5') - m) > 0.05) {
                    resInp.value = m.toFixed(2);
                }
            }
            break;

        case 'page-diff':
            // Hide loading indicator
            const ld4 = document.getElementById('loading');
            if (ld4) ld4.style.display = 'none';

            currentPage = msg.page;
            totalPages = msg.totalPages;
            if (msg.pageWidth && msg.pageHeight) {
                pageWidth = msg.pageWidth;
                pageHeight = msg.pageHeight;
            }
            renderWidth = msg.renderWidth;
            renderHeight = msg.renderHeight;
            pageInput.value = String(currentPage + 1);
            (document.getElementById('total-pages') as HTMLSpanElement).textContent =
                '/ ' + String(totalPages);
            pageInput.max = String(totalPages);
            applyDirtyRects(msg.rects);
            // Sync resolution input
            const resInp2 = document.getElementById('res-input') as HTMLInputElement;
            if (resInp2 && pageWidth > 0) {
                const m = renderWidth / pageWidth;
                if (Math.abs(parseFloat(resInp2.value || '2.5') - m) > 0.05) {
                    resInp2.value = m.toFixed(2);
                }
            }
            break;

        case 'synctex-scroll':
            if (!pageImage) break;
            const scw = canvas.width / (window.devicePixelRatio || 1);
            const sch = canvas.height / (window.devicePixelRatio || 1);
            const ss = getDisplayScale();
            const simgX = (msg.x / pageWidth) * renderWidth;
            const simgY = (msg.y / pageHeight) * renderHeight;
            // Pan to center the target horizontally, 1/3 from top vertically
            panX = pageImage.width * ss / 2 - simgX * ss;
            panY = pageImage.height * ss / 2 - simgY * ss - sch / 6;
            clampPan();
            render();
            break;

        case 'zoom-reset':
            resetZoomState();
            break;

        case 'page-error':
            // Page doesn't exist — show alert with i18n
            const errTotal = msg.totalPages || totalPages;
            const errMsg = locale === 'zh'
                ? `该文档共 ${errTotal} 页`
                : `Document has ${errTotal} page(s)`;
            alert(errMsg);
            // Reset page input to current page
            pageInput.value = String(currentPage + 1);
            break;

        case 'fit-mode-changed':
            fitMode = msg.mode;
            render();
            break;
    }
});

// ---- Resize Observer ----
const resizeObserver = new ResizeObserver(() => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        resizeCanvas();
    }, 150);
});
resizeObserver.observe(container);

// ---- Init ----
updateLocale();
// Restore dark mode from localStorage
const savedDark = (() => { try { return localStorage.getItem('texpresso-dark-mode'); } catch (_) { return null; } })();
if (savedDark === '1') {
    darkMode = true;
    const cv = document.getElementById('preview-canvas') as HTMLElement;
    if (cv) cv.style.filter = 'invert(1) hue-rotate(180deg)';
    const btnDM2 = document.getElementById('btn-dark-mode');
    if (btnDM2) btnDM2.textContent = t('lightMode');
}
// Restore synctex state from localStorage
const savedST = (() => { try { return localStorage.getItem('texpresso-synctex'); } catch (_) { return null; } })();
if (savedST === '0') {
    synctexEnabled = false;
    const btnST = document.getElementById('btn-disable-synctex');
    if (btnST) btnST.textContent = t('enableSynctex');
}
// Show loading indicator on init
const ld = document.getElementById('loading');
if (ld) ld.style.display = 'block';
resizeCanvas();
vscode.postMessage({ type: 'preview-ready' });
