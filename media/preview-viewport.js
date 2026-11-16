// Shared with the geometry tests; coordinates are CSS pixels or page points,
// and raster widths are physical pixels.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.TexpressoViewport = factory(); }
})(typeof window === 'object' ? window : this, () => {
  'use strict';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function wheelFactor(delta, mode) {
    // Chromium's native trackpad pinch is a ctrl+wheel event in pixel mode.
    // Follow PDF.js / Firefox InputData.cpp: exp(-deltaY / 100). Keeping the
    // fractional scale makes the result independent of event frequency.
    // https://github.com/mozilla/pdf.js/blob/master/web/app.js
    return Math.exp(-delta * (mode === 1 ? 0.1 : mode === 2 ? 1 : 0.01));
  }
  function scrollCorrection(before, after, origin, point) {
    point ||= { x: (origin.x - before.left) / before.width, y: (origin.y - before.top) / before.height };
    return {
      x: after.left + point.x * after.width - origin.x,
      y: after.top + point.y * after.height - origin.y,
    };
  }
  // Keep source following still while the target remains comfortably visible.
  // A small hysteresis band absorbs SyncTeX/rounding noise near the margin.
  function syncScrollCorrection(point, viewport, automatic = false) {
    const axis = (value, start, size) => {
      const margin = Math.min(48, size * .1), tolerance = 4;
      if (value >= start + margin - tolerance && value <= start + size - margin + tolerance) { return 0; }
      const delta = value - start - size / 2;
      return Math.abs(delta) > tolerance ? delta : 0;
    };
    const visibleX = point.x >= viewport.left - 4 && point.x <= viewport.left + viewport.width + 4;
    // Source following never undoes the user's horizontal pan/zoom. Explicit
    // jumps reveal an offscreen target with the smallest useful correction.
    const inset = Math.min(24, viewport.width / 4);
    const x = automatic || visibleX ? 0 : point.x < viewport.left
      ? point.x - viewport.left - inset : point.x - viewport.left - viewport.width + inset;
    return { x, y: axis(point.y, viewport.top, viewport.height) };
  }
  function rasterWidth(bounds, cssWidth, dpr) {
    const w = bounds[2] - bounds[0], h = bounds[3] - bounds[1];
    // Match the engine's bounded raster allocation instead of repeatedly
    // requesting an ever larger full page that it would downsample anyway.
    return Math.max(1, Math.floor(Math.min(Math.ceil(cssWidth * dpr), 4096,
      Math.sqrt(4000000 * w / h), 8192 * w / Math.max(w, h))));
  }
  // --- Page grids and surfaces (PREVIEW-PROTOCOL.md) ---------------------
  // A page's grid is its complete width in device pixels. The layout snaps a
  // page to exactly that many device pixels, so a raster pixel is a screen
  // pixel; a surface is an integer rectangle [x0, y0, x1, y1] of the grid.
  const SURFACE_CELL = 512;
  // Snap in screen coordinates, not just the page stack. Toolbar height and
  // scroll offsets need not be whole device pixels at fractional display scales.
  const snapDevicePosition = (position, dpr, origin = 0) => Math.round((position + origin) * dpr) / dpr - origin;
  // Rows of a page `gridWidth` device pixels wide: the engine's own rule,
  // including single-precision page extents and its row tolerance.
  function gridHeight(bounds, gridWidth) {
    const w = Math.fround(bounds[2] - bounds[0]), h = Math.fround(bounds[3] - bounds[1]);
    return Math.max(1, Math.ceil(h * gridWidth / w - 1e-4));
  }
  const area = r => r ? Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]) : 0;
  const contains = (outer, inner) => !!outer && outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
  const sameRect = (a, b) => !!a && !!b && a.every((n, i) => n === b[i]);
  // Pixels the sharp surfaces of one viewport may hold in total: the screen
  // area with a margin for scrolling, never the engine's whole ceiling by
  // default and never less than a small pane needs for whole pages.
  function surfaceBudget(viewportPixels, maxPixels) {
    return Math.max(1, Math.floor(Math.min(maxPixels, Math.max(2000000, viewportPixels * 1.5))));
  }
  /* Choose the rectangle of a page's grid to keep sharp.
   *  grid     [width, height] in device pixels
   *  visible  the part of the page inside the viewport, in grid pixels, or
   *           undefined when the page is off screen
   *  budget   { whole, clip, max }: a page of at most `whole` pixels is held
   *           complete; otherwise the rectangle may use `clip` pixels, or
   *           what the visible part needs if that is more, up to `max`
   *  current  the rectangle already held at this grid, if any
   * A page that fits is held whole: its rectangle never moves, so scrolling
   * costs nothing. Otherwise the rectangle covers the visible part, aligned
   * outward to the engine's lattice, plus as many further lattice rows as the
   * budget allows. It is kept for as long as it still covers what is visible. */
  function planSurface(grid, visible, budget, current, cell = SURFACE_CELL) {
    const [gw, gh] = grid;
    if (gw <= 8192 && gh <= 8192 && gw * gh <= Math.min(budget.whole, budget.max)) { return [0, 0, gw, gh]; }
    if (!visible || visible[2] <= visible[0] || visible[3] <= visible[1]) { return undefined; }
    const need = [Math.max(0, Math.floor(visible[0] / cell) * cell), Math.max(0, Math.floor(visible[1] / cell) * cell),
      Math.min(gw, Math.ceil(visible[2] / cell) * cell), Math.min(gh, Math.ceil(visible[3] / cell) * cell)];
    // What is on screen is sharp even where lattice alignment costs more than
    // this page's share; only the engine's ceiling can cut into it.
    const limit = Math.min(budget.max, Math.max(budget.clip, area(need)));
    // A held rectangle stays while it covers the view and is within the whole
    // budget, even above this page's present share: shares shift with every
    // scroll, and re-rendering to give pixels back would cost more than it saves.
    if (current && contains(current, need) && area(current) <= Math.max(limit, Math.min(budget.max, budget.whole))) { return current.slice(); }
    const fits = r => r[2] - r[0] <= 8192 && r[3] - r[1] <= 8192 && area(r) <= limit;
    const clip = need.slice();
    // A viewport beyond the budget keeps its middle sharp; the placeholder
    // shows around it. Shrink by whole lattice steps, longest side first.
    while (!fits(clip)) {
      const wide = clip[2] - clip[0], tall = clip[3] - clip[1];
      if (wide <= cell && tall <= cell) {
        // One cell is the smallest lattice-aligned rectangle; trim it exactly.
        clip[2] = clip[0] + Math.max(1, Math.min(wide, 8192, limit));
        clip[3] = clip[1] + Math.max(1, Math.min(tall, 8192, Math.floor(limit / (clip[2] - clip[0]))));
        break;
      }
      const axis = tall >= wide ? 1 : 0, low = clip[axis], high = clip[axis + 2];
      const centre = (visible[axis] + visible[axis + 2]) / 2;
      if (centre - low >= high - centre) { clip[axis] = Math.min(high - 1, (Math.floor(low / cell) + 1) * cell); }
      else { clip[axis + 2] = Math.max(low + 1, (Math.ceil(high / cell) - 1) * cell); }
    }
    // Overscan: grow by lattice rows, then columns, on the nearer-to-need side
    // first, while the budget lasts. Scrolling then reuses the rectangle.
    for (const axis of [1, 0]) {
      const limit = axis ? gh : gw;
      for (let grown = true; grown;) {
        grown = false;
        for (const side of [axis + 2, axis]) {
          const next = clip.slice();
          next[side] = side > 1 ? Math.min(limit, (Math.floor(clip[side] / cell) + 1) * cell) : Math.max(0, (Math.ceil(clip[side] / cell) - 1) * cell);
          // Grow evenly: never more than one lattice step ahead of the other side.
          const before = side > 1 ? clip[side] - need[side] : need[side] - clip[side];
          const other = side > 1 ? need[axis] - clip[axis] : clip[axis + 2] - need[axis + 2];
          const otherStuck = side > 1 ? clip[axis] === 0 : clip[axis + 2] === limit;
          if (next[side] !== clip[side] && fits(next) && (before <= other || otherStuck)) { clip[side] = next[side]; grown = true; }
        }
      }
    }
    return clip;
  }
  // The part of a page inside the viewport, in the page's grid pixels.
  function visibleGridRect(grid, pageRect, viewportRect) {
    const sx = grid[0] / pageRect.width, sy = grid[1] / pageRect.height;
    const r = [Math.max(0, Math.floor((viewportRect.left - pageRect.left) * sx)), Math.max(0, Math.floor((viewportRect.top - pageRect.top) * sy)),
      Math.min(grid[0], Math.ceil((viewportRect.right - pageRect.left) * sx)), Math.min(grid[1], Math.ceil((viewportRect.bottom - pageRect.top) * sy))];
    return r[2] > r[0] && r[3] > r[1] ? r : undefined;
  }
  // Where a surface's canvas sits on its page, as fractions of the page box.
  function surfacePlacement(grid, clip) {
    return { left: clip[0] / grid[0], top: clip[1] / grid[1], width: (clip[2] - clip[0]) / grid[0], height: (clip[3] - clip[1]) / grid[1] };
  }
  const covers = (outer, inner) => outer && inner.every((n, i) =>
    i < 2 ? n >= outer[i] - 0.001 : n <= outer[i] + 0.001);
  class DetailCache {
    constructor() { this.token = 0; this.reset(); }
    reset() { this.token++; this.pending = undefined; this.cached = undefined; }
    request(page, rect, viewport, dpr, baseWidth) {
      const scale = rect.width / (page[2] - page[0]);
      const density = scale * dpr;
      if (baseWidth >= rect.width * dpr * 0.98) { return; }
      const visible = [Math.max(page[0], page[0] + (viewport.left - rect.left) / scale),
        Math.max(page[1], page[1] + (viewport.top - rect.top) / scale),
        Math.min(page[2], page[0] + (viewport.right - rect.left) / scale),
        Math.min(page[3], page[1] + (viewport.bottom - rect.top) / scale)];
      if (visible[2] <= visible[0] || visible[3] <= visible[1] || this.pending) { return; }
      // Overscan only as far as the pixel budget allows. Scrolling still has
      // the base image underneath while the next visible crop is rendering.
      const w = visible[2] - visible[0], h = visible[3] - visible[1];
      const overscan = Math.max(1, Math.min(1.3, Math.sqrt(4000000 / (w * h * density * density))));
      const padded = [Math.max(page[0], visible[0] - w * (overscan - 1) / 2),
        Math.max(page[1], visible[1] - h * (overscan - 1) / 2),
        Math.min(page[2], visible[2] + w * (overscan - 1) / 2),
        Math.min(page[3], visible[3] + h * (overscan - 1) / 2)];
      const width = rasterWidth(padded, (padded[2] - padded[0]) * scale, dpr);
      const actualDensity = width / (padded[2] - padded[0]);
      const cached = this.cached;
      if (cached && covers(cached.bounds, visible) &&
          cached.width / (cached.bounds[2] - cached.bounds[0]) >= actualDensity * 0.98) { return; }
      this.pending = { token: ++this.token, bounds: padded, width };
      return this.pending;
    }
    accept(token, header) {
      if (token !== this.pending?.token) { return false; }
      this.pending = undefined; this.cached = header; return true;
    }
  }
  // Compact geometry survives surface eviction. Unknown pages use a stable
  // estimate; no DOM placeholder or render is needed to measure distant pages.
  class PageLayout {
    constructor() {
      this.sizes = new Map(); this.latestText = new Map(); this.textExtent = undefined; this.maxLearnedPage = -1;
      this.fallback = [0, 0, 595.28, 841.89]; this.gap = 8; this.version = 0; this.textGutter = 12;
      this.configure({});
    }
    textRange(bounds, textBounds) {
      if (!Array.isArray(textBounds) || textBounds.length !== 4 || !textBounds.every(Number.isFinite)) { return; }
      const left = Math.max(bounds[0], textBounds[0]), right = Math.min(bounds[2], textBounds[2]);
      const top = Math.max(bounds[1], textBounds[1]), bottom = Math.min(bounds[3], textBounds[3]);
      if (right <= left || bottom <= top) { return; }
      const center = (bounds[0] + bounds[2]) / 2;
      return [left - center, right - center];
    }
    setTextBounds(page, bounds, textBounds) {
      if (!Number.isInteger(page) || page < 0 || page > 100000 || !this.validBounds(bounds)) { return false; }
      const range = this.textRange(bounds, textBounds);
      if (!range) { this.latestText.delete(page); return false; }
      this.latestText.set(page, range); this.maxLearnedPage = Math.max(this.maxLearnedPage, page);
      // Text edits often alter the last glyph by a fraction of a point. Keep a
      // shared high-water envelope, with the screen gutter absorbing tiny drift.
      const old = this.textExtent;
      if (old && range[0] >= old[0] - 2 && range[1] <= old[1] + 2) { return false; }
      this.textExtent = old ? [Math.min(old[0], range[0]), Math.max(old[1], range[1])] : range.slice();
      return true;
    }
    refitText() {
      let extent;
      for (const range of this.latestText.values()) {
        extent = extent ? [Math.min(extent[0], range[0]), Math.max(extent[1], range[1])] : range.slice();
      }
      this.textExtent = extent;
    }
    trim(count) {
      // Frequent complete-state updates must retain the unchanged-layout O(1)
      // path. Scan only if a shrink/new estimate can actually exceed EOF.
      if (this.maxLearnedPage < count) { return; }
      let removed = false, max = -1;
      for (const entries of [this.sizes, this.latestText]) {
        for (const page of entries.keys()) {
          if (page >= count) { entries.delete(page); removed = true; }
          else { max = Math.max(max, page); }
        }
      }
      this.maxLearnedPage = max;
      if (removed) { this.version++; this.refitText(); }
    }
    validBounds(bounds) {
      return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) && bounds[2] > bounds[0] && bounds[3] > bounds[1];
    }
    textScale(extent = this.textExtent) {
      // Match the existing numeric zoom ceiling for isolated glyphs/short labels.
      return extent ? Math.min(4 * 96 / 72, Math.max(.05, (this.width - 2 * this.textGutter) / (extent[1] - extent[0]))) : undefined;
    }
    dimensions(bounds, proposedTextBounds) {
      const w = bounds[2] - bounds[0], h = bounds[3] - bounds[1];
      let extent = this.textExtent;
      const proposed = this.textRange(bounds, proposedTextBounds);
      if (proposed && (!extent || proposed[0] < extent[0] - 2 || proposed[1] > extent[1] + 2)) { extent = extent ? [Math.min(extent[0], proposed[0]), Math.max(extent[1], proposed[1])] : proposed; }
      let scale = Number(this.zoom) * 96 / 72;
      if (this.zoom === 'text' && extent) { scale = this.textScale(extent); }
      else if (this.zoom === 'width' || this.zoom === 'page' || this.zoom === 'text') {
        scale = Math.max(.05, this.width / w);
        if (this.zoom === 'page') { scale = Math.min(scale, Math.max(.05, this.height / h)); }
      }
      if (this.dpr) {
        // The page occupies a whole number of device pixels in both directions:
        // its grid. A raster of that grid is then shown without resampling.
        const grid = this.grid(bounds, w * scale);
        return { width: grid[0] / this.dpr, height: grid[1] / this.dpr };
      }
      return { width: w * scale, height: h * scale };
    }
    // The grid of a page laid out `cssWidth` wide at the device pixel ratio.
    grid(bounds, cssWidth) {
      const width = Math.max(1, Math.min(65536, Math.round(cssWidth * this.dpr)));
      return [width, gridHeight(bounds, width)];
    }
    textScroll() {
      if (this.zoom !== 'text' || !this.textExtent) { return 0; }
      const center = (this.textExtent[0] + this.textExtent[1]) / 2;
      return clamp(this.maxWidth / 2 + center * this.textScale() - this.width / 2, 0, this.maxWidth - this.width);
    }
    configure({ count = 0, complete = false, active = 0, zoom = 'width', width = 800, height = 700, dpr } = {}) {
      if (complete) { this.trim(Math.max(0, count)); }
      const length = Math.min(100001, complete ? Math.max(1,count) : Math.max(count+1,active+1,1));
      width = Math.max(1,width); height = Math.max(1,height);
      // Device snapping is opt-in: without a pixel ratio the layout stays in
      // exact page proportions, as callers that never show a raster expect.
      dpr = Number.isFinite(dpr) && dpr > 0 ? dpr : undefined;
      const key = `${length}:${zoom}:${width}:${height}:${this.version}:${zoom === 'text' ? this.textExtent : ''}:${dpr || ''}`;
      if (key === this.key) { return; } this.key = key;
      this.count = length;
      this.zoom = zoom; this.width = width; this.height = height; this.dpr = dpr;
      const gap = dpr ? Math.max(1, Math.round(this.gap * dpr)) / dpr : this.gap;
      this.offsets = new Float64Array(this.count + 1); this.rects = new Array(this.count); this.maxWidth = this.width;
      for (let page = 0; page < this.count; page++) {
        const b = this.sizes.get(page) || this.fallback, size = this.dimensions(b);
        this.rects[page] = { top: this.offsets[page], width: size.width, height: size.height, bounds: b };
        this.maxWidth = Math.max(this.maxWidth, size.width);
        this.offsets[page + 1] = this.offsets[page] + size.height + (page + 1 < this.count ? gap : 0);
      }
      if (zoom === 'text' && this.textExtent) {
        // Leave enough background around the whole sheets to center asymmetric
        // text, even at the zoom ceiling or when text touches a paper edge.
        const center = (this.textExtent[0] + this.textExtent[1]) / 2;
        this.maxWidth = Math.max(this.maxWidth, this.width + 2 * this.textGutter + 2 * Math.abs(center * this.textScale()));
      }
      this.total = this.offsets[this.count];
    }
    setBounds(page, bounds) {
      if (!Number.isInteger(page) || page < 0 || page > 100000 || !this.validBounds(bounds)) { return false; }
      const old = this.sizes.get(page); if (old && old.every((n, i) => n === bounds[i])) { return false; }
      this.sizes.set(page, bounds.slice()); this.maxLearnedPage = Math.max(this.maxLearnedPage, page); this.version++; return true;
    }
    pageAt(y) {
      let lo = 0, hi = this.count - 1; y = Math.max(0, y);
      while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); if (this.offsets[mid] <= y) { lo = mid; } else { hi = mid - 1; } }
      return lo;
    }
    window(top, height, limit = 12) {
      const first = this.pageAt(top), last = this.pageAt(top + Math.max(0, height - .01)), center = this.pageAt(top + height / 2);
      let start = this.pageAt(Math.max(0, top - height)), end = this.pageAt(top + 2 * height);
      if (end - start + 1 > limit) { start = Math.max(start, center - Math.floor(limit / 2)); end = Math.min(this.count - 1, start + limit - 1); }
      return { first, last, center, start, end };
    }
  }
  return { clamp, wheelFactor, scrollCorrection, syncScrollCorrection, rasterWidth, DetailCache, PageLayout,
    SURFACE_CELL, snapDevicePosition, gridHeight, surfaceBudget, planSurface, visibleGridRect, surfacePlacement, sameRect };
});
