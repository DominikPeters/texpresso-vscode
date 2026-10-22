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
    constructor() { this.sizes = new Map(); this.fallback = [0, 0, 595.28, 841.89]; this.gap = 8; this.version = 0; this.configure({}); }
    configure({ count = 0, complete = false, active = 0, zoom = 'width', width = 800, height = 700 } = {}) {
      const length = Math.min(100001, complete ? Math.max(1,count) : Math.max(count+1,active+1,1));
      width = Math.max(1,width); height = Math.max(1,height);
      const key = `${length}:${zoom}:${width}:${height}:${this.version}`;
      if (key === this.key) { return; } this.key = key;
      this.count = length;
      this.zoom = zoom; this.width = width; this.height = height;
      this.offsets = new Float64Array(this.count + 1); this.rects = new Array(this.count); this.maxWidth = this.width;
      for (let page = 0; page < this.count; page++) {
        const b = this.sizes.get(page) || this.fallback, w = b[2] - b[0], h = b[3] - b[1];
        let scale = Number(zoom) * 96 / 72;
        if (zoom === 'width' || zoom === 'page') { scale = Math.max(.05, this.width / w); if (zoom === 'page') { scale = Math.min(scale, Math.max(.05, this.height / h)); } }
        this.rects[page] = { top: this.offsets[page], width: w * scale, height: h * scale, bounds: b };
        this.maxWidth = Math.max(this.maxWidth,w*scale);
        this.offsets[page + 1] = this.offsets[page] + h * scale + (page + 1 < this.count ? this.gap : 0);
      }
      this.total = this.offsets[this.count];
    }
    setBounds(page, bounds) {
      if (!Number.isInteger(page) || page < 0 || page > 100000 || !Array.isArray(bounds) || bounds.length !== 4 ||
          !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) { return false; }
      const old = this.sizes.get(page); if (old && old.every((n, i) => n === bounds[i])) { return false; }
      this.sizes.set(page, bounds.slice()); this.version++; return true;
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
  return { clamp, wheelFactor, scrollCorrection, rasterWidth, DetailCache, PageLayout };
});
