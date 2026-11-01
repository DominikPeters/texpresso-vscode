/* Auto end-to-end experiment: production assets/controller, a local binary
 * bridge, and separate first-visible/idle-refined paint opportunities. */
const profileJob = __JOB__;
const profileHost = profileJob.vscode ? acquireVsCodeApi() : undefined;
const profileRows = [], profileFrames = [], errors = [], pendingMain = new Set(), profileRequests = [], pendingRegions = new Map();
let current, latestSequence = 0, latestRequest = 0;
const displayedMainRequest = new Map();
const profileInputs = [], rapidPhases = [], visibilityEvents = [], prewarmEvents = [];
const visibility = () => ({state:document.visibilityState, focused:document.hasFocus()});
document.addEventListener('visibilitychange',()=>visibilityEvents.push({at:performance.now(),...visibility()}));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const until = async (check, description) => {
  const deadline = performance.now() + 60000;
  while (!check()) {
    if (performance.now() > deadline || (!profileJob.rapid && errors.length)) throw Error(description + ': ' + errors.join('; '));
    await wait(10);
  }
};
// Native IMG decode calls can overlap page prefetch/detail/lens work. Record the
// production request's decoded ACK rather than assigning a global last-frame decode.
const sheetFor = page => document.querySelector(`.page-sheet[data-page="${page}"]`);
const surfaceFor = page => {
  const sheet = sheetFor(page);
  return sheet?.querySelector('[data-part="raster"]:not([hidden]) > canvas') ||
    sheet?.querySelector('[data-part="vector"]:not([hidden]) .texpresso-svg-layer.active > svg') ||
    sheet?.querySelector('[data-part="image"]:not([hidden])');
};
const surfaceMetrics = page => {
  const sheet = sheetFor(page), surface = surfaceFor(page), rect = sheet?.getBoundingClientRect();
  return { page, mounted: !!sheet, rendered: !!surface, stale: sheet?.dataset.stale,
    cssWidth: rect?.width, cssHeight: rect?.height,
    surface: surface?.tagName?.toLowerCase(),
    pixelWidth: surface instanceof HTMLCanvasElement ? surface.width : surface instanceof HTMLImageElement ? surface.naturalWidth : undefined,
    pixelHeight: surface instanceof HTMLCanvasElement ? surface.height : surface instanceof HTMLImageElement ? surface.naturalHeight : undefined,
    svgViewBox: surface?.tagName?.toLowerCase() === 'svg' ? surface.getAttribute('viewBox') : undefined };
};
const memorySnapshot = () => {
  const viewport = document.getElementById('viewport');
  return { heapBytes:performance.memory?.usedJSHeapSize, domNodes:document.querySelectorAll('*').length,
    canvasPixels:[...document.querySelectorAll('canvas')].reduce((n,c)=>n+c.width*c.height,0),
    residentBytes:Number(viewport.dataset.residentBytes || 0), shellCount:document.querySelectorAll('.page-sheet').length,
    viewportCss:[viewport.clientWidth,viewport.clientHeight], dpr:devicePixelRatio,
    physicalPageCount:document.getElementById('total').textContent,
    surfaces:[...document.querySelectorAll('.page-sheet')].map(sheet=>surfaceMetrics(Number(sheet.dataset.page))) };
};
const regionKey = (type,page,token) => `${type}:${page}:${token}`;
const profileApi = () => ({
  getState: () => ({ page:0, zoom:'width', format:profileJob.codec }), setState: () => {},
  postMessage: m => {
    if (m.type === 'region' || m.type === 'detail') {
      const request = {...m, at:performance.now()}; profileRequests.push(request);
      pendingRegions.set(regionKey(m.type,m.page,m.token),request);
    }
    if (m.type === 'cancel-region' || m.type === 'cancel-detail') {
      const type=m.type==='cancel-region'?'region':'detail';
      for (const [key,request] of pendingRegions) if (request.type===type && request.page===m.page) pendingRegions.delete(key);
    }
    if (m.type === 'ready') current = {name:'initial',page:0,start:performance.now(),minSequence:0,afterRequest:0,frames:[]};
    if (profileHost) profileHost.postMessage(m);
    else fetch('/message', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)}).catch(e => errors.push(e.message));
    if (m.type === 'decode-error' || m.type === 'cache-miss') errors.push(m.type + ' ' + m.id);
    if (m.type !== 'decoded') return;
    const frame = profileFrames.find(f => f.request === m.id);
    if (!frame) return;
    if (frame.type === 'image' && m.renderMs === undefined) {
      frame.cancelledBeforeMount = true; pendingMain.delete(m.id); return;
    }
    frame.inlineSvg = !!m.svg; frame.canvasPng = !!m.png; frame.renderMs = m.renderMs; frame.displayed = m.displayed; frame.stale = m.stale;
    frame.dispatchToDecoded = performance.now() - frame.dispatched;
    if (frame.type === 'image') displayedMainRequest.set(frame.page,m.id);
    frame.decodedAt = performance.now();
    latestSequence = Math.max(latestSequence, frame.sequence);
    latestRequest = Math.max(latestRequest, m.id);
    const op = current;
    painted().then(() => {
      // A decoded bitmap replaced before the paint opportunity was never visible.
      if (frame.type === 'image' && displayedMainRequest.get(frame.page) !== m.id) {
        frame.supersededBeforePaint = true; pendingMain.delete(m.id); return;
      }
      frame.paintedAt = performance.now();
      frame.surface = surfaceMetrics(frame.page);
      pendingRegions.delete(regionKey(frame.type,frame.page,frame.token));
      frame.paintVisibility = visibility();
      frame.statusHidden = document.getElementById('status').hidden;
      frame.autoLabel = document.querySelector('#format [value=auto]').textContent;
      frame.latestInputAtPaint = profileInputs.at(-1)?.id;
      frame.dispatchToPaintOpportunity = frame.paintedAt - frame.dispatched;
      pendingMain.delete(m.id);
      // Detail-region ACKs and older background frames must not finish an edit.
      if (!op || current !== op || frame.type !== 'image' || frame.page !== op.page ||
          frame.sequence < op.minSequence || m.id <= op.afterRequest) return;
      op.frames.push(frame);
      op.ms ??= frame.paintedAt - op.start;
      op.settledMs = frame.paintedAt - op.start;
    });
  }
});
if (profileHost) window.profileAcquireVsCodeApi = profileApi; else window.acquireVsCodeApi = profileApi;
const receiveProfileFrame = async data => {
  if (data.type === 'profile-prewarm-ack') { prewarmEvents.push({...data, receivedAt:performance.now()}); return; }
  if (data.type === 'profile-edit-ack') {
    const input = profileInputs.find(i => i.id === data.inputId);
    if (input) { input.sequence = data.sequence; input.acknowledgedAt = performance.now(); input.hostAppliedAt=data.hostAppliedAt; }
    return;
  }
  if (data.type === 'error' || data.type === 'decode-error') errors.push(data.text || data.type);
  if (data.type === 'region-error') {
    for (const [key,request] of pendingRegions) if (request.page===data.page && request.type===(data.purpose==='detail'?'detail':'region')) pendingRegions.delete(key);
    errors.push('region-error ' + (data.text || data.purpose || 'unknown'));
  }
  if (['image','region','detail'].includes(data.type) || data.frame) {
    const dispatched = performance.now();
    if (data.type === 'image') pendingMain.add(data.header.requestId);
    let transferMs = 0;
    if (data.frame) {
      const start = performance.now(), response = await fetch(data.frame);
      if (!response.ok) { errors.push('Frame HTTP ' + response.status); return; }
      data.bytes = await response.arrayBuffer(); transferMs = performance.now() - start;
    }
    profileFrames.push({type:data.type,request:data.header.requestId,page:data.header.page,sequence:data.header.sequence,
      mime:data.header.mime, token:data.token, purpose:data.purpose, bounds:data.header.bounds, revision:data.header.revision, bytes:data.bytes?.byteLength || 0,
      rasterPatch:!!data.rasterPatch, svgPatch:!!data.svgPatch,
      dispatchVisibility:visibility(),
      cacheReference:!data.frame && !data.bytes && !data.svgPatch && !data.rasterPatch,
      patchBytes:data.svgPatch ? new TextEncoder().encode(JSON.stringify(data.svgPatch)).length : 0,
      width:data.header.width,height:data.header.height, vectorCost:data.header.vectorCost, exportMs:data.header.exportMs,
      refining:data.refining, upgrade:data.profileUpgrade, processingMs:data.profileProcessingMs,transferMs,dispatched});
  }
};
if (profileHost) window.addEventListener('message', event => receiveProfileFrame(event.data));
else {
  const events = new EventSource('/events');
  events.onmessage = async event => { const data=JSON.parse(event.data);await receiveProfileFrame(data);window.dispatchEvent(new MessageEvent('message',{data})); };
}
(async () => {
  const finish = async idle => {
    await until(() => current?.ms !== undefined, 'First visible frame');
    const op = current;
    const first = op.frames[0].paintedAt;
    await until(() => performance.now() >= first + idle && !pendingMain.size &&
      performance.now() - op.frames.at(-1).paintedAt >= Math.min(idle,80), 'Idle refinement');
    op.firstMime = op.frames[0].mime; op.finalMime = op.frames.at(-1).mime;
    op.frame = op.frames[0];
    Object.assign(op,memorySnapshot());
    profileRows.push(op); current = undefined;
  };
  await finish(profileJob.richDemo ? 1600 : profileJob.earlyInput ? 80 : 650);
  const operation = async (name,page,edit,action,idle=80) => {
    current = {name,page,start:performance.now(),minSequence:latestSequence+(edit?1:0),afterRequest:latestRequest,frames:[]};
    await action(); await finish(idle);
  };
  const navigate = page => { const input=document.getElementById('page');input.value=String(page+1);input.dispatchEvent(new Event('change')); };
  const edit = body => profileHost ? profileHost.postMessage({type:'profile-edit',page:0,...body}) :
    fetch('/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page:0,...body})});
  if (!profileJob.richDemo && !profileJob.rapid && profileJob.pages > 1) {
    await operation('page-next-new',1,false,()=>navigate(1),650);
    await operation('page-previous-cached',0,false,()=>navigate(0));
    await operation('page-next-cached',1,false,()=>navigate(1));
    await operation('page-last-new',profileJob.pages-1,false,()=>navigate(profileJob.pages-1),650);
    await operation('page-first-compiled',0,false,()=>navigate(0),650);
  }
  if(profileJob.richDemo && !profileJob.prewarmScenario) {
    const insert = async(name,text,idle=80)=>{
      const input={id:profileInputs.length+1,phase:name,injectedAt:performance.now()};profileInputs.push(input);
      current={name,page:0,start:input.injectedAt,minSequence:Infinity,afterRequest:latestRequest,frames:[]};
      profileHost.postMessage({type:'profile-edit',mode:'demo',text,inputId:input.id});
      await until(()=>input.sequence!==undefined,'Rich demo source acknowledgment');
      current.minSequence=input.sequence;current.sourceSequence=input.sequence;
      // A very fast image can reach its paint opportunity before its source ACK.
      for(const frame of profileFrames.filter(f=>f.type==='image'&&f.page===0&&f.sequence>=input.sequence&&f.request>current.afterRequest&&f.paintedAt>=current.start)) {
        current.frames.push(frame);current.ms??=frame.paintedAt-current.start;current.settledMs=frame.paintedAt-current.start;
      }
      await finish(idle);
    };
    await insert('demo-first-edit',' I');
    await insert('demo-warm-edit','t');
    await insert('demo-warm-edit',' works',1600);
    await insert('demo-after-idle-edit',' instantly',650);
  }
  if (profileJob.rapid || profileJob.prewarmScenario) {
    // A finite open-loop input schedule. Awaiting a paint would hide queueing and
    // cancellation, while an unbounded flood would measure an unrealistic load.
    const burst = async (name, count, interval, body) => {
      const phase = {name, count, interval, start:performance.now(), firstFrame:profileFrames.length, startVisibility:visibility()};
      rapidPhases.push(phase);
      for (let i=0;i<count;i++) {
        const deadline = phase.start + i*interval;
        await wait(Math.max(0, deadline-performance.now()));
        const input = {id:profileInputs.length+1, phase:name, scheduledAt:deadline, injectedAt:performance.now(), visibility:visibility(), ...body(i)};
        profileInputs.push(input);
        const payload = {page:0, inputId:input.id, ...body(i)};
        if (profileHost) profileHost.postMessage({type:'profile-edit', ...payload});
        else fetch('/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
          .then(r=>{if(!r.ok)throw Error('Edit HTTP '+r.status);return r.json();})
          .then(ack=>{input.sequence=ack.sequence;input.acknowledgedAt=performance.now();})
          .catch(error=>errors.push(error.message));
      }
      phase.lastInputAt = profileInputs.at(-1).injectedAt;
      await until(()=>profileInputs.filter(i=>i.phase===name).every(i=>i.sequence!==undefined), 'Input source acknowledgments');
      const finalSequence = profileInputs.at(-1).sequence;
      await until(()=>profileFrames.some(f=>f.type==='image' && f.page===0 && f.sequence===finalSequence && f.paintedAt), 'Final source paint');
      const finalFrame = profileFrames.find(f=>f.type==='image' && f.page===0 && f.sequence===finalSequence && f.paintedAt);
      phase.finalSequence = finalSequence;
      phase.lastKeyToPaint = finalFrame.paintedAt-phase.lastInputAt;
      phase.finalPaintAt = finalFrame.paintedAt;
      // One documented idle window observes the production 350 ms SVG refinement.
      await until(()=>performance.now()>=phase.finalPaintAt+700 && !pendingMain.size, 'Post-burst idle refinement');
      phase.end = performance.now();
      const delivered = profileFrames.slice(phase.firstFrame).filter(f=>f.type==='image' && f.page===0);
      const frames = delivered.filter(f=>f.paintedAt).sort((a,b)=>a.paintedAt-b.paintedAt);
      phase.deliveredFrames = delivered.length;
      phase.cancelledBeforeMount = delivered.filter(f=>f.cancelledBeforeMount).length;
      phase.supersededBeforePaint = delivered.filter(f=>f.supersededBeforePaint).length;
      phase.visibleFrames = frames.length;
      phase.intermediateFrames = frames.filter(f=>f.sequence<finalSequence).length;
      phase.staleAtPaint = frames.filter(f=> {
        const last=profileInputs.filter(i=>i.injectedAt<=f.paintedAt && i.sequence!==undefined).at(-1);
        return last && f.sequence<last.sequence;
      }).length;
      phase.svgDuringInput = frames.filter(f=>f.mime==='image/svg+xml' && f.paintedAt<=phase.lastInputAt).length;
      phase.refinementsDuringInput = frames.filter(f=>f.upgrade && f.paintedAt<=phase.lastInputAt).length;
      phase.refinementsAfterInput = frames.filter(f=>f.upgrade && f.paintedAt>phase.lastInputAt).length;
      phase.bytes = delivered.reduce((sum,f)=>sum+f.bytes+f.patchBytes,0);
      for(const input of profileInputs.filter(i=>i.phase===name)) {
        const exact=frames.find(f=>f.sequence===input.sequence && f.paintedAt>=input.injectedAt);
        const caughtUp=frames.find(f=>f.sequence>=input.sequence && f.paintedAt>=input.injectedAt);
        if(exact)input.exactPaintMs=exact.paintedAt-input.injectedAt;
        if(caughtUp)input.caughtUpPaintMs=caughtUp.paintedAt-input.injectedAt;
        input.timerDelayMs=input.injectedAt-input.scheduledAt;
      }
      phase.endVisibility = visibility();
      const inputs = profileInputs.filter(i=>i.phase===name);
      phase.maxTimerLatenessMs = Math.max(...inputs.map(i=>i.timerDelayMs));
      phase.inputSpanMs = inputs.at(-1).injectedAt-inputs[0].injectedAt;
      phase.expectedSpanMs = (count-1)*interval;
      phase.validCadence = phase.maxTimerLatenessMs<=20 && phase.inputSpanMs<=phase.expectedSpanMs*1.2;
      phase.visibilityChanges = visibilityEvents.filter(e=>e.at>=phase.start && e.at<=phase.end);
      phase.visibleThroughout = phase.startVisibility.state==='visible' && phase.endVisibility.state==='visible' &&
        inputs.every(i=>i.visibility.state==='visible') && frames.every(f=>f.paintVisibility.state==='visible') &&
        phase.visibilityChanges.every(e=>e.state==='visible');
      phase.validComparison = phase.validCadence && phase.visibleThroughout;
      phase.coalescedInputs = profileInputs.filter(i=>i.phase===name && i.exactPaintMs===undefined).length;
      const firstChanged=frames.find(f=>f.sequence>=inputs[0].sequence);
      phase.firstPaintMs = firstChanged ? firstChanged.paintedAt-phase.start : undefined;
      profileRows.push({name,page:0,ms:phase.lastKeyToPaint,settledMs:phase.end-phase.start,frames});
    };
    if(profileJob.prewarmScenario) {
      if(profileJob.prewarmMode!=='cold') {
        const snapshot=()=>({page:document.getElementById('page').value,scrollTop:document.getElementById('viewport').scrollTop,scrollLeft:document.getElementById('viewport').scrollLeft,statusHidden:document.getElementById('status').hidden,format:document.getElementById('format').value});
        const before=snapshot(),requestedAt=performance.now();
        profileHost.postMessage({type:'profile-prewarm',inputId:'warmup',requestedAt});
        await until(()=>prewarmEvents.some(e=>e.inputId==='warmup'&&e.phase==='sent'),'Cursor prewarm acceptance');
        const ack=prewarmEvents.find(e=>e.inputId==='warmup'&&e.phase==='sent');
        if(profileJob.prewarmMode==='early') await wait(Math.max(0,ack.receivedAt+80-performance.now()));
        else {
          await until(()=>prewarmEvents.some(e=>e.phase==='complete'&&e.request===ack.request),'Cursor prewarm completion');
          const completed=prewarmEvents.find(e=>e.phase==='complete'&&e.request===ack.request);
          if(!['ready','cached'].includes(completed.result)) throw Error('Cursor prewarm did not produce a checkpoint: '+JSON.stringify(completed));
        }
        const after=snapshot(),preserved=JSON.stringify(before)===JSON.stringify(after);
        prewarmEvents.push({phase:'ui',before,after,preserved});
        if(!preserved)throw Error('Cursor prewarm changed preview navigation or status: '+JSON.stringify({before,after}));
      }
      const sentence=' It works instantly';
      await burst('sentence-typing',sentence.length,100,i=>({mode:'demo',text:sentence[i]}));
      const phase=rapidPhases.at(-1);
      const sent=prewarmEvents.find(e=>e.phase==='sent');
      if(sent&&sent.hostSentAt<=profileInputs[0].hostAppliedAt)phase.hostPrepareToFirstAppliedInputMs=profileInputs[0].hostAppliedAt-sent.hostSentAt;
      if(!phase.validComparison) throw Error('Invalid sentence input cadence/visibility: '+JSON.stringify(phase));
    } else {
      await burst('typing-overlap',12,100,i=>({mode:'letter',letter:'abcdefghijkl'[i]}));
      await burst('backspace-overlap',12,100,()=>({mode:'backspace'}));
      if(profileJob.fixture.startsWith('tikz')) await burst('coordinate-overlap',8,125,()=>({coordinate:true}));
    }
  }
  if (!profileJob.richDemo && !profileJob.rapid && !profileJob.navOnly) {
  for (let i=0;i<5;i++) await operation('edit-letter',0,true,()=>edit({mode:'letter',letter:'abcde'[i]}),i===4?650:80);
  for (let i=0;i<2;i++) await operation('edit-backspace',0,true,()=>edit({mode:'backspace'}),i===1?650:80);
  for (let i=0;i<3;i++) await operation('edit-text',0,true,()=>edit({}),i===2?650:80);
  if (profileJob.fixture.startsWith('tikz')) for (let i=0;i<3;i++) await operation('edit-coordinate',0,true,()=>edit({coordinate:true}),i===2?650:80);
  await operation('edit-font',0,true,()=>edit({mode:'font'}),650);
  }
  if (profileJob.extras) {
    const viewport=document.getElementById('viewport');
    const afterSource=latestSequence;
    const settledFrames = (at, firstFrame) => profileFrames.slice(firstFrame).filter(frame=>frame.page===0 && frame.sequence>=afterSource && frame.paintedAt>=at);
    const extraRow = (name,start,firstFrame,firstMs,extra={}) => {
      const frames=settledFrames(start,firstFrame);
      profileRows.push({name,page:0,start,ms:firstMs,settledMs:Math.max(firstMs,...frames.map(frame=>frame.paintedAt-start)),frames,
        firstMime:frames[0]?.mime || profileFrames.filter(f=>f.type==='image'&&f.page===0&&f.paintedAt).at(-1)?.mime,
        finalMime:profileFrames.filter(f=>f.type==='image'&&f.page===0&&f.paintedAt).at(-1)?.mime,
        ...memorySnapshot(),...extra});
    };
    const settleExtra = async (start,firstFrame,idle=650) => {
      await until(()=>performance.now()>=start+idle && !pendingMain.size && !pendingRegions.size &&
        profileFrames.slice(firstFrame).every(frame=>frame.paintedAt || frame.cancelledBeforeMount || frame.supersededBeforePaint),'Extra-operation render completion');
    };
    const zoomTo = async (name,value) => {
      const control=document.getElementById('zoom'), start=performance.now(), firstFrame=profileFrames.length;
      const before=surfaceMetrics(0); control.value=value; control.dispatchEvent(new Event('change'));
      await painted(); const firstMs=performance.now()-start;
      // Both formats can immediately scale an existing surface; the later matching
      // full-page/detail ACK records sharper PNG replacement separately.
      const scaled=surfaceMetrics(0); await settleExtra(start,firstFrame);
      extraRow(name,start,firstFrame,firstMs,{before,scaled,zoom:value,firstVisual:'existing surface after zoom layout'});
    };
    await zoomTo('zoom-200','2');
    await zoomTo('zoom-fit-width','width');
    const sheet=sheetFor(0), surface=surfaceFor(0), toggle=document.getElementById('magnify');
    if (!sheet || !surface || toggle.disabled) throw Error('Magnifier fixture has no current interactive surface');
    if (toggle.getAttribute('aria-pressed')!=='true') toggle.click();
    const rect=surface.getBoundingClientRect(), clip=viewport.getBoundingClientRect();
    const point={x:Math.max(clip.left+30,Math.min(clip.right-30,rect.left+rect.width*.45)),
      y:Math.max(clip.top+30,Math.min(clip.bottom-30,rect.top+rect.height*.32))};
    const pointer=(type,x,y)=>sheet.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==='pointerup'?0:1,pointerId:17,clientX:x,clientY:y}));
    const lensSnapshot=()=>({hidden:document.getElementById('lens').hidden,
      vector:!document.getElementById('lensVector').hidden && !!document.getElementById('lensVector').firstChild,
      canvasPixels:document.getElementById('lensCanvas').width*document.getElementById('lensCanvas').height,
      nativeImage:!document.getElementById('lensImage').hidden && !!document.getElementById('lensImage').getAttribute('src'),
      nativeWidth:document.getElementById('lensImage').naturalWidth});
    const start=performance.now(), firstFrame=profileFrames.length, requestsAt=profileRequests.length;
    // Synthetic profiling pointers do not have a browser-native capture ID. Only
    // capture registration is stubbed; the production lens handlers/renderers run.
    const capture=sheet.setPointerCapture; sheet.setPointerCapture=()=>{};
    try { pointer('pointerdown',point.x,point.y); } finally { sheet.setPointerCapture=capture; }
    await painted(); const firstMs=performance.now()-start, firstLens=lensSnapshot();
    if (firstLens.hidden) throw Error('Production magnifier did not open');
    if (!firstLens.vector) {
      await until(()=>profileRequests.slice(requestsAt).some(request=>request.type==='region'&&request.page===0),'PNG magnifier request');
      const request=profileRequests.slice(requestsAt).find(request=>request.type==='region'&&request.page===0);
      await until(()=>profileFrames.some(frame=>frame.type==='region'&&frame.page===0&&frame.token===request.token&&frame.paintedAt),'PNG magnifier matching region paint');
      if(!lensSnapshot().nativeImage) throw Error('Magnifier region ACK did not mount its sharp image');
    }
    extraRow('magnifier-open',start,firstFrame,firstMs,{firstLens,finalLens:lensSnapshot(),
      nativeRegionRequests:profileRequests.slice(requestsAt).filter(request=>request.type==='region').length,
      syntheticPointerCapture:true});
    const moveStart=performance.now(), moveFrame=profileFrames.length, moveRequests=profileRequests.length, movePaintMs=[];
    for(const offset of [2,4,6]) { const moved=performance.now();pointer('pointermove',point.x+offset,point.y+offset);await painted();movePaintMs.push(performance.now()-moved); }
    await wait(100);
    extraRow('magnifier-small-moves',moveStart,moveFrame,movePaintMs[0],{finalLens:lensSnapshot(),
      moves:3,movePaintMs,elapsedMs:performance.now()-moveStart,nativeRegionRequests:profileRequests.slice(moveRequests).filter(request=>request.type==='region').length});
    const far={x:Math.min(clip.right-20,rect.right-20,point.x+160),y:point.y};
    const farStart=performance.now(), farFrame=profileFrames.length, farRequests=profileRequests.length;
    pointer('pointermove',far.x,far.y);await painted();const farFirstMs=performance.now()-farStart;
    if(!firstLens.vector) {
      await until(()=>profileRequests.slice(farRequests).some(request=>request.type==='region'&&request.page===0),'Moved PNG magnifier request');
      const request=profileRequests.slice(farRequests).find(request=>request.type==='region'&&request.page===0);
      await until(()=>profileFrames.some(frame=>frame.type==='region'&&frame.page===0&&frame.token===request.token&&frame.paintedAt),'Moved PNG matching region paint');
    }
    extraRow('magnifier-large-move',farStart,farFrame,farFirstMs,{finalLens:lensSnapshot(),
      distanceCss:Math.hypot(far.x-point.x,far.y-point.y),nativeRegionRequests:profileRequests.slice(farRequests).filter(request=>request.type==='region').length});
    pointer('pointerup',far.x,far.y);
    if(toggle.getAttribute('aria-pressed')==='true')toggle.click();
    await painted();
    if(!lensSnapshot().hidden || document.getElementById('lensImage').getAttribute('src')) throw Error('Magnifier did not release its visible native tile');
  }
  const activePage=Number(document.getElementById('page').value)-1;
  const activeSurface=surfaceFor(activePage);
  const source=activeSurface instanceof HTMLCanvasElement || activeSurface instanceof HTMLImageElement ? activeSurface : undefined;
  const readback=[];
  if(source) for(let i=0;i<3;i++) {
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),rect=source.getBoundingClientRect();
    canvas.width=Math.ceil(rect.width*devicePixelRatio);canvas.height=Math.ceil(rect.height*devicePixelRatio);
    const start=performance.now();ctx.drawImage(source,0,0,canvas.width,canvas.height);ctx.getImageData(0,0,canvas.width,canvas.height);
    readback.push(performance.now()-start);canvas.width=canvas.height=0;await painted();
  }
  const mainFrames = profileFrames.filter(f=>f.type==='image' && f.paintedAt);
  const uiChecks = {normalStatusHidden:mainFrames.every(f=>f.statusHidden), autoLabelStable:mainFrames.every(f=>f.autoLabel==='Auto')};
  if(profileJob.earlyInput && (!uiChecks.normalStatusHidden || !uiChecks.autoLabelStable)) throw Error('Normal preview UI assertions failed: '+JSON.stringify(uiChecks));
  const result={...profileJob,uiChecks,ua:navigator.userAgent,dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],
    rows:profileRows,frames:profileFrames,regionRequests:profileRequests,inputs:profileInputs,rapidPhases,visibilityEvents,prewarmEvents,rasterReadbackMs:readback,errors};
  if (profileHost) { profileHost.postMessage({type:'profile-result',result});return; }
  await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
  const select=name=>profileRows.filter(r=>r.name===name).map(r=>r.ms);
  parent.postMessage({profileDone:true,summary:{...profileJob,dpr:devicePixelRatio,metrics:{initial:select('initial'),page:select('page-first-compiled'),
    cache:[...select('page-previous-cached'),...select('page-next-cached')],typing:profileJob.rapid?select('typing-overlap'):select('edit-letter'),edit:profileJob.rapid?select('backspace-overlap'):select('edit-text'),coordinate:profileJob.rapid?select('coordinate-overlap'):select('edit-coordinate'),
    decode:profileFrames.filter(f=>f.dispatchToDecoded!==undefined).map(f=>f.dispatchToDecoded)}}},location.origin);
})().catch(error=>{document.getElementById('status').hidden=false;document.getElementById('status').textContent='PROFILE ERROR: '+error.message;console.error(error);profileHost?.postMessage({type:'profile-error',error:error.message,partial:{...profileJob,rows:profileRows,frames:profileFrames,inputs:profileInputs,rapidPhases,errors}});});
