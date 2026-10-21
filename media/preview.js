/* global acquireVsCodeApi */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const instance = document.body.dataset.instance;
  const element = id => document.getElementById(id);
  const viewport = element('viewport'), sheet = element('sheet'), image = element('image');
  const status = element('status'), zoomSelect = element('zoom');
  const saved = vscode.getState() || {};
  let page = Number.isInteger(saved.page) && saved.page >= 0 ? saved.page : 0;
  let zoom = ['width', 'page'].includes(saved.zoom) || (Number(saved.zoom) >= 0.25 && Number(saved.zoom) <= 4) ? saved.zoom : 'width';
  let bounds = [0, 0, 595.28, 841.89];
  let header, objectUrl, stale = true, generation = 0, count = 0, complete = false, paused = false;
  let phase = 'running', timer, lastWidth = 0, lastRequestedPage = -1, restoreScroll = true;
  const post = message => vscode.postMessage({ instance, ...message });
  const save = () => vscode.setState({ page, zoom, left: viewport.scrollLeft, top: viewport.scrollTop });
  const width = () => Math.min(4096, Math.max(1, Math.ceil(sheet.getBoundingClientRect().width * window.devicePixelRatio)));

  function describe() {
    element('page').value = String(page + 1);
    element('total').textContent = complete ? `/ ${count}` : '/ …';
    element('previous').disabled = page === 0;
    element('next').disabled = complete && page + 1 >= count;
    element('pause').textContent = paused ? 'Resume' : 'Pause';
    element('pause').disabled = phase !== 'running';
    status.classList.remove('error');
    status.textContent = phase === 'failed' ? 'Preview stopped. Open Output or the engine log for details.' :
      phase === 'stopped' ? 'Preview stopped.' : paused ? 'Compilation paused' :
      stale ? (header ? 'Updating preview…' : 'Waiting for the first page…') :
      'Control or Command click to open source';
  }

  function layout(request = true) {
    const pageWidth = bounds[2] - bounds[0], pageHeight = bounds[3] - bounds[1];
    let scale = Number(zoom) * 96 / 72;
    if (zoom === 'width' || zoom === 'page') {
      scale = Math.max(0.05, (viewport.clientWidth - 48) / pageWidth);
      if (zoom === 'page') { scale = Math.min(scale, Math.max(0.05, (viewport.clientHeight - 48) / pageHeight)); }
    }
    sheet.style.width = `${pageWidth * scale}px`;
    sheet.style.aspectRatio = `${pageWidth} / ${pageHeight}`;
    // The empty sheet still participates in measurement before the first image.
    if (!header) { sheet.hidden = false; sheet.classList.add('waiting'); }
    let option = [...zoomSelect.options].find(option => option.value === String(zoom));
    if (!option) {
      option = document.createElement('option'); option.value = String(zoom);
      option.textContent = `${Math.round(Number(zoom) * 100)}%`; zoomSelect.appendChild(option);
    }
    zoomSelect.value = String(zoom);
    if (request) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const pixels = width();
        if (pixels !== lastWidth || page !== lastRequestedPage) {
          lastWidth = pixels; lastRequestedPage = page;
          post({ type: 'viewport', page, width: pixels });
        }
      }, 100);
    }
    save();
  }

  function ready() {
    layout(false); lastWidth = width(); lastRequestedPage = page;
    post({ type: 'ready', page, width: lastWidth });
  }
  function navigate(value) {
    page = Math.max(0, Math.min(100000, value));
    if (complete && count > 0) { page = Math.min(page, count - 1); }
    stale = true; generation++; element('highlight').hidden = true;
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    describe(); layout();
  }
  function changeZoom(value) { zoom = value; layout(); }
  function stepZoom(factor) {
    const effective = (bounds[2] - bounds[0]) ? sheet.getBoundingClientRect().width / (bounds[2] - bounds[0]) * 72 / 96 : 1;
    changeZoom(Math.round(Math.min(4, Math.max(0.25, effective * factor)) * 100) / 100);
  }
  function highlight(target) {
    if (!header || stale || target.page !== header.page) { return; }
    const mark = element('highlight');
    mark.style.left = `${100 * (target.x - bounds[0]) / (bounds[2] - bounds[0])}%`;
    mark.style.top = `${100 * (target.y - bounds[1]) / (bounds[3] - bounds[1])}%`;
    mark.hidden = false;
    requestAnimationFrame(() => mark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  }

  window.addEventListener('message', async event => {
    const m = event.data;
    if (!m || m.instance !== instance) { return; }
    switch (m.type) {
      case 'ping': ready(); break;
      case 'state':
        count = m.count; complete = m.complete; paused = m.paused; phase = m.phase;
        if (page !== m.page) {
          page = m.page; stale = true; generation++; element('highlight').hidden = true; layout();
        }
        describe(); break;
      case 'invalidate': stale = true; generation++; element('highlight').hidden = true; describe(); break;
      case 'error': stale = true; status.textContent = m.text; status.classList.add('error'); break;
      case 'target': highlight(m); break;
      case 'image': {
        const token = ++generation;
        const url = URL.createObjectURL(new Blob([m.bytes], { type: m.header.mime }));
        const candidate = new Image(); candidate.src = url;
        try {
          await candidate.decode();
          if (token !== generation) { URL.revokeObjectURL(url); post({ type: 'decoded', id: m.header.requestId }); break; }
          const previous = objectUrl;
          objectUrl = url; image.src = url; header = m.header; bounds = header.bounds; page = header.page;
          stale = false; sheet.hidden = false; sheet.classList.remove('waiting'); element('empty').hidden = true;
          image.alt = `Rendered LaTeX page ${page + 1}`;
          layout(); describe();
          if (restoreScroll) {
            viewport.scrollLeft = Number(saved.left) || 0; viewport.scrollTop = Number(saved.top) || 0; restoreScroll = false;
          }
          if (previous) { URL.revokeObjectURL(previous); }
          if (m.target) { highlight(m.target); }
          post({ type: 'decoded', id: header.requestId });
        } catch {
          URL.revokeObjectURL(url); post({ type: 'decode-error', id: m.header.requestId });
        }
        break;
      }
    }
  });
  element('previous').onclick = () => navigate(page - 1);
  element('next').onclick = () => navigate(page + 1);
  element('page').onchange = event => { const number = Number(event.target.value); if (Number.isInteger(number) && number > 0) { navigate(number - 1); } };
  element('zoomIn').onclick = () => stepZoom(1.25);
  element('zoomOut').onclick = () => stepZoom(0.8);
  zoomSelect.onchange = () => changeZoom(zoomSelect.value);
  for (const id of ['restart', 'pause', 'output']) { element(id).onclick = () => post({ type: id }); }
  viewport.addEventListener('scroll', save, { passive: true });
  viewport.addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey) { event.preventDefault(); stepZoom(event.deltaY < 0 ? 1.1 : 1 / 1.1); }
  }, { passive: false });
  viewport.addEventListener('keydown', event => {
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault(); navigate(page + (event.key === 'PageDown' ? 1 : -1));
    }
  });
  image.addEventListener('click', event => {
    if (stale || !header || !(event.ctrlKey || event.metaKey)) { return; }
    const rect = image.getBoundingClientRect();
    post({ type: 'inverse', revision: header.revision, sequence: header.sequence, page: header.page,
      x: bounds[0] + (event.clientX - rect.left) / rect.width * (bounds[2] - bounds[0]),
      y: bounds[1] + (event.clientY - rect.top) / rect.height * (bounds[3] - bounds[1]) });
  });
  window.addEventListener('resize', () => layout());
  window.addEventListener('pagehide', () => { clearTimeout(timer); if (objectUrl) { URL.revokeObjectURL(objectUrl); } });
  ready();
})();
