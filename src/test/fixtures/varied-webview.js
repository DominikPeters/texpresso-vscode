/* Injected observer. Production owns decoding, rendering, scheduling and recovery. */
(() => {
  const api = acquireVsCodeApi(), frames = new Map(), receiving = new Map();
  const paint = () => new Promise(resolve => requestAnimationFrame(() => {
    const firstRafAt = performance.now();
    requestAnimationFrame(() => resolve({ firstRafAt, paintAt: performance.now() }));
  }));
  window.variedReceiving = (header, at) => {
    receiving.set(header.requestId, { receivedAt: at, timeOrigin: performance.timeOrigin });
    while (receiving.size > 64) { receiving.delete(receiving.keys().next().value); }
  };
  const longTasks = [];
  let observer;
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
        if (longTasks.length > 128) { longTasks.shift(); }
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  }
  let lastTick = performance.now(), lastReport = lastTick;
  const scheduler = setInterval(() => {
    const at = performance.now(), lag = Math.max(0, at - lastTick - 100); lastTick = at;
    if (lag > 25 || longTasks.length || at - lastReport >= 1000) {
      api.postMessage({ varied: 'scheduler', at, timeOrigin: performance.timeOrigin, lag,
        visibility: document.visibilityState, focused: document.hasFocus(), longTasks: longTasks.splice(0) });
      lastReport = at;
    }
  }, 100);
  document.addEventListener('visibilitychange', () => api.postMessage({ varied: 'visibility',
    at: performance.now(), timeOrigin: performance.timeOrigin, visibility: document.visibilityState, focused: document.hasFocus() }));
  window.addEventListener('pagehide', () => { clearInterval(scheduler); observer?.disconnect(); });
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
  window.variedApi = () => ({ getState: () => api.getState() || ({ page: 0, format: __CODEC__, zoom: 'width' }), setState: value => api.setState(value), postMessage: m => {
    if (m.type === 'decoded') {
      const timing = receiving.get(m.id);
      if (timing) { timing.ackAt = performance.now(); m = { ...m, profileTiming: { ...timing } }; receiving.delete(m.id); }
    }
    api.postMessage(m);
  } });
  window.variedAccepted = (header, contentId, detail) => {
    const timing = receiving.get(header.requestId) || { timeOrigin: performance.timeOrigin };
    const committedAt = performance.now();
    const sheet = document.querySelector(`.page-sheet[data-page="${header.page}"]`);
    const clip = document.getElementById('viewport').getBoundingClientRect(), rect = sheet?.getBoundingClientRect();
    Object.assign(timing, detail, { committedAt, visible: !!rect && rect.bottom > clip.top && rect.top < clip.bottom,
      visibility: document.visibilityState, focused: document.hasFocus(), visibilityProbeMs: performance.now() - committedAt });
    frames.set(header.page, header);
    paint().then(frameTiming => {
      const beforeSnapshot = performance.now(), view = snapshot();
      api.postMessage({ varied: 'paint', header, contentId,
        timing: { ...timing, ...frameTiming, snapshotMs: performance.now() - beforeSnapshot },
        superseded: frames.get(header.page)?.requestId !== header.requestId, ...view });
    });
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
