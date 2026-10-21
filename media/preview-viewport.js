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
  return { clamp, wheelFactor, scrollCorrection, rasterWidth, DetailCache };
});
