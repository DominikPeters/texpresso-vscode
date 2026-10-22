/* global acquireVsCodeApi, TexpressoLensCache, TexpressoViewport, TexpressoImageCache, TexpressoSvgPage, TexpressoPngPage */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const instance = document.body.dataset.instance;
  const element = id => document.getElementById(id);
  const viewport = element('viewport'), sheet = element('sheet'), image = element('image');
  const status = element('status'), zoomSelect = element('zoom'), formatSelect = element('format');
  const saved = vscode.getState() || {};
  let page = Number.isInteger(saved.page) && saved.page >= 0 ? saved.page : 0;
  let zoom = ['width', 'page'].includes(saved.zoom) || (Number(saved.zoom) >= 0.25 && Number(saved.zoom) <= 4) ? saved.zoom : 'width';
  let format = ['png', 'svg'].includes(saved.format) ? saved.format : 'auto';
  let bounds = [0, 0, 595.28, 841.89];
  const images = new TexpressoImageCache(entry => { if (entry.url) { URL.revokeObjectURL(entry.url); } if (entry.vector) { (entry.vector.layer || entry.vector.root).remove(); } if (entry.raster) { entry.raster.canvas.remove(); entry.raster.canvas.width = 0; } });
  const vector = element('vector'), lensVector = element('lensVector'), raster = element('raster'), lensCanvas = element('lensCanvas');
  let svgPage, pngPage;
  const surface = () => svgPage ? vector : pngPage ? raster : image;
  const acknowledge = (id, renderMs) => post({ type: 'decoded', id, cached: images.keys(), svg: svgPage?.contentId, png: pngPage?.contentId, renderMs });
  let imageId;
  let header, objectUrl, stale = true, generation = 0, count = 0, complete = false, paused = false;
  let highlightTimer;
  let problem = '';
  let phase = 'running', timer, lastWidth = 0, lastRequestedPage = -1, restoreScroll = true;
  const post = message => vscode.postMessage({ instance, ...message });
  const save = () => vscode.setState({ page, zoom, format, left: viewport.scrollLeft, top: viewport.scrollTop });
  const { clamp, wheelFactor, scrollCorrection, rasterWidth, DetailCache } = TexpressoViewport;
  const width = () => format === 'svg' ? 1200 : rasterWidth(bounds, sheet.getBoundingClientRect().width, window.devicePixelRatio);
  let customZoomOption, pinchAnchor, pinchOrigin, lastPinchTime = 0;

  function describe() {
    element('page').value = String(page + 1);
    element('total').textContent = complete ? `/ ${count}` : '/ …';
    element('previous').disabled = page === 0;
    element('next').disabled = complete && page + 1 >= count;
    element('pauseIcon').hidden = paused; element('resumeIcon').hidden = !paused;
    element('pause').title = paused ? 'Resume compilation' : 'Pause compilation';
    element('pause').setAttribute('aria-label', element('pause').title);
    element('pause').disabled = phase !== 'running';
    // Normal compilation and source hints need no banner or layout change.
    // Keep actionable failures visible until a new source attempt or good frame.
    const text = problem || (phase === 'failed' ? 'Preview stopped. Open Output or the engine log for details.' : '');
    status.hidden = !text; status.textContent = text;
    status.classList.toggle('error', !!text);
    formatSelect.value = format;
    formatSelect.title = header?.fallback ? `Rendering format. PNG fallback: ${header.fallback}` : 'Rendering format';
  }

  function layout(request = true, immediate = false) {
    const pageWidth = bounds[2] - bounds[0], pageHeight = bounds[3] - bounds[1];
    let scale = Number(zoom) * 96 / 72;
    if (zoom === 'width' || zoom === 'page') {
      scale = Math.max(0.05, (viewport.clientWidth) / pageWidth);
      if (zoom === 'page') { scale = Math.min(scale, Math.max(0.05, (viewport.clientHeight) / pageHeight)); }
    }
    sheet.style.width = `${pageWidth * scale}px`;
    sheet.style.height = `${pageHeight * scale}px`;
    sheet.style.aspectRatio = `${pageWidth} / ${pageHeight}`;
    // The empty sheet still participates in measurement before the first image.
    if (!header) { sheet.hidden = false; sheet.classList.add('waiting'); }
    let option = [...zoomSelect.options].find(option => option.value === String(zoom));
    if (!option) {
      if (!customZoomOption) { customZoomOption = document.createElement('option'); zoomSelect.appendChild(customZoomOption); }
      customZoomOption.value = String(zoom); customZoomOption.textContent = `${Math.round(Number(zoom) * 100)}%`;
    }
    zoomSelect.value = String(zoom);
    if (request) {
      clearTimeout(timer);
      const requestViewport = () => {
        const pixels = width();
        if (pixels !== lastWidth || page !== lastRequestedPage) {
          lastWidth = pixels; lastRequestedPage = page;
          post({ type: 'viewport', page, width: pixels, format });
        }
      };
      // Explicit page/format choices should not wait for the gesture debounce.
      if (immediate) { requestViewport(); } else { timer = setTimeout(requestViewport, 100); }
    }
    scheduleDetail();
    save();
  }

  function ready() {
    layout(false); lastWidth = width(); lastRequestedPage = page;
    post({ type: 'ready', page, width: lastWidth, format, svgDom: true, pngCanvas: true });
  }
  function navigate(value) {
    closeLens();
    page = Math.max(0, Math.min(100000, value));
    if (complete && count > 0) { page = Math.min(page, count - 1); }
    element('links').replaceChildren(); clearDetail(); stale = true; generation++; element('highlight').hidden = true;
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    describe(); layout(true, true);
  }
  function changeZoom(value, origin, anchor) {
    closeLens();
    if (!anchor) { pinchAnchor = undefined; }
    const before = sheet.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    origin ||= { x: view.left + viewport.clientWidth / 2, y: view.top + viewport.clientHeight / 2 };
    zoom = value; layout();
    if (before.width && before.height) {
      // Measure both rectangles: page centering and scrollbar appearance also
      // move the page, so a scale-only scroll offset would drift at fit width.
      const delta = scrollCorrection(before, sheet.getBoundingClientRect(), origin, anchor);
      const left = viewport.scrollLeft + delta.x, top = viewport.scrollTop + delta.y;
      const clippedX = left < 0 || left > viewport.scrollWidth - viewport.clientWidth;
      const clippedY = top < 0 || top > viewport.scrollHeight - viewport.clientHeight;
      viewport.scrollLeft = left; viewport.scrollTop = top;
      if (anchor && (clippedX || clippedY)) {
        // At the page boundary the browser cannot preserve the requested
        // origin. Rebase that axis instead of accumulating unreachable scroll.
        const actual = sheet.getBoundingClientRect();
        if (clippedX) { anchor.x = (origin.x - actual.left) / actual.width; }
        if (clippedY) { anchor.y = (origin.y - actual.top) / actual.height; }
      }
    }
    save();
  }
  function stepZoom(factor, origin, anchor) {
    if (factor === 1) { return; }
    const effective = Number(zoom) || sheet.getBoundingClientRect().width / (bounds[2] - bounds[0]) * 72 / 96;
    const next = clamp(effective * factor, 0.25, 4);
    if (next !== effective) { changeZoom(next, origin, anchor); }
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

  let detailImage = element('detail'), detailUrl, detailTimer, detailFailed = false, autoRefining = false;
  const detailCache = new DetailCache();
  function clearDetail() {
    clearTimeout(detailTimer); detailCache.reset(); detailFailed = false;
    detailImage.hidden = true; post({ type: 'cancel-detail' });
    if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = undefined; }
  }
  function scheduleDetail() {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(requestDetail, 120);
  }
  function requestDetail() {
    if (stale || !header || header.mime === 'image/svg+xml' || autoRefining || !regions || detailFailed) { return; }
    const view = viewport.getBoundingClientRect();
    const request = detailCache.request(bounds, surface().getBoundingClientRect(),
      { left: view.left + viewport.clientLeft, top: view.top + viewport.clientTop,
        right: view.left + viewport.clientLeft + viewport.clientWidth,
        bottom: view.top + viewport.clientTop + viewport.clientHeight }, window.devicePixelRatio, header.width);
    if (request) { post({ type: 'detail', ...request, revision: header.revision, sequence: header.sequence, page: header.page }); }
  }
  async function receiveDetail(m) {
    const url = URL.createObjectURL(new Blob([m.bytes], { type: m.header.mime }));
    const candidate = new Image(); candidate.src = url;
    try {
      await candidate.decode();
      if (stale || !header || m.token !== detailCache.pending?.token || m.header.revision !== header.revision ||
          m.header.sequence !== header.sequence || m.header.page !== header.page) { URL.revokeObjectURL(url); }
      else {
        const previous = detailUrl, b = m.header.bounds;
        detailCache.accept(m.token, m.header); detailUrl = url;
        candidate.id = 'detail'; candidate.alt = ''; candidate.draggable = false;
        candidate.style.left = `${100 * (b[0] - bounds[0]) / (bounds[2] - bounds[0])}%`;
        candidate.style.top = `${100 * (b[1] - bounds[1]) / (bounds[3] - bounds[1])}%`;
        candidate.style.width = `${100 * (b[2] - b[0]) / (bounds[2] - bounds[0])}%`;
        candidate.style.height = `${100 * (b[3] - b[1]) / (bounds[3] - bounds[1])}%`;
        detailImage.replaceWith(candidate); detailImage = candidate;
        if (previous) { requestAnimationFrame(() => URL.revokeObjectURL(previous)); }
      }
    } catch { URL.revokeObjectURL(url); detailFailed = true; detailCache.reset(); }
    post({ type: 'decoded', id: m.header.requestId });
    scheduleDetail();
  }

  const lens = element('lens'), lensBase = element('lensBase');
  let lensImage = element('lensImage');
  const lensCache = new TexpressoLensCache();
  const lensSize = 240, magnification = 2.5;
  let magnify = false, regions = false, pointer, lensUrl, lensHeader;
  function closeLens() {
    pointer = undefined; lensCache.reset(); lens.hidden = true;
    lensHeader = undefined; lensImage.hidden = true; lensVector.hidden = true; lensVector.replaceChildren(); lensCanvas.hidden = true; lensCanvas.width = 0;
    post({ type: 'cancel-region' });
    if (lensUrl) { URL.revokeObjectURL(lensUrl); lensUrl = undefined; }
  }
  function setMagnify(value) {
    magnify = value && (regions || header?.mime === 'image/svg+xml'); closeLens();
    viewport.classList.toggle('magnify', magnify);
    element('magnify').setAttribute('aria-pressed', String(magnify));
  }
  function positionLens() {
    if (!pointer || stale || !header) { return; }
    const rect = surface().getBoundingClientRect(), scale = rect.width / (bounds[2] - bounds[0]);
    const left = Math.max(0, Math.min(window.innerWidth - lensSize, pointer.clientX - lensSize / 2));
    const top = Math.max(0, Math.min(window.innerHeight - lensSize, pointer.clientY - lensSize / 2));
    lens.style.left = `${left}px`; lens.style.top = `${top}px`;
    // A cached copy of the current image follows the pointer immediately while
    // the sharp, clipped rendering is in flight. No extra full-page raster.
    lensBase.hidden = !!svgPage || !!pngPage;
    lensCanvas.hidden = !pngPage;
    if (svgPage) {
      if (!lensVector.firstChild) { lensVector.appendChild(svgPage.clone()); }
      lensVector.hidden = false;
      lensVector.style.width = `${rect.width * magnification}px`;
      lensVector.style.left = `${lensSize / 2 - (pointer.clientX - rect.left) * magnification}px`;
      lensVector.style.top = `${lensSize / 2 - (pointer.clientY - rect.top) * magnification}px`;
    } else if (pngPage) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), size = Math.ceil(lensSize * dpr);
      if (lensCanvas.width !== size) { lensCanvas.width = size; lensCanvas.height = size; }
      lensCanvas.style.width = `${lensSize}px`; lensCanvas.style.left = '0px'; lensCanvas.style.top = '0px';
      const ctx = lensCanvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, lensSize, lensSize);
      ctx.drawImage(pngPage.canvas, lensSize / 2 - (pointer.clientX - rect.left) * magnification,
        lensSize / 2 - (pointer.clientY - rect.top) * magnification, rect.width * magnification, rect.height * magnification);
    } else if (lensBase.src !== image.src) { lensBase.src = image.src; }
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
    if (!pointer || stale || !header || header.mime === 'image/svg+xml') { return; }
    const scale = surface().getBoundingClientRect().width / (bounds[2] - bounds[0]);
    const request = lensCache.request(pointer, bounds, lensSize / (scale * magnification),
      scale * magnification * window.devicePixelRatio);
    if (request) {
      post({ type: 'region', ...request, revision: header.revision, sequence: header.sequence, page: header.page });
    }
  }
  function moveLens(event) {
    const rect = surface().getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { closeLens(); return; }
    pointer = { clientX: event.clientX, clientY: event.clientY,
      x: bounds[0] + (event.clientX - rect.left) / rect.width * (bounds[2] - bounds[0]),
      y: bounds[1] + (event.clientY - rect.top) / rect.height * (bounds[3] - bounds[1]) };
    positionLens();
    requestLens();
  }
  element('magnify').onclick = () => { setMagnify(!magnify); viewport.focus({ preventScroll: true }); };
  sheet.addEventListener('pointerdown', event => {
    if (!magnify || stale || !header || event.button !== 0 || event.ctrlKey || event.metaKey || event.target.closest('.page-link')) { return; }
    event.preventDefault(); viewport.focus({ preventScroll: true }); sheet.setPointerCapture(event.pointerId); moveLens(event);
  });
  sheet.addEventListener('pointermove', event => { if (pointer) { moveLens(event); } });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) { sheet.addEventListener(name, closeLens); }
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
        if (m.phase === 'starting' && phase !== 'starting') { problem = ''; }
        count = m.count; complete = m.complete; paused = m.paused; phase = m.phase; regions = m.regions === true;
        const vectorReady = header?.mime === 'image/svg+xml';
        element('magnify').disabled = !regions && !vectorReady;
        element('format').querySelector('[value=svg]').disabled = !m.svg;
        if (!m.svg && format === 'svg') { format = 'png'; ready(); }
        element('magnify').title = (regions || vectorReady) ? 'Magnifier: hold the mouse button on the page (M)' : 'Magnifier requires a newer TeXpresso build';
        if (page !== m.page) {
          closeLens(); clearDetail(); page = m.page; stale = true; generation++; element('highlight').hidden = true; layout();
        }
        describe(); break;
      case 'invalidate': problem = ''; element('links').replaceChildren(); closeLens(); clearDetail(); stale = true; generation++; element('highlight').hidden = true; describe(); break;
      case 'error': element('links').replaceChildren(); closeLens(); clearDetail(); stale = true; problem = m.text; describe(); break;
      case 'link-error': problem = m.text; describe(); break;
      case 'target': highlight(m); break;
      case 'region-error':
        if (m.purpose === 'detail') { detailCache.reset(); detailFailed = true; } else { closeLens(); }
        break;
      case 'refinement-end': autoRefining = false; scheduleDetail(); break;
      case 'detail': await receiveDetail(m); break;
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
        const renderStart = performance.now();
        autoRefining = m.refining === true;
        closeLens(); clearDetail();
        const token = ++generation;
        const cached = images.get(m.contentId);
        if (!cached && !m.bytes && !m.svgPatch && !m.rasterPatch) { post({ type: 'cache-miss', id: m.header.requestId }); break; }
        let url, candidate, nextVector, nextRaster, commitRaster;
        try {
          if (m.svgPatch) {
            if (!svgPage || svgPage.contentId !== m.svgPatch.base) { throw Error('SVG patch base unavailable'); }
            images.take(svgPage.contentId);
            svgPage.patch(m.svgPatch, m.contentId); nextVector = svgPage;
          } else if (cached?.vector) { nextVector = cached.vector; }
          else if (m.inlineSvg && m.bytes) { nextVector = TexpressoSvgPage.create(new TextDecoder().decode(m.bytes), m.contentId); }
          if (cached?.raster) { nextRaster = cached.raster; }
          else if (m.rasterPatch) {
            if (!pngPage || pngPage.canvas.width !== m.header.width || pngPage.canvas.height !== m.header.height) { throw Error('PNG patch base unavailable'); }
            commitRaster = await pngPage.prepare(m.rasterPatch, m.bytes);
            nextRaster = pngPage;
          } else if (m.inlinePng && m.bytes) { nextRaster = await TexpressoPngPage.create(m.bytes, m.header.width, m.header.height, m.contentId); }
          if (!nextVector && !nextRaster) {
            url = cached ? cached.url : URL.createObjectURL(new Blob([m.bytes], { type: m.header.mime }));
            candidate = cached ? cached.image : new Image();
            if (!cached) { candidate.src = url; await candidate.decode(); }
          }
          if (token !== generation) { if (url && !cached) { URL.revokeObjectURL(url); }
            if (nextRaster && nextRaster !== pngPage && !cached) { nextRaster.canvas.width = 0; }
            acknowledge(m.header.requestId); break; }
          if (commitRaster) {
            images.take(pngPage.contentId); commitRaster(); nextRaster.contentId = m.contentId;
          }
          // The idle SVG supersedes this page's transient PNG. Keeping both
          // decoded versions evicts useful neighboring pages from the LRU.
          if (format === 'auto' && nextVector && pngPage && header && header.page === m.header.page &&
              header.revision === m.header.revision && header.sequence === m.header.sequence) {
            images.forget(pngPage.contentId);
          }
          const previous = objectUrl, previousId = imageId;
          if (!cached || m.svgPatch || commitRaster) {
            const rect = sheet.getBoundingClientRect();
            const pixels = m.header.mime === 'image/png' ? m.header.width * m.header.height :
              Math.ceil(rect.width * devicePixelRatio) * Math.ceil(rect.height * devicePixelRatio);
            images.put(m.contentId, nextVector ? { vector: nextVector } : nextRaster ? { raster: nextRaster } : { url, image: candidate }, m.header.byteLength + pixels * 4);
          }
          if (svgPage && svgPage !== nextVector) {
            if (!images.has(svgPage.contentId)) { svgPage.layer?.remove(); }
            else { svgPage.layer?.classList.remove('active'); }
          }
          if (pngPage && pngPage !== nextRaster && !images.has(pngPage.contentId)) { pngPage.canvas.remove(); pngPage.canvas.width = 0; }
          imageId = m.contentId; svgPage = nextVector; pngPage = nextRaster;
          vector.hidden = !svgPage; raster.hidden = !pngPage; image.hidden = !!svgPage || !!pngPage;
          if (svgPage) {
            if (!svgPage.layer) {
              svgPage.layer = document.createElement('div'); svgPage.layer.className = 'texpresso-svg-layer';
              svgPage.layer.appendChild(svgPage.root);
            }
            if (svgPage.layer.parentNode !== vector) { vector.appendChild(svgPage.layer); }
            svgPage.layer.classList.add('active');
          } else if (pngPage) { raster.replaceChildren(pngPage.canvas); } else { image.src = url; }
          objectUrl = url; header = m.header; bounds = header.bounds; page = header.page;
          problem = ''; stale = false; sheet.hidden = false; sheet.classList.remove('waiting'); element('empty').hidden = true;
          image.alt = `Rendered LaTeX page ${page + 1}`;
          layout(); describe(); renderLinks();
          if (restoreScroll) {
            viewport.scrollLeft = Number(saved.left) || 0; viewport.scrollTop = Number(saved.top) || 0; restoreScroll = false;
          }
          if (previous && previous !== url && !images.has(previousId)) { URL.revokeObjectURL(previous); }
          if (m.target) { highlight(m.target); }
          if (m.destination) {
            const dest = header.annotations?.destinations.find(d => d.name === m.destination);
            if (dest) {
              const rect = surface().getBoundingClientRect();
              viewport.scrollLeft += rect.left + (dest.x - bounds[0]) / (bounds[2] - bounds[0]) * rect.width - viewport.getBoundingClientRect().left - 12;
              viewport.scrollTop += rect.top + (dest.y - bounds[1]) / (bounds[3] - bounds[1]) * rect.height - viewport.getBoundingClientRect().top - 12;
            }
          }
          vector.setAttribute('aria-label', image.alt);
          pngPage?.canvas.setAttribute('aria-label', image.alt);
          acknowledge(header.requestId, performance.now() - renderStart);
        } catch (error) {
          console.warn('TeXpresso preview image update failed', error);
          if (m.rasterPatch || m.inlinePng) { stale = true; describe(); post({ type: 'cache-miss', id: m.header.requestId, pngUnsupported: !m.rasterPatch }); }
          else if (m.svgPatch) { images.forget(m.svgPatch.base); stale = true; describe(); post({ type: 'cache-miss', id: m.header.requestId }); }
          else {
            if (cached) { images.forget(m.contentId); } else if (url) { URL.revokeObjectURL(url); }
            post({ type: 'decode-error', id: m.header.requestId });
          }
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
  formatSelect.onchange = () => {
    format = formatSelect.value; closeLens(); clearDetail();
    // A format change needs a request even when its width happens to match.
    lastWidth = 0; layout(true, true);
  };
  zoomSelect.onchange = () => changeZoom(zoomSelect.value);
  for (const id of ['restart', 'pause', 'output']) { element(id).onclick = () => post({ type: id }); }
  viewport.addEventListener('scroll', () => { closeLens(); scheduleDetail(); save(); }, { passive: true });
  viewport.addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const origin = { x: event.clientX, y: event.clientY }, now = performance.now();
      if (!pinchAnchor || now - lastPinchTime > 250 || origin.x !== pinchOrigin.x || origin.y !== pinchOrigin.y) {
        const rect = sheet.getBoundingClientRect();
        pinchAnchor = { x: (origin.x - rect.left) / rect.width, y: (origin.y - rect.top) / rect.height };
      }
      // Keep the page point for the whole gesture. Re-reading it after each
      // rounded scrollLeft/Top would accumulate drift for tiny finger moves.
      pinchOrigin = origin; lastPinchTime = now;
      stepZoom(wheelFactor(event.deltaY, event.deltaMode), origin, pinchAnchor);
    } else { pinchAnchor = undefined; }
  }, { passive: false });
  viewport.addEventListener('keydown', event => {
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault(); navigate(page + (event.key === 'PageDown' ? 1 : -1));
    }
  });
  function inverseAt(event) {
    if (stale || !header) { return; }
    const rect = surface().getBoundingClientRect();
    post({ type: 'inverse', revision: header.revision, sequence: header.sequence, page: header.page,
      x: bounds[0] + (event.clientX - rect.left) / rect.width * (bounds[2] - bounds[0]),
      y: bounds[1] + (event.clientY - rect.top) / rect.height * (bounds[3] - bounds[1]) });
  }
  function renderLinks() {
    const layer = element('links'); layer.replaceChildren();
    (header.annotations?.links || []).forEach((link, index) => {
      if (!link.uri.startsWith('#') && !/^(https?:|mailto:)/i.test(link.uri)) { return; }
      const b = link.bounds, button = document.createElement('button');
      button.className = 'page-link'; button.type = 'button'; button.title = link.uri;
      button.setAttribute('aria-label', link.uri.startsWith('#') ? `Go to ${link.uri.slice(1)}` : `Open ${link.uri}`);
      button.style.left = `${100 * (b[0] - bounds[0]) / (bounds[2] - bounds[0])}%`;
      button.style.top = `${100 * (b[1] - bounds[1]) / (bounds[3] - bounds[1])}%`;
      button.style.width = `${100 * (b[2] - b[0]) / (bounds[2] - bounds[0])}%`;
      button.style.height = `${100 * (b[3] - b[1]) / (bounds[3] - bounds[1])}%`;
      button.onclick = event => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) { inverseAt(event); }
        else if (!stale) { post({ type: 'link', revision: header.revision, sequence: header.sequence, page: header.page, index }); }
      };
      layer.appendChild(button);
    });
  }
  sheet.addEventListener('click', event => { if ((event.ctrlKey || event.metaKey) && !event.target.closest('.page-link')) { inverseAt(event); } });
  let lastInteraction = -Infinity;
  const interaction = () => {
    const now = performance.now();
    if (now - lastInteraction >= 100) { lastInteraction = now; post({ type: 'interaction' }); }
  };
  viewport.addEventListener('pointerdown', () => post({ type: 'interaction', active: true }), { passive: true });
  for (const name of ['pointerup', 'pointercancel', 'blur']) {
    window.addEventListener(name, () => post({ type: 'interaction', active: false }), { passive: true });
  }
  for (const name of ['pointermove', 'wheel', 'scroll', 'keydown']) {
    viewport.addEventListener(name, interaction, { passive: true });
  }
  const resize = () => { closeLens(); layout(); };
  window.addEventListener('resize', resize);
  let resizeFrame;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(resize);
  });
  observer.observe(viewport);
  let resolution;
  function watchResolution() {
    resolution?.removeEventListener('change', densityChanged);
    resolution = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    resolution.addEventListener('change', densityChanged);
  }
  function densityChanged() { watchResolution(); resize(); }
  watchResolution();
  window.addEventListener('pagehide', () => { closeLens(); clearDetail(); observer.disconnect(); cancelAnimationFrame(resizeFrame); resolution?.removeEventListener('change', densityChanged); clearTimeout(timer); clearTimeout(highlightTimer); images.clear(); if (objectUrl) { URL.revokeObjectURL(objectUrl); } });
  ready();
})();
