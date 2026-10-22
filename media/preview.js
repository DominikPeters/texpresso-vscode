/* global acquireVsCodeApi, TexpressoLensCache, TexpressoViewport, TexpressoImageCache, TexpressoSvgPage, TexpressoPngPage */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi(), instance = document.body.dataset.instance;
  const globalElement = id => document.getElementById(id), viewport = globalElement('viewport');
  const template = globalElement('sheet').cloneNode(true); globalElement('sheet').remove();
  const stack = document.createElement('div'); stack.className = 'page-stack'; viewport.prepend(stack);
  const saved = vscode.getState() || {}, views = new Map(), geometry = new TexpressoViewport.PageLayout();
  const { clamp, wheelFactor, scrollCorrection, rasterWidth, DetailCache } = TexpressoViewport;
  const status = globalElement('status'), zoomSelect = globalElement('zoom'), formatSelect = globalElement('format');
  let layoutEnd;
  let currentPage = Number.isInteger(saved.page) ? clamp(saved.page, 0, 100000) : 0;
  let zoom = ['width', 'page'].includes(saved.zoom) || (Number(saved.zoom) >= .25 && Number(saved.zoom) <= 4) ? saved.zoom : 'width';
  let format = ['png', 'svg'].includes(saved.format) ? saved.format : 'auto';
  let count = 0, complete = false, paused = false, phase = 'running', regions = false, problem = '', magnify = false, lensOwner, detailOwner;
  let lensImage = globalElement('lensImage');
  let timer, scrollFrame, epoch = 0, lastSnapshot = '', lastTop = 0, direction = 1, programmaticTop, customZoomOption;
  let pinchAnchor, pinchOrigin, lastPinchTime = 0, restoring = true, disposing = false;
  const post = message => vscode.postMessage({ instance, ...message });
  const decoded = new TexpressoImageCache(value => {
    if (value.image) { value.image.removeAttribute('src'); }
    if (value.url) { URL.revokeObjectURL(value.url); }
    if (value.vector) { (value.vector.layer || value.vector.root).remove(); }
    if (value.raster) { value.raster.canvas.remove(); value.raster.canvas.width = 0; }
    value.owner?.evicted(value.id);
  }, 32 * 1024 * 1024, 8);
  const inventory = () => [...new Set([...decoded.entries.values()].map(entry => entry.value.id))];
  const resident = () => [...views].filter(([, view]) => view.resident()).map(([index]) => index);
  function trimDecoded() {
    while (decoded.bytes > decoded.maxBytes && decoded.entries.size) {
      const window = geometry.window(viewport.scrollTop,viewport.clientHeight);
      const entries = [...decoded.entries];
      const candidate = entries.find(([,entry]) => entry.value.owner?.currentId() !== entry.value.id) ||
        entries.find(([,entry]) => entry.value.owner?.page < window.first || entry.value.owner?.page > window.last) || entries[0];
      decoded.forget(candidate[0]);
    }
  }
  function diagnostics() { viewport.dataset.shellCount = String(views.size); viewport.dataset.residentBytes = String(decoded.bytes); }
  function save() {
    const rect = geometry.rects[currentPage];
    vscode.setState({ page: currentPage, zoom, format, left: viewport.scrollLeft, top: viewport.scrollTop,
      point: rect ? Math.max(0, (viewport.scrollTop - rect.top) / rect.height) : 0 });
  }
  function describe() {
    if (detailOwner && detailOwner.page !== currentPage) { detailOwner.clearDetail(); }
    globalElement('page').value = complete && count === 0 ? '' : String(currentPage + 1);
    globalElement('page').disabled = complete && count === 0;
    globalElement('total').textContent = complete ? `/ ${count}` : '/ …';
    globalElement('previous').disabled = currentPage === 0;
    globalElement('next').disabled = complete && currentPage + 1 >= count;
    globalElement('pauseIcon').hidden = paused; globalElement('resumeIcon').hidden = !paused;
    globalElement('pause').title = paused ? 'Resume compilation' : 'Pause compilation';
    globalElement('pause').setAttribute('aria-label', globalElement('pause').title); globalElement('pause').disabled = phase !== 'running';
    const text = problem || (phase === 'failed' ? 'Preview stopped. Open Output or the engine log for details.' : '');
    status.hidden = !text; status.textContent = text; status.classList.toggle('error', !!text);
    formatSelect.value = format;
    const header = views.get(currentPage)?.header();
    formatSelect.title = header?.fallback ? `Rendering format. PNG fallback: ${header.fallback}` : 'Rendering format';
    globalElement('magnify').disabled = !regions && header?.mime !== 'image/svg+xml';
  }
  function anchorAt(origin) {
    const view = viewport.getBoundingClientRect(), y = viewport.scrollTop + origin.y - view.top;
    const index = geometry.pageAt(y), rect = geometry.rects[index], sheet = views.get(index)?.sheet;
    const left = sheet ? sheet.getBoundingClientRect().left : view.left + Math.max(0, (viewport.clientWidth - rect.width) / 2) - viewport.scrollLeft;
    return { page: index, x: (origin.x - left) / rect.width, y: (y - rect.top) / rect.height, origin };
  }
  function topAnchor() {
    const rect = viewport.getBoundingClientRect(); return anchorAt({ x: rect.left, y: rect.top });
  }
  function restoreAnchor(anchor) {
    const rect = geometry.rects[anchor.page]; if (!rect) { return; }
    const view = viewport.getBoundingClientRect();
    const top = rect.top + anchor.y * rect.height - (anchor.origin.y - view.top);
    viewport.scrollTop = top;
    const sheet = views.get(anchor.page)?.sheet;
    if (sheet) {
      const left = viewport.scrollLeft + sheet.getBoundingClientRect().left + anchor.x * rect.width - anchor.origin.x;
      viewport.scrollLeft = left;
      // A boundary can make the fixed pinch point unreachable. Rebase that
      // axis instead of carrying the impossible offset into the next gesture.
      if (Math.abs(viewport.scrollLeft-left) > 1) { anchor.x = (anchor.origin.x-sheet.getBoundingClientRect().left)/rect.width; }
    }
    if (Math.abs(viewport.scrollTop-top) > 1) { anchor.y = (viewport.scrollTop+anchor.origin.y-view.top-rect.top)/rect.height; }
    programmaticTop = viewport.scrollTop;
  }

  function configure() {
    const retainedEnd = layoutEnd !== undefined && count === layoutEnd && currentPage < count;
    geometry.configure({ count, complete: complete || retainedEnd, active: currentPage, zoom, width: viewport.clientWidth, height: viewport.clientHeight });
    stack.hidden = complete && count === 0;
    if (stack.hidden) { globalElement('empty').hidden = false; globalElement('empty').textContent = 'This document has no pages.'; }
    else { globalElement('empty').textContent = 'Your document will appear here.'; }
    stack.style.height = `${geometry.total}px`;
    stack.style.width = `${geometry.maxWidth}px`;
  }
  function mountWindow() {
    const window = geometry.window(viewport.scrollTop, viewport.clientHeight), wanted = new Set();
    for (let index = window.start; index <= window.end; index++) { wanted.add(index); }
    // A jump can precede a browser scroll event. Its target must be measured.
    wanted.add(currentPage);
    while (wanted.size > 12) { const far = [...wanted].filter(index => index !== currentPage).sort((a,b) => Math.abs(b-currentPage)-Math.abs(a-currentPage))[0]; wanted.delete(far); }
    for (const [index, view] of views) { if (!wanted.has(index)) { view.dispose(); views.delete(index); } }
    for (const index of [...wanted].sort((a,b)=>a-b)) {
      let view = views.get(index); if (!view) { view = createPage(index); views.set(index, view); stack.appendChild(view.sheet); }
      const rect = geometry.rects[index]; if (!rect) { continue; }
      view.sheet.style.top = `${rect.top}px`; view.sheet.style.width = `${rect.width}px`; view.sheet.style.height = `${rect.height}px`;
    }
    stack.style.width = `${geometry.maxWidth}px`; diagnostics();
    return window;
  }
  function visibleCount() {
    const window = geometry.window(viewport.scrollTop, viewport.clientHeight);
    return Math.max(1, Math.min(12, window.last-window.first+1));
  }
  function surfaceAllowance(index) {
    const window = geometry.window(viewport.scrollTop, viewport.clientHeight);
    return decoded.maxBytes / (visibleCount() + (index < window.first || index > window.last ? 1 : 0));
  }
  function pixelAllowance(index) {
    const window = geometry.window(viewport.scrollTop, viewport.clientHeight), visible = index >= window.first && index <= window.last;
    // Leave space for SVG nodes, encoded bytes and near-page reuse. Detail crops
    // sharpen the active page independently of these bounded whole-page bases.
    return visible ? 4000000 * (index === currentPage ? 2 : 1) / (visibleCount()+1) : 750000;
  }
  function pageDimensions(bounds) {
    const width=bounds[2]-bounds[0], height=bounds[3]-bounds[1];
    let scale=Number(zoom)*96/72;
    if(zoom==='width'||zoom==='page') { scale=Math.max(.05,viewport.clientWidth/width); if(zoom==='page'){scale=Math.min(scale,Math.max(.05,viewport.clientHeight/height));} }
    return {width:width*scale,height:height*scale};
  }
  function desiredWidth(index, bounds, cssWidth) {
    const desired = rasterWidth(bounds, cssWidth, devicePixelRatio);
    const budget = Math.floor(Math.sqrt(pixelAllowance(index)*(bounds[2]-bounds[0])/(bounds[3]-bounds[1])));
    return Math.max(1,Math.min(desired,budget));
  }
  function observeActive() {
    const center=viewport.scrollTop+viewport.clientHeight/2, next=geometry.pageAt(center);
    if(Math.abs(geometry.rects[next].top-center)>8||next===currentPage) { currentPage=next; }
  }
  function layoutDocument(request = true, immediate = false, anchor) {
    anchor ||= topAnchor();
    for (const [index, view] of views) { const header = view.header(); if (header) { geometry.setBounds(index, header.bounds); } }
    configure(); mountWindow(); restoreAnchor(anchor); mountWindow(); observeActive();
    for (const view of views.values()) { view.recost(); }
    let option = [...zoomSelect.options].find(option => option.value === String(zoom));
    if (!option) { if (!customZoomOption) { customZoomOption = document.createElement('option'); zoomSelect.appendChild(customZoomOption); } customZoomOption.value = String(zoom); customZoomOption.textContent = `${Math.round(Number(zoom)*100)}%`; }
    zoomSelect.value = String(zoom); describe();
    if (request) { clearTimeout(timer); if (immediate) { requestViewport(false); } else { timer = setTimeout(() => requestViewport(false), 100); } }
    views.get(currentPage)?.scheduleDetail(); save();
  }
  function requestViewport(scroll = false, jump = false, ready = false) {
    if (disposing) { return; }
    const window = mountWindow(), visible = [];
    for (let index = window.first; index <= window.last && visible.length < 12; index++) {
      if (views.has(index)) { visible.push({ page: index, width: views.get(index).width() }); }
    }
    if (!visible.some(entry => entry.page === currentPage)) { visible.unshift({ page: currentPage, width: views.get(currentPage)?.width() || 1200 }); visible.splice(12); }
    const order = direction > 0 ? [window.last + 1, window.first - 1] : [window.first - 1, window.last + 1];
    const nearby = order.filter(index => index >= 0 && index < geometry.count && !visible.some(entry=>entry.page===index)).map(index => ({ page: index, width: views.get(index)?.width() || desiredWidth(index,geometry.rects[index].bounds,geometry.rects[index].width) }));
    const snapshot = { page: currentPage, width: views.get(currentPage)?.width() || 1200, format, continuous: true, visible, nearby, resident: resident(), epoch };
    const key = JSON.stringify(snapshot);
    if (ready || jump || scroll || key !== lastSnapshot) { lastSnapshot = key; post({ type: ready ? 'ready' : 'viewport', ...snapshot, ...(scroll ? { scroll: true } : {}), ...(jump ? { jump: true } : {}), ...(ready ? { svgDom: true, pngCanvas: true } : {}) }); }
  }
  function navigate(value, notify = true) {
    closeLens(); currentPage = clamp(value, 0, complete && count ? count - 1 : 100000); epoch++;
    configure(); viewport.scrollTop = geometry.rects[currentPage].top; viewport.scrollLeft = 0; programmaticTop = viewport.scrollTop;
    mountWindow(); describe(); save(); if (notify) { requestViewport(false, true); }
  }
  function closeLens() { lensOwner?.closeLens(); }
  function setMagnify(value) { magnify = value; closeLens(); viewport.classList.toggle('magnify', magnify); globalElement('magnify').setAttribute('aria-pressed', String(magnify)); }
  function changeZoom(value, origin, anchor) {
    closeLens(); const rect = viewport.getBoundingClientRect(); origin ||= { x: rect.left + viewport.clientWidth / 2, y: rect.top + viewport.clientHeight / 2 };
    anchor ||= anchorAt(origin); zoom = value; layoutDocument(true, false, anchor); save();
  }
  function stepZoom(factor, origin, anchor) {
    if (factor === 1) { return; }
    const rect = geometry.rects[currentPage], effective = Number(zoom) || rect.width / (rect.bounds[2] - rect.bounds[0]) * 72/96;
    const next = clamp(effective * factor, .25, 4); if (next !== effective) { changeZoom(next, origin, anchor); }
  }
  function target(target) { navigate(target.page, false); views.get(target.page)?.highlight(target); requestViewport(false); }

  function createPage(page) {
    const sheet = template.cloneNode(true); sheet.hidden = false; sheet.className = 'page-sheet waiting'; sheet.dataset.page = String(page);
    sheet.dataset.part = 'sheet';
    for (const node of [sheet, ...sheet.querySelectorAll('[id]')]) { const id = node.id; if (id) { node.dataset.part = id; if (page !== 0) { node.removeAttribute('id'); } if (node !== sheet) { node.classList.add(`page-${id}`); } } }
    const element = id => sheet.querySelector(`[data-part="${id}"]`) || globalElement(id);
    let image = element('image'), bounds = geometry.rects[page]?.bounds || [0,0,595.28,841.89];
    image.hidden = true;
    const vector = element('vector'), raster = element('raster'), lensVector = globalElement('lensVector'), lensCanvas = globalElement('lensCanvas');
    let svgPage, pngPage, imageId, header, objectUrl, stale = true, generation = 0, highlightTimer;
    const surface = () => svgPage ? vector : pngPage ? raster : image;
    let view, rasterizedAt;
    const cacheKey = id => `${page}:${id}`;
    const images = {
      get: id => decoded.get(cacheKey(id)), has: id => decoded.has(cacheKey(id)),
      take: id => decoded.take(cacheKey(id)), forget: id => decoded.forget(cacheKey(id)), keys: inventory,
      put(id, value, cost) {
        // Touch the actively edited/visible surface before evicting neighbors.
        const active = views.get(currentPage); if (active && active !== view) { active.touch(); }
        const result = decoded.put(cacheKey(id), { ...value, owner: view, id }, cost); diagnostics(); return result;
      }
    };
    const acknowledge = (id, renderMs) => post({ type: 'decoded', id, page, cached: inventory(), svg: svgPage?.contentId, png: pngPage?.contentId, renderMs });
    function layout(request = true, immediate = false) { layoutDocument(request, immediate); }
    const width = () => desiredWidth(page,bounds,sheet.getBoundingClientRect().width);
    function highlight(target) {
      if (!header || stale || target.page !== page) { return; }
      const mark = element('highlight'); mark.style.left = `${100*(target.x-bounds[0])/(bounds[2]-bounds[0])}%`; mark.style.top = `${100*(target.y-bounds[1])/(bounds[3]-bounds[1])}%`;
      clearTimeout(highlightTimer); mark.hidden = true; void mark.offsetWidth; mark.hidden = false;
      highlightTimer = setTimeout(() => { mark.hidden = true; }, 1500);
      requestAnimationFrame(() => { if (sheet.isConnected) { mark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); programmaticTop = viewport.scrollTop; } });
    }
  let detailImage = element('detail'), detailUrl, detailTimer, detailFailed = false, autoRefining = false;
  const detailCache = new DetailCache();
  function clearDetail() {
    clearTimeout(detailTimer); detailCache.reset(); detailFailed = false;
    detailImage.hidden = true; detailImage.removeAttribute('src');
    if (detailOwner === view) { detailOwner = undefined; }
    post({ type: 'cancel-detail', page });
    if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = undefined; }
  }
  function scheduleDetail() {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(requestDetail, 120);
  }
  function requestDetail() {
    if (page !== currentPage || stale || !header || header.mime === 'image/svg+xml' || autoRefining || !regions || detailFailed) { return; }
    if (detailOwner && detailOwner !== view) { detailOwner.clearDetail(); }
    detailOwner = view;
    const viewportRect = viewport.getBoundingClientRect();
    const request = detailCache.request(bounds, surface().getBoundingClientRect(),
      { left: viewportRect.left + viewport.clientLeft, top: viewportRect.top + viewport.clientTop,
        right: viewportRect.left + viewport.clientLeft + viewport.clientWidth,
        bottom: viewportRect.top + viewport.clientTop + viewport.clientHeight }, window.devicePixelRatio, header.width);
    if (request) { post({ type: 'detail', ...request, revision: header.revision, sequence: header.sequence, page: header.page }); }
  }
  async function receiveDetail(m) {
    const url = URL.createObjectURL(new Blob([m.bytes], { type: m.header.mime }));
    const candidate = new Image(); candidate.src = url;
    try {
      await candidate.decode();
      if (page !== currentPage || detailOwner !== view || stale || !header || m.token !== detailCache.pending?.token || m.header.revision !== header.revision ||
          m.header.sequence !== header.sequence || m.header.page !== header.page) { candidate.removeAttribute('src'); URL.revokeObjectURL(url); }
      else {
        const previous = detailUrl, b = m.header.bounds;
        detailCache.accept(m.token, m.header); detailUrl = url;
        if (page === 0) { candidate.id = 'detail'; } candidate.dataset.part = 'detail'; candidate.className = 'page-detail'; candidate.alt = ''; candidate.draggable = false;
        candidate.style.left = `${100 * (b[0] - bounds[0]) / (bounds[2] - bounds[0])}%`;
        candidate.style.top = `${100 * (b[1] - bounds[1]) / (bounds[3] - bounds[1])}%`;
        candidate.style.width = `${100 * (b[2] - b[0]) / (bounds[2] - bounds[0])}%`;
        candidate.style.height = `${100 * (b[3] - b[1]) / (bounds[3] - bounds[1])}%`;
        detailImage.removeAttribute('src'); detailImage.replaceWith(candidate); detailImage = candidate;
        if (previous) { requestAnimationFrame(() => URL.revokeObjectURL(previous)); }
      }
    } catch { candidate.removeAttribute('src'); URL.revokeObjectURL(url); if (page === currentPage && detailOwner === view) { detailFailed = true; detailCache.reset(); } }
    post({ type: 'decoded', id: m.header.requestId });
    scheduleDetail();
  }

  const lens = element('lens'), lensBase = element('lensBase');
  const lensCache = new TexpressoLensCache();
  const lensSize = 240, magnification = 2.5;
  let pointer, lensUrl, lensHeader;
  function closeLens() {
    if (lensOwner && lensOwner !== view) { return; }
    const owned = lensOwner === view; lensOwner = undefined;
    pointer = undefined; lensCache.reset(); lens.hidden = true;
    lensHeader = undefined; lensImage.hidden = true; lensVector.hidden = true; lensVector.replaceChildren(); lensCanvas.hidden = true; lensCanvas.width = 0;
    if (owned) { lensImage.removeAttribute('src'); lensBase.removeAttribute('src'); post({ type: 'cancel-region', page }); }
    if (lensUrl) { URL.revokeObjectURL(lensUrl); lensUrl = undefined; }
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
    if (lensOwner && lensOwner !== view) { lensOwner.closeLens(); }
    lensOwner = view;
    pointer = { clientX: event.clientX, clientY: event.clientY,
      x: bounds[0] + (event.clientX - rect.left) / rect.width * (bounds[2] - bounds[0]),
      y: bounds[1] + (event.clientY - rect.top) / rect.height * (bounds[3] - bounds[1]) };
    positionLens();
    requestLens();
  }
  sheet.addEventListener('pointerdown', event => {
    if (!magnify || stale || !header || event.button !== 0 || event.ctrlKey || event.metaKey || event.target.closest('.page-link')) { return; }
    event.preventDefault(); viewport.focus({ preventScroll: true }); sheet.setPointerCapture(event.pointerId); moveLens(event);
  });
  sheet.addEventListener('pointermove', event => { if (pointer) { moveLens(event); } });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) { sheet.addEventListener(name, closeLens); }
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

    view = { sheet, page, currentId:()=>imageId, header: () => header, width, highlight, closeLens, clearDetail, scheduleDetail,
      recost() {
        if (!header || !imageId || header.mime !== 'image/svg+xml') { return; }
        const entry = decoded.entries.get(cacheKey(imageId)); if (!entry) { return; }
        const rect = sheet.getBoundingClientRect(), cost = header.byteLength + Math.ceil(rect.width*devicePixelRatio)*Math.ceil(rect.height*devicePixelRatio)*4 + (svgPage ? svgPage.count*160 : 0);
        const key = `${Math.round(rect.width)}:${Math.round(rect.height)}:${devicePixelRatio}:${visibleCount()}`;
        if (cost > surfaceAllowance(page)) {
          if (rasterizedAt !== key) { rasterizedAt = key; post({ type:'rasterize',page,id:header.requestId }); }
          return;
        }
        // Updating accounting must not dispose the currently mounted object.
        decoded.bytes += cost-entry.cost; entry.cost=cost; trimDecoded(); diagnostics();
      },
      resident: () => !!header && !stale && !!imageId && images.has(imageId),
      touch: () => imageId && images.get(imageId),
      invalidate() { generation++; stale = true; element('links').replaceChildren(); element('highlight').hidden = true; closeLens(); clearDetail(); },
      evicted(id) {
        if (id !== imageId) { return; }
        closeLens(); clearDetail();
        svgPage = undefined; pngPage = undefined; objectUrl = undefined; imageId = undefined;
        stale = true; image.hidden = true; vector.hidden = true; raster.hidden = true; element('links').replaceChildren();
        sheet.classList.add('waiting'); generation++; diagnostics();
        if (!disposing) { post({ type: 'evicted', page, contentId: id, cached: inventory() }); }
      },
      async receive(m) {
        switch (m.type) {
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
          if (lensOwner !== view || !pointer || stale || !header || m.token !== lensCache.pending?.token || m.header.revision !== header.revision ||
              m.header.sequence !== header.sequence || m.header.page !== header.page) { candidate.removeAttribute('src'); URL.revokeObjectURL(url); }
          else {
            const previous = lensUrl;
            lensCache.accept(m.token, m.header);
            lensUrl = url; lensHeader = m.header;
            // Swap in the already decoded element; keep the old pixels visible
            // throughout rendering/decoding instead of clearing an image src.
            candidate.id = 'lensImage'; candidate.alt = 'Magnified page region'; candidate.draggable = false;
            lensImage.removeAttribute('src'); lensImage.replaceWith(candidate); lensImage = candidate; positionLens();
            if (previous) { requestAnimationFrame(() => URL.revokeObjectURL(previous)); }
          }
        } catch { candidate.removeAttribute('src'); URL.revokeObjectURL(url); closeLens(); }
        post({ type: 'decoded', id: m.header.requestId });
        requestLens(); break;
      }
      case 'image': {
        // Check a patch before mutating its acknowledged root. Full SVG roots
        // are detached until actual node/pixel accounting admits them below.
        const proposedRect = pageDimensions(m.header.bounds);
        const proposedHeight = proposedRect.height;
        if (m.svgPatch && m.header.byteLength + Math.ceil(proposedRect.width*devicePixelRatio)*Math.ceil(proposedHeight*devicePixelRatio)*4 + Math.min(20000,(svgPage?.count||0)+256)*160 > surfaceAllowance(page)) {
          post({ type: 'rasterize', page, id: m.header.requestId }); return;
        }
        const renderStart = performance.now();
        autoRefining = m.refining === true;
        closeLens(); clearDetail();
        const token = ++generation;
        const cached = images.get(m.contentId);
        if (cached) { cached.owner = view; }
        if (!cached && !m.bytes && !m.svgPatch && !m.rasterPatch) { post({ type: 'cache-miss', page, id: m.header.requestId }); break; }
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
          const surfaceRect = proposedRect;
          const candidateHeight = proposedHeight;
          const candidatePixels = m.header.mime === 'image/png' ? m.header.width*m.header.height : Math.ceil(surfaceRect.width*devicePixelRatio)*Math.ceil(candidateHeight*devicePixelRatio);
          const candidateCost = m.header.byteLength + candidatePixels*4 + (nextVector ? nextVector.count*160 : 0);
          if (m.header.mime === 'image/svg+xml' && candidateCost > surfaceAllowance(page)) {
            if (url && !cached) { URL.revokeObjectURL(url); }
            post({ type: 'rasterize', page, id: m.header.requestId }); return;
          }
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
          imageId = m.contentId;
          if (nextRaster && svgPage && header && header.revision === m.header.revision && header.sequence === m.header.sequence) { images.forget(svgPage.contentId); }
          if (nextVector) {
            let nodes = nextVector.count;
            for (const [key, entry] of [...decoded.entries].reverse()) {
              if (!entry.value.vector || entry.value.vector === nextVector) { continue; }
              if (nodes + entry.value.vector.count > 40000) { decoded.forget(key); } else { nodes += entry.value.vector.count; }
            }
          }
          if (!cached || m.svgPatch || commitRaster) {
            if (!images.put(m.contentId, nextVector ? { vector: nextVector } : nextRaster ? { raster: nextRaster } : { url, image: candidate }, candidateCost)) {
              if (m.header.mime === 'image/svg+xml') { post({ type: 'rasterize', page, id: m.header.requestId }); return; }
              throw Error('Decoded page exceeds the shared memory budget');
            }
          } else { const entry = decoded.entries.get(cacheKey(m.contentId)); if (entry) { decoded.bytes += candidateCost-entry.cost;entry.cost=candidateCost;trimDecoded(); } }
          if (svgPage && svgPage !== nextVector) {
            if (!images.has(svgPage.contentId)) { svgPage.layer?.remove(); }
            else { svgPage.layer?.classList.remove('active'); }
          }
          if (pngPage && pngPage !== nextRaster && !images.has(pngPage.contentId)) { pngPage.canvas.remove(); pngPage.canvas.width = 0; }
          imageId = m.contentId; svgPage = nextVector; pngPage = nextRaster;
          vector.hidden = !svgPage; raster.hidden = !pngPage;
          if (svgPage) {
            if (!svgPage.layer) {
              svgPage.layer = document.createElement('div'); svgPage.layer.className = 'texpresso-svg-layer';
              svgPage.layer.appendChild(svgPage.root);
            }
            if (svgPage.layer.parentNode !== vector) { vector.appendChild(svgPage.layer); }
            svgPage.layer.classList.add('active');
          } else if (pngPage) { raster.replaceChildren(pngPage.canvas); }
          else {
            // Mount the element whose decode completed. Assigning its URL to a
            // separate <img> starts another load and can flash a broken image.
            if (page === 0) { candidate.id = 'image'; } candidate.dataset.part = 'image'; candidate.className = 'page-image'; candidate.draggable = false;
            if (candidate !== image) { image.replaceWith(candidate); image = candidate; }
          }
          image.hidden = !!svgPage || !!pngPage;
          objectUrl = url; header = m.header; bounds = header.bounds;
          problem = ''; stale = false; sheet.hidden = false; sheet.classList.remove('waiting'); element('empty').hidden = true;
          image.alt = `Rendered LaTeX page ${page + 1}`;
          layout(); describe(); renderLinks();
          if (previous && previous !== url && !images.has(previousId)) { URL.revokeObjectURL(previous); }
          if (m.target) { highlight(m.target); }
          if (m.destination) {
            const dest = header.annotations?.destinations.find(d => d.name === m.destination);
            if (dest) {
              const rect = surface().getBoundingClientRect();
              viewport.scrollLeft += rect.left + (dest.x - bounds[0]) / (bounds[2] - bounds[0]) * rect.width - viewport.getBoundingClientRect().left - 12;
              viewport.scrollTop += rect.top + (dest.y - bounds[1]) / (bounds[3] - bounds[1]) * rect.height - viewport.getBoundingClientRect().top - 12;
              programmaticTop = viewport.scrollTop;
            }
          }
          vector.setAttribute('aria-label', image.alt);
          pngPage?.canvas.setAttribute('aria-label', image.alt);
          acknowledge(header.requestId, performance.now() - renderStart);
          requestViewport(false);
        } catch (error) {
          console.warn('TeXpresso preview image update failed', error);
          if (m.rasterPatch || m.inlinePng) { stale = true; describe(); post({ type: 'cache-miss', page, id: m.header.requestId, pngUnsupported: !m.rasterPatch }); }
          else if (m.svgPatch) { images.forget(m.svgPatch.base); stale = true; describe(); post({ type: 'cache-miss', page, id: m.header.requestId }); }
          else {
            if (cached) { images.forget(m.contentId); } else if (url) { URL.revokeObjectURL(url); }
            post({ type: 'decode-error', page, id: m.header.requestId });
          }
        }
        break;
      }

        }
      },
      dispose() {
        generation++; closeLens(); clearDetail(); clearTimeout(highlightTimer);
        // Retain bounded decoded content for a quick return, but unmount its DOM.
        sheet.remove(); if (svgPage?.layer) { svgPage.layer.remove(); } if (pngPage) { pngPage.canvas.remove(); }
      }
    };
    return view;
  }

  window.addEventListener('message', async event => {
    const m = event.data; if (!m || m.instance !== instance) { return; }
    switch (m.type) {
      case 'ping': requestViewport(false, false, true); break;
      case 'state': {
        const anchor = topAnchor(); if (m.phase === 'starting' && phase !== 'starting') { problem = ''; }
        const available = Number.isInteger(m.count) ? clamp(m.count,0,100001) : count;
        complete = m.complete === true;
        // A rolled-back native prefix is not evidence that the old layout has
        // lost its later pages. Keep cheap geometry until the new end is known.
        if (complete) { count = available; layoutEnd = available; }
        else { if (layoutEnd !== undefined && available >= layoutEnd) { layoutEnd = undefined; } count = Math.max(count,available); }
        paused = m.paused; phase = m.phase; regions = m.regions === true;
        globalElement('format').querySelector('[value=svg]').disabled = !m.svg;
        if (!m.svg && format === 'svg') { format = 'png'; }
        if (complete) { currentPage = count === 0 ? 0 : Math.min(currentPage,count-1); }
        layoutDocument(true, false, anchor); describe(); break;
      }
      case 'jump': navigate(m.page, false); if (m.target) { target(m.target); } requestViewport(false); break;
      case 'invalidate': problem = ''; for (const view of views.values()) { view.invalidate(); } describe(); requestViewport(false); break;
      case 'error': problem = m.text; if (Number.isInteger(m.page)) { views.get(m.page)?.invalidate(); } else { for (const view of views.values()) { view.invalidate(); } } describe(); break;
      case 'link-error': problem = m.text; describe(); break;
      case 'target': target(m); break;
      default: {
        const index = m.header?.page ?? m.page ?? currentPage;
        let view = views.get(index);
        // Background results may be cached without introducing a distant sheet.
        if (!view && m.header && ['image','region','detail'].includes(m.type)) {
          post({ type: 'decoded', id: m.header.requestId, page: index, cached: inventory() }); break;
        }
        if (view) { await view.receive(m); diagnostics(); }
      }
    }
  });
  globalElement('previous').onclick = () => navigate(currentPage - 1);
  globalElement('next').onclick = () => navigate(currentPage + 1);
  globalElement('page').onchange = event => { const value = Number(event.target.value); if (Number.isInteger(value) && value > 0) { navigate(value-1); } };
  globalElement('zoomIn').onclick = () => stepZoom(1.25); globalElement('zoomOut').onclick = () => stepZoom(.8);
  zoomSelect.onchange = () => changeZoom(zoomSelect.value);
  formatSelect.onchange = () => { format = formatSelect.value; closeLens(); epoch++; lastSnapshot = ''; layoutDocument(true,true); };
  globalElement('magnify').onclick = () => { setMagnify(!magnify); viewport.focus({ preventScroll: true }); };
  for (const id of ['restart','pause','output']) { globalElement(id).onclick = () => post({ type: id }); }
  viewport.addEventListener('scroll', () => {
    closeLens(); cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const top = viewport.scrollTop, user = programmaticTop === undefined || Math.abs(top - programmaticTop) > 1;
      programmaticTop = undefined; direction = top >= lastTop ? 1 : -1; lastTop = top;
      mountWindow(); observeActive();
      if (user) { epoch++; } for(const view of views.values()){view.recost();} describe(); save(); views.get(currentPage)?.scheduleDetail(); requestViewport(user);
    });
  }, { passive: true });
  viewport.addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault(); const origin = { x:event.clientX,y:event.clientY }, now = performance.now();
      if (!pinchAnchor || now-lastPinchTime>250 || origin.x!==pinchOrigin.x || origin.y!==pinchOrigin.y) { pinchAnchor = anchorAt(origin); }
      pinchOrigin = origin; lastPinchTime=now; stepZoom(wheelFactor(event.deltaY,event.deltaMode),origin,pinchAnchor);
    } else { pinchAnchor = undefined; }
  }, { passive:false });
  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport) { return; }
    if (event.key.toLowerCase()==='m' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); setMagnify(!magnify); }
    if (event.key==='Escape') { setMagnify(false); }
    if (event.key==='PageDown' || event.key==='PageUp') { event.preventDefault(); viewport.scrollTop += (event.key==='PageDown'?1:-1)*viewport.clientHeight*.9; }
  });
  let lastInteraction = -Infinity;
  const interaction = () => { const now=performance.now(); if(now-lastInteraction>=100) { lastInteraction=now;post({type:'interaction'}); } };
  viewport.addEventListener('pointerdown',()=>post({type:'interaction',active:true}),{passive:true});
  for(const name of ['pointerup','pointercancel','blur']) { window.addEventListener(name,()=>{post({type:'interaction',active:false});if(name==='blur'){closeLens();}},{passive:true}); }
  for(const name of ['pointermove','wheel','scroll','keydown']) { viewport.addEventListener(name,interaction,{passive:true}); }
  const resize=()=>{closeLens();layoutDocument();}; let resizeFrame;
  window.addEventListener('resize',resize);
  const observer=new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(resize);});observer.observe(viewport);
  let resolution;
  function watchResolution(){resolution?.removeEventListener('change',densityChanged);resolution=matchMedia(`(resolution: ${devicePixelRatio}dppx)`);resolution.addEventListener('change',densityChanged);}
  function densityChanged(){watchResolution();resize();}watchResolution();
  window.addEventListener('pagehide',()=>{disposing=true;closeLens();observer.disconnect();cancelAnimationFrame(resizeFrame);cancelAnimationFrame(scrollFrame);resolution?.removeEventListener('change',densityChanged);clearTimeout(timer);for(const view of views.values()){view.dispose();}decoded.clear();});
  configure(); mountWindow();
  if (restoring) { viewport.scrollTop = geometry.rects[currentPage].top + (Number(saved.point)||0)*geometry.rects[currentPage].height; viewport.scrollLeft=Number(saved.left)||0; programmaticTop=viewport.scrollTop;restoring=false; }
  describe();requestViewport(false,false,true);
})();
