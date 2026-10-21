// Shared by the webview and its geometry/request regression tests.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.TexpressoLensCache = factory(); }
})(typeof window === 'object' ? window : this, () => {
  'use strict';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  class LensCache {
    constructor() { this.token = 0; this.reset(); }
    reset() { this.token++; this.pending = undefined; this.cached = undefined; }
    request(point, page, span, pixelsPerPoint) {
      if (this.pending) { return; }
      // Prefetch before the visible circle reaches a cache edge. Clip the
      // coverage test to the page so its outer edges cannot cause a loop.
      const radius = span * 0.75;
      const visible = [Math.max(page[0], point.x - radius), Math.max(page[1], point.y - radius),
        Math.min(page[2], point.x + radius), Math.min(page[3], point.y + radius)];
      const b = this.cached?.bounds, epsilon = 0.0001;
      if (b && visible[0] >= b[0] - epsilon && visible[1] >= b[1] - epsilon &&
          visible[2] <= b[2] + epsilon && visible[3] <= b[3] + epsilon) { return; }
      const width = Math.min(span * 2, page[2] - page[0]);
      const height = Math.min(span * 2, page[3] - page[1]);
      const x = clamp(point.x - width / 2, page[0], page[2] - width);
      const y = clamp(point.y - height / 2, page[1], page[3] - height);
      this.pending = { token: ++this.token, bounds: [x, y, Math.min(page[2], x + width), Math.min(page[3], y + height)],
        width: Math.min(1024, Math.max(1, Math.ceil(width * pixelsPerPoint))) };
      return this.pending;
    }
    accept(token, header) {
      if (token !== this.pending?.token) { return false; }
      this.pending = undefined; this.cached = header;
      return true;
    }
  }
  return LensCache;
});
