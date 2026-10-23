/* Injected observer. Production owns decoding, rendering, scheduling and recovery. */
(() => {
  const api = acquireVsCodeApi(), frames = new Map();
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const snapshot = (withResources = false) => {
    const viewport = document.getElementById('viewport'), clip = viewport.getBoundingClientRect();
    const canvases = withResources ? [...document.querySelectorAll('canvas')] : [];
    return { toolbar: Number(document.getElementById('page').value) - 1, count: document.getElementById('total').textContent,
      scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft, visibility: document.visibilityState,
      viewport: { width: clip.width, height: clip.height, dpr: devicePixelRatio, zoom: document.getElementById('zoom').value, format: document.getElementById('format').value },
      resources: withResources ? { residentBytes: Number(viewport.dataset.residentBytes || 0), domNodes: document.getElementsByTagName('*').length,
        svgNodes: document.querySelectorAll('.page-vector *').length, canvasCount: canvases.length,
        canvasPixels: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
        imageSources: [...document.images].filter(image => !!image.getAttribute('src')).length,
        // Optional Chromium heap measurement; this excludes native/GPU allocations.
        browserHeap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null } : undefined,
      shells: [...document.querySelectorAll('.page-sheet')].map(sheet => { const r = sheet.getBoundingClientRect(); return {
        page: Number(sheet.dataset.page), top: r.top - clip.top, bottom: r.bottom - clip.top,
        visible: r.bottom > clip.top && r.top < clip.bottom,
        sequence: frames.get(Number(sheet.dataset.page))?.sequence
      }; }) };
  };
  window.variedApi = () => ({ getState: () => api.getState() || ({ page: 0, format: __CODEC__, zoom: 'width' }), setState: value => api.setState(value), postMessage: m => api.postMessage(m) });
  window.variedAccepted = (header, contentId) => {
    frames.set(header.page, header);
    paint().then(() => api.postMessage({ varied: 'paint', header, contentId, superseded: frames.get(header.page)?.requestId !== header.requestId, ...snapshot() }));
  };
  window.addEventListener('message', async event => {
    const m = event.data;
    if (m.type === 'jump' || m.type === 'target' || m.type === 'error' || m.type === 'state') {
      api.postMessage({ varied: 'message', type: m.type, target: m.target || (m.type === 'target' ? m : undefined), page: m.page,
        text: m.text, sequence: m.variedSourceSequence, ...snapshot() });
    }
    if (!m.variedAction) { return; }
    const action = m.variedAction, viewport = document.getElementById('viewport');
    if (action.name === 'page') {
      const input = document.getElementById('page'); input.value = String(action.page + 1); input.dispatchEvent(new Event('change'));
    } else if (action.name === 'zoom') {
      const select = document.getElementById('zoom'); select.value = String(action.value); select.dispatchEvent(new Event('change'));
    } else if (action.name === 'scroll') {
      viewport.scrollTop += action.delta;
    } else if (action.name === 'boundary') {
      const clip = viewport.getBoundingClientRect(), page = Number(document.getElementById('page').value) - 1;
      const sheet = document.querySelector(`.page-sheet[data-page="${page}"]`);
      if (sheet) { viewport.scrollTop += sheet.getBoundingClientRect().bottom - clip.top - clip.height / 2; }
    }
    await paint(); api.postMessage({ varied: 'action', action: action.id, ...snapshot(action.name === 'snapshot') });
  });
})();
