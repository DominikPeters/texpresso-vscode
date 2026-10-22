/* Injected monitor: records only successfully mounted production frames. */
(() => {
  const api = acquireVsCodeApi(), frames = new Map();
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const snapshot = () => {
    const viewport = document.getElementById('viewport'), clip = viewport.getBoundingClientRect();
    return { toolbar: Number(document.getElementById('page').value) - 1, count: document.getElementById('total').textContent,
      scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft, visibility: document.visibilityState,
      shells: [...document.querySelectorAll('.page-sheet')].map(sheet => { const r = sheet.getBoundingClientRect(); return {
        page: Number(sheet.dataset.page), top: r.top - clip.top, bottom: r.bottom - clip.top,
        visible: r.bottom > clip.top && r.top < clip.bottom,
        sequence: frames.get(Number(sheet.dataset.page))?.sequence
      }; }) };
  };
  window.variedApi = () => ({ getState: () => ({ page: 0, format: __CODEC__, zoom: 'width' }), setState: () => {}, postMessage: m => api.postMessage(m) });
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
    const action = m.variedAction;
    if (action.name === 'page') {
      const input = document.getElementById('page'); input.value = String(action.page + 1); input.dispatchEvent(new Event('change'));
    }
    await paint(); api.postMessage({ varied: 'action', action: action.id, ...snapshot() });
  });
})();
