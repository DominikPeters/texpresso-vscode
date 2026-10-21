/* global acquireVsCodeApi, TexpressoLensCache */
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
  let highlightTimer;
  let phase = 'running', timer, lastWidth = 0, lastRequestedPage = -1, restoreScroll = true;
  const post = message => vscode.postMessage({ instance, ...message });
  const save = () => vscode.setState({ page, zoom, left: viewport.scrollLeft, top: viewport.scrollTop });
  const width = () => Math.min(4096, Math.max(1, Math.ceil(sheet.getBoundingClientRect().width * window.devicePixelRatio)));

  function describe() {
    element('page').value = String(page + 1);
    element('total').textContent = complete ? `/ ${count}` : '/ …';
    element('previous').disabled = page === 0;
    element('next').disabled = complete && page + 1 >= count;
    element('pauseIcon').hidden = paused; element('resumeIcon').hidden = !paused;
    element('pause').title = paused ? 'Resume compilation' : 'Pause compilation';
    element('pause').setAttribute('aria-label', element('pause').title);
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
      scale = Math.max(0.05, (viewport.clientWidth) / pageWidth);
      if (zoom === 'page') { scale = Math.min(scale, Math.max(0.05, (viewport.clientHeight) / pageHeight)); }
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
    closeLens();
    page = Math.max(0, Math.min(100000, value));
    if (complete && count > 0) { page = Math.min(page, count - 1); }
    stale = true; generation++; element('highlight').hidden = true;
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    describe(); layout();
  }
  function changeZoom(value) { closeLens(); zoom = value; layout(); }
  function stepZoom(factor) {
    const effective = (bounds[2] - bounds[0]) ? sheet.getBoundingClientRect().width / (bounds[2] - bounds[0]) * 72 / 96 : 1;
    changeZoom(Math.round(Math.min(4, Math.max(0.25, effective * factor)) * 100) / 100);
  }
  function highlight(target) {
    if (!header || stale || target.page !== header.page) { return; }
    const mark = element('highlight');
    mark.style.left = `${100 * (target.x - bounds[0]) / (bounds[2] - bounds[0])}%`;
    mark.style.top = `${100 * (target.y - bounds[1]) / (bounds[3] - bounds[1])}%`;
    clearTimeout(highlightTimer);
    mark.hidden = true;
    void mark.offsetWidth; // Restart the animation for a new forward search.
    mark.hidden = false;
    highlightTimer = setTimeout(() => { mark.hidden = true; }, 1500);
    requestAnimationFrame(() => mark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  }

  const lens = element('lens'), lensBase = element('lensBase');
  let lensImage = element('lensImage');
  const lensCache = new TexpressoLensCache();
  const lensSize = 240, magnification = 2.5;
  let magnify = false, regions = false, pointer, lensUrl, lensHeader;
  function closeLens() {
    pointer = undefined; lensCache.reset(); lens.hidden = true;
    lensHeader = undefined; lensImage.hidden = true;
    post({ type: 'cancel-region' });
    if (lensUrl) { URL.revokeObjectURL(lensUrl); lensUrl = undefined; }
  }
  function setMagnify(value) {
    magnify = value && regions; closeLens();
    viewport.classList.toggle('magnify', magnify);
    element('magnify').setAttribute('aria-pressed', String(magnify));
  }
  function positionLens() {
    if (!pointer || stale || !header) { return; }
    const rect = image.getBoundingClientRect(), scale = rect.width / (bounds[2] - bounds[0]);
    const left = Math.max(0, Math.min(window.innerWidth - lensSize, pointer.clientX - lensSize / 2));
    const top = Math.max(0, Math.min(window.innerHeight - lensSize, pointer.clientY - lensSize / 2));
    lens.style.left = `${left}px`; lens.style.top = `${top}px`;
    // A cached copy of the current image follows the pointer immediately while
    // the sharp, clipped rendering is in flight. No extra full-page raster.
    if (lensBase.src !== image.src) { lensBase.src = image.src; }
    lensBase.style.width = `${rect.width * magnification}px`;
    lensBase.style.left = `${lensSize / 2 - (pointer.clientX - rect.left) * magnification}px`;
    lensBase.style.top = `${lensSize / 2 - (pointer.clientY - rect.top) * magnification}px`;
    if (lensHeader) {
      lensImage.style.width = `${(lensHeader.bounds[2] - lensHeader.bounds[0]) * scale * magnification}px`;
      lensImage.style.left = `${lensSize / 2 + (lensHeader.bounds[0] - pointer.x) * scale * magnification}px`;
      lensImage.style.top = `${lensSize / 2 + (lensHeader.bounds[1] - pointer.y) * scale * magnification}px`;
    }
    lens.hidden = false;
  }
  function requestLens() {
    if (!pointer || stale || !header) { return; }
    const scale = image.getBoundingClientRect().width / (bounds[2] - bounds[0]);
    const request = lensCache.request(pointer, bounds, lensSize / (scale * magnification),
      scale * magnification * window.devicePixelRatio);
    if (request) {
      post({ type: 'region', ...request, revision: header.revision, sequence: header.sequence, page: header.page });
    }
  }
  function moveLens(event) {
    const rect = image.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { closeLens(); return; }
    pointer = { clientX: event.clientX, clientY: event.clientY,
      x: bounds[0] + (event.clientX - rect.left) / rect.width * (bounds[2] - bounds[0]),
      y: bounds[1] + (event.clientY - rect.top) / rect.height * (bounds[3] - bounds[1]) };
    positionLens();
    requestLens();
  }
  element('magnify').onclick = () => { setMagnify(!magnify); viewport.focus({ preventScroll: true }); };
  image.addEventListener('pointerdown', event => {
    if (!magnify || stale || !header || event.button !== 0 || event.ctrlKey || event.metaKey) { return; }
    event.preventDefault(); viewport.focus({ preventScroll: true }); image.setPointerCapture(event.pointerId); moveLens(event);
  });
  image.addEventListener('pointermove', event => { if (pointer) { moveLens(event); } });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) { image.addEventListener(name, closeLens); }
  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport) { return; }
    if (event.key.toLowerCase() === 'm' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); setMagnify(!magnify); }
    if (event.key === 'Escape') { setMagnify(false); }
  });
  window.addEventListener('blur', closeLens);

  window.addEventListener('message', async event => {
    const m = event.data;
    if (!m || m.instance !== instance) { return; }
    switch (m.type) {
      case 'ping': ready(); break;
      case 'state':
        count = m.count; complete = m.complete; paused = m.paused; phase = m.phase; regions = m.regions === true;
        element('magnify').disabled = !regions;
        element('magnify').title = regions ? 'Magnifier: hold the mouse button on the page (M)' : 'Magnifier requires a newer TeXpresso build';
        if (page !== m.page) {
          closeLens(); page = m.page; stale = true; generation++; element('highlight').hidden = true; layout();
        }
        describe(); break;
      case 'invalidate': closeLens(); stale = true; generation++; element('highlight').hidden = true; describe(); break;
      case 'error': closeLens(); stale = true; status.textContent = m.text; status.classList.add('error'); break;
      case 'target': highlight(m); break;
      case 'region-error': closeLens(); break;
      case 'region': {
        const url = URL.createObjectURL(new Blob([m.bytes], { type: m.header.mime }));
        const candidate = new Image(); candidate.src = url;
        try {
          await candidate.decode();
          if (!pointer || stale || !header || m.token !== lensCache.pending?.token || m.header.revision !== header.revision ||
              m.header.sequence !== header.sequence || m.header.page !== header.page) { URL.revokeObjectURL(url); }
          else {
            const previous = lensUrl;
            lensCache.accept(m.token, m.header);
            lensUrl = url; lensHeader = m.header;
            // Swap in the already decoded element; keep the old pixels visible
            // throughout rendering/decoding instead of clearing an image src.
            candidate.id = 'lensImage'; candidate.alt = 'Magnified page region'; candidate.draggable = false;
            lensImage.replaceWith(candidate); lensImage = candidate; positionLens();
            if (previous) { requestAnimationFrame(() => URL.revokeObjectURL(previous)); }
          }
        } catch { URL.revokeObjectURL(url); closeLens(); }
        post({ type: 'decoded', id: m.header.requestId });
        requestLens(); break;
      }
      case 'image': {
        closeLens();
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
  viewport.addEventListener('scroll', () => { closeLens(); save(); }, { passive: true });
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
  window.addEventListener('resize', () => { closeLens(); layout(); });
  window.addEventListener('pagehide', () => { closeLens(); clearTimeout(timer); clearTimeout(highlightTimer); if (objectUrl) { URL.revokeObjectURL(objectUrl); } });
  ready();
})();
