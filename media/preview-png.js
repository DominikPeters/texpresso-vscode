/* Exact, bounded PNG updates. The active canvas is transferred between cache
 * identities rather than copied on every edit. No accumulated overlay layers. */
(function (root) {
  'use strict';
  async function decode(bytes, width, height) {
    const view = new Uint8Array(bytes);
    if (view.length < 8 || [137,80,78,71,13,10,26,10].some((n, i) => view[i] !== n)) { throw Error('Invalid PNG signature'); }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const image = new Image();
    try {
      image.src = url; await image.decode();
      if (image.naturalWidth !== width || image.naturalHeight !== height) { throw Error('PNG dimensions do not match the frame'); }
      return image;
    } finally { URL.revokeObjectURL(url); }
  }
  // The pixel limit is the session's: four megapixels unless the engine was
  // launched with a larger budget for display-density surfaces.
  const size = (w, h, limit = 4000000) => Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 8192 && h <= 8192 && w * h <= limit;
  class PngPage {
    static async create(bytes, width, height, id, limit) {
      if (!size(width, height, limit)) { throw Error('PNG canvas budget'); }
      const image = await decode(bytes, width, height);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.className = 'texpresso-png-page'; canvas.setAttribute('role', 'img');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) { throw Error('PNG canvas unavailable'); }
      context.imageSmoothingEnabled = false; context.drawImage(image, 0, 0);
      return new PngPage(canvas, context, id, limit);
    }
    constructor(canvas, context, id, limit) { this.canvas = canvas; this.context = context; this.contentId = id; this.limit = limit; }
    async prepare(patch, bytes) {
      const r = patch.rect;
      if (patch.base !== this.contentId || !Array.isArray(r) || r.length !== 4 || !r.every(n => Number.isSafeInteger(n) && n >= 0)) { throw Error('PNG patch base or rectangle'); }
      const [x, y, w, h] = r;
      if (r.every(n => n === 0) && bytes.byteLength === 0) { return () => {}; }
      if (!size(w, h, this.limit) || x + w > this.canvas.width || y + h > this.canvas.height) { throw Error('PNG patch outside canvas'); }
      const image = await decode(bytes, w, h);
      // Decode/validate first; the caller checks its source generation before
      // committing this synchronous draw. White replacement pixels erase old ink.
      return () => this.context.drawImage(image, x, y);
    }

  }
  root.TexpressoPngPage = PngPage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
