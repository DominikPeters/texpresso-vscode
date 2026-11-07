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
      return { width: w * scale, height: h * scale };
    }
    textScroll() {
      if (this.zoom !== 'text' || !this.textExtent) { return 0; }
      const center = (this.textExtent[0] + this.textExtent[1]) / 2;
      return clamp(this.maxWidth / 2 + center * this.textScale() - this.width / 2, 0, this.maxWidth - this.width);
    }
    configure({ count = 0, complete = false, active = 0, zoom = 'width', width = 800, height = 700 } = {}) {
      if (complete) { this.trim(Math.max(0, count)); }
      const length = Math.min(100001, complete ? Math.max(1,count) : Math.max(count+1,active+1,1));
      width = Math.max(1,width); height = Math.max(1,height);
      const key = `${length}:${zoom}:${width}:${height}:${this.version}:${zoom === 'text' ? this.textExtent : ''}`;
      if (key === this.key) { return; } this.key = key;
      this.count = length;
      this.zoom = zoom; this.width = width; this.height = height;
      this.offsets = new Float64Array(this.count + 1); this.rects = new Array(this.count); this.maxWidth = this.width;
      for (let page = 0; page < this.count; page++) {
        const b = this.sizes.get(page) || this.fallback, size = this.dimensions(b);
        this.rects[page] = { top: this.offsets[page], width: size.width, height: size.height, bounds: b };
        this.maxWidth = Math.max(this.maxWidth, size.width);
        this.offsets[page + 1] = this.offsets[page] + size.height + (page + 1 < this.count ? this.gap : 0);
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
  return { clamp, wheelFactor, scrollCorrection, syncScrollCorrection, rasterWidth, DetailCache, PageLayout };
});
