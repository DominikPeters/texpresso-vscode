/* Bounded decoded-image reuse. Costs estimate decoded RGBA plus encoded bytes;
 * browser/GPU allocations are implementation-dependent, so also cap entry count. */
(function (root) {
  'use strict';
  class ImageCache {
    constructor(dispose, maxBytes = 32 * 1024 * 1024, maxEntries = 4) {
      this.dispose = dispose; this.maxBytes = maxBytes; this.maxEntries = maxEntries;
      this.entries = new Map(); this.bytes = 0;
    }
    get(id) {
      const entry = this.entries.get(id);
      if (entry) { this.entries.delete(id); this.entries.set(id, entry); }
      return entry?.value;
    }
    has(id) { return this.entries.has(id); }
    keys() { return [...this.entries.keys()]; }
    put(id, value, cost) {
      if (!id || !Number.isFinite(cost) || cost <= 0 || cost > this.maxBytes || this.maxEntries < 1) { return false; }
      this.forget(id);
      this.entries.set(id, { value, cost }); this.bytes += cost;
      while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) { this.forget(this.entries.keys().next().value); }
      return true;
    }
    take(id) {
      const entry = this.entries.get(id);
      if (entry) { this.entries.delete(id); this.bytes -= entry.cost; return entry.value; }
    }
    forget(id) {
      const entry = this.entries.get(id);
      if (entry) { this.entries.delete(id); this.bytes -= entry.cost; this.dispose(entry.value); }
    }
    clear() { for (const id of this.entries.keys()) { this.forget(id); } }
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = ImageCache; }
  else { root.TexpressoImageCache = ImageCache; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
