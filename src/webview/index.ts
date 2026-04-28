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
        darkMode: '深色模式', language: 'English',
    },
    en: {
        home: 'Home', prevPage: 'Prev', nextPage: 'Next',
        endPage: 'End', pageInput: 'Page', totalPages: 'total',
        resetZoom: 'Reset Zoom', options: 'Options',
        fitWidth: 'Fit Width', fitHeight: 'Fit Height',
        darkMode: 'Dark Mode', language: '中文',
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
    document.getElementById('btn-dark-mode')!.textContent = t('darkMode');
    document.getElementById('btn-language')!.textContent = t('language');
    try { localStorage.setItem('texpresso-locale', locale); } catch (_) {}
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
    const index: [number,number,number,number][] = new Array(64).fill(null).map(() => [0,0,0,255]);
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
                if (tag === 0) { const idx = b1 & 0x3f; [r,g,b,a] = index[idx]; }
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
let userScale = 1;
let panX = 0, panY = 0;
let darkMode = false;
let isPanning = false;
let panStartX = 0, panStartY = 0, panStartPanX = 0, panStartPanY = 0;
let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
let zoomDebounceTimeout: ReturnType<typeof setTimeout> | null = null;

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

function render() {
    const cw = canvas.width / (window.devicePixelRatio || 1);
    const ch = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, cw, ch);

    if (!pageImage) return;

    let scale: number;
    if (fitMode === 'width') {
        scale = cw / pageImage.width;
    } else if (fitMode === 'height') {
        scale = ch / pageImage.height;
    } else {
        scale = userScale;
    }

    const iw = pageImage.width * scale;
    const ih = pageImage.height * scale;
    const ox = panX + (cw - iw) / 2;
    const oy = panY + (ch - ih) / 2;

    ctx.drawImage(pageImage, ox, oy, iw, ih);

    // Request higher resolution if needed
    if (scale > 1.5 && (renderWidth < pageImage.width * scale * 0.8 || renderHeight < pageImage.height * scale * 0.8)) {
        if (zoomDebounceTimeout) clearTimeout(zoomDebounceTimeout);
        zoomDebounceTimeout = setTimeout(() => {
            vscode.postMessage({
                type: 'set-output-size',
                width: Math.round(pageWidth * scale),
                height: Math.round(pageHeight * scale),
            });
        }, 200);
    }
}

async function loadQOI(qoiUri: string): Promise<void> {
    const cacheK = cacheKey(currentPage, renderWidth, renderHeight);
    const cached = pageCache.get(cacheK);
    if (cached) {
        pageImage = cached;
        render();
        return;
    }

    const resp = await fetch(qoiUri);
    const buf = await resp.arrayBuffer();
    const data = new Uint8Array(buf);
    const decoded = decodeQOI(data);
    const imgData = new ImageData(decoded.pixels, decoded.width, decoded.height);
    const bitmap = await createImageBitmap(imgData);

    pageImage = bitmap;
    // Add to cache, maintain LRU
    if (pageCache.size >= CACHE_SIZE) {
        const firstKey = pageCache.keys().next().value;
        pageCache.delete(firstKey);
    }
    pageCache.set(cacheK, bitmap);
    render();
}

function screenToDocument(cx: number, cy: number): { docX: number; docY: number } {
    const cw = canvas.width / (window.devicePixelRatio || 1);
    const ch = canvas.height / (window.devicePixelRatio || 1);
    if (!pageImage) return { docX: 0, docY: 0 };

    let scale: number;
    if (fitMode === 'width') scale = cw / pageImage.width;
    else if (fitMode === 'height') scale = ch / pageImage.height;
    else scale = userScale;

    const iw = pageImage.width * scale;
    const ih = pageImage.height * scale;
    const imgX = (cx - panX - (cw - iw) / 2) / scale;
    const imgY = (cy - panY - (ch - ih) / 2) / scale;
    return {
        docX: (imgX / renderWidth) * pageWidth,
        docY: (imgY / renderHeight) * pageHeight,
    };
}

// ---- Event Handlers ----
container.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const newScale = Math.max(0.1, Math.min(10, userScale + delta));
        // Zoom around mouse cursor
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) / (window.devicePixelRatio || 1);
        const my = (e.clientY - rect.top) / (window.devicePixelRatio || 1);
        if (fitMode !== 'custom') {
            fitMode = 'custom';
            // derive current scale
            const cw = canvas.width / (window.devicePixelRatio || 1);
            userScale = pageImage ? cw / pageImage.width : 1;
        }
        panX = mx - (mx - panX) * (newScale / userScale);
        panY = my - (my - panY) * (newScale / userScale);
        userScale = newScale;
        render();
    }
}, { passive: false });

container.addEventListener('mousedown', (e) => {
    if (e.ctrlKey) {
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
        const dpr = window.devicePixelRatio || 1;
        panX = panStartPanX + (e.clientX - panStartX) / dpr;
        panY = panStartPanY + (e.clientY - panStartY) / dpr;
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
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const mx = (e.clientX - rect.left) / dpr;
    const my = (e.clientY - rect.top) / dpr;
    const { docX, docY } = screenToDocument(mx, my);
    vscode.postMessage({ type: 'synctex-backward', page: currentPage, x: docX, y: docY });
});

window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT') return; // Don't intercept input typing
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
                fitMode = 'width';
                userScale = 1;
                panX = panY = 0;
                vscode.postMessage({ type: 'reset-zoom' });
                render();
            }
            break;
    }
});

// ---- Button Handlers ----
document.getElementById('btn-home')!.addEventListener('click', () => vscode.postMessage({ type: 'go-home' }));
document.getElementById('btn-prev')!.addEventListener('click', () => vscode.postMessage({ type: 'previous-page' }));
document.getElementById('btn-next')!.addEventListener('click', () => vscode.postMessage({ type: 'next-page' }));
document.getElementById('btn-end')!.addEventListener('click', () => vscode.postMessage({ type: 'go-end' }));
document.getElementById('btn-zoom-reset')!.addEventListener('click', () => {
    fitMode = 'width';
    userScale = 1;
    panX = panY = 0;
    vscode.postMessage({ type: 'reset-zoom' });
    render();
});

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

document.getElementById('btn-dark-mode')!.addEventListener('click', () => {
    darkMode = !darkMode;
    vscode.postMessage({ type: 'toggle-invert' });
    optionsMenu.classList.remove('show');
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
        if (n >= 1 && n <= totalPages) {
            currentPage = n - 1;
            vscode.postMessage({ type: 'set-page', page: n - 1 });
        }
    }, 300);
});

pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (pageInputTimeout) { clearTimeout(pageInputTimeout); pageInputTimeout = null; }
        const n = parseInt(pageInput.value, 10);
        if (n >= 1 && n <= totalPages) {
            currentPage = n - 1;
            vscode.postMessage({ type: 'set-page', page: n - 1 });
        }
    }
});

// ---- Message Handler ----
window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
        case 'page-update':
            currentPage = msg.page;
            totalPages = msg.totalPages;
            renderWidth = msg.renderWidth;
            renderHeight = msg.renderHeight;
            pageInput.value = String(currentPage + 1);
            (document.getElementById('total-pages') as HTMLSpanElement).textContent =
                '/ ' + String(totalPages);
            pageInput.max = String(totalPages);
            loadQOI(msg.qoiUri);
            break;

        case 'zoom-reset':
            fitMode = 'width';
            userScale = 1;
            panX = panY = 0;
            render();
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
resizeCanvas();
vscode.postMessage({ type: 'preview-ready' });
