/* Auto end-to-end experiment: production assets/controller, a local binary
 * bridge, and separate first-visible/idle-refined paint opportunities. */
const profileJob = __JOB__;
const profileHost = profileJob.vscode ? acquireVsCodeApi() : undefined;
const profileRows = [], profileFrames = [], errors = [], pendingMain = new Set();
let current, latestSequence = 0, latestRequest = 0, displayedMainRequest = 0;
const profileInputs = [], rapidPhases = [], visibilityEvents = [];
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
const originalDecode = HTMLImageElement.prototype.decode;
HTMLImageElement.prototype.decode = async function() {
  const start = performance.now();
  await originalDecode.call(this);
  const frame = profileFrames.at(-1);
  if (frame) frame.decodeMs = performance.now() - start;
};
const profileApi = () => ({
  getState: () => ({ page:0, zoom:'width', format:profileJob.codec }), setState: () => {},
  postMessage: m => {
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
    frame.inlineSvg = !!m.svg; frame.canvasPng = !!m.png;
    frame.dispatchToDecoded = performance.now() - frame.dispatched;
    if (frame.type === 'image') displayedMainRequest = m.id;
    frame.decodedAt = performance.now();
    latestSequence = Math.max(latestSequence, frame.sequence);
    latestRequest = Math.max(latestRequest, m.id);
    const op = current;
    painted().then(() => {
      // A decoded bitmap replaced before the paint opportunity was never visible.
      if (frame.type === 'image' && displayedMainRequest !== m.id) {
        frame.supersededBeforePaint = true; pendingMain.delete(m.id); return;
      }
      frame.paintedAt = performance.now();
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
  if (data.type === 'profile-edit-ack') {
    const input = profileInputs.find(i => i.id === data.inputId);
    if (input) { input.sequence = data.sequence; input.acknowledgedAt = performance.now(); }
    return;
  }
  if (data.type === 'error' || data.type === 'decode-error') errors.push(data.text || data.type);
  if (data.type === 'image' || data.frame) {
    const dispatched = performance.now();
    if (data.type === 'image') pendingMain.add(data.header.requestId);
    let transferMs = 0;
    if (data.frame) {
      const start = performance.now(), response = await fetch(data.frame);
      if (!response.ok) { errors.push('Frame HTTP ' + response.status); return; }
      data.bytes = await response.arrayBuffer(); transferMs = performance.now() - start;
    }
    profileFrames.push({type:data.type,request:data.header.requestId,page:data.header.page,sequence:data.header.sequence,
      mime:data.header.mime, bytes:data.bytes?.byteLength || 0,
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
    op.heapBytes = performance.memory?.usedJSHeapSize;
    op.domNodes = document.querySelectorAll('*').length;
    op.canvasPixels = [...document.querySelectorAll('canvas')].reduce((n,c)=>n+c.width*c.height,0);
    profileRows.push(op); current = undefined;
  };
  await finish(profileJob.earlyInput ? 80 : 650);
  const operation = async (name,page,edit,action,idle=80) => {
    current = {name,page,start:performance.now(),minSequence:latestSequence+(edit?1:0),afterRequest:latestRequest,frames:[]};
    await action(); await finish(idle);
  };
  const navigate = page => { const input=document.getElementById('page');input.value=String(page+1);input.dispatchEvent(new Event('change')); };
  const edit = body => profileHost ? profileHost.postMessage({type:'profile-edit',page:0,...body}) :
    fetch('/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page:0,...body})});
  if (!profileJob.rapid && profileJob.pages > 1) {
    await operation('page-next-new',1,false,()=>navigate(1),650);
    await operation('page-previous-cached',0,false,()=>navigate(0));
    await operation('page-next-cached',1,false,()=>navigate(1));
    await operation('page-last-new',profileJob.pages-1,false,()=>navigate(profileJob.pages-1),650);
    await operation('page-first-compiled',0,false,()=>navigate(0),650);
  }
  if (profileJob.rapid) {
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
      await until(()=>profileFrames.some(f=>f.type==='image' && f.sequence===finalSequence && f.paintedAt), 'Final source paint');
      const finalFrame = profileFrames.find(f=>f.type==='image' && f.sequence===finalSequence && f.paintedAt);
      phase.finalSequence = finalSequence;
      phase.lastKeyToPaint = finalFrame.paintedAt-phase.lastInputAt;
      phase.finalPaintAt = finalFrame.paintedAt;
      // One documented idle window observes the production 350 ms SVG refinement.
      await until(()=>performance.now()>=phase.finalPaintAt+700 && !pendingMain.size, 'Post-burst idle refinement');
      phase.end = performance.now();
      const delivered = profileFrames.slice(phase.firstFrame).filter(f=>f.type==='image');
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
      phase.firstPaintMs = frames.length ? frames[0].paintedAt-phase.start : undefined;
      profileRows.push({name,page:0,ms:phase.lastKeyToPaint,settledMs:phase.end-phase.start,frames});
    };
    await burst('typing-overlap',12,100,i=>({mode:'letter',letter:'abcdefghijkl'[i]}));
    await burst('backspace-overlap',12,100,()=>({mode:'backspace'}));
    if(profileJob.fixture.startsWith('tikz')) await burst('coordinate-overlap',8,125,()=>({coordinate:true}));
  }
  if (!profileJob.rapid && !profileJob.navOnly) {
  for (let i=0;i<5;i++) await operation('edit-letter',0,true,()=>edit({mode:'letter',letter:'abcde'[i]}),i===4?650:80);
  for (let i=0;i<2;i++) await operation('edit-backspace',0,true,()=>edit({mode:'backspace'}),i===1?650:80);
  for (let i=0;i<3;i++) await operation('edit-text',0,true,()=>edit({}),i===2?650:80);
  if (profileJob.fixture.startsWith('tikz')) for (let i=0;i<3;i++) await operation('edit-coordinate',0,true,()=>edit({coordinate:true}),i===2?650:80);
  await operation('edit-font',0,true,()=>edit({mode:'font'}),650);
  }
  const svg=document.getElementById('vector'), raster=document.getElementById('raster');
  const source=!raster.hidden?raster.querySelector('canvas'):svg.hidden?document.getElementById('image'):undefined;
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
    rows:profileRows,frames:profileFrames,inputs:profileInputs,rapidPhases,visibilityEvents,rasterReadbackMs:readback,errors};
  if (profileHost) { profileHost.postMessage({type:'profile-result',result});return; }
  await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
  const select=name=>profileRows.filter(r=>r.name===name).map(r=>r.ms);
  parent.postMessage({profileDone:true,summary:{...profileJob,dpr:devicePixelRatio,metrics:{initial:select('initial'),page:select('page-first-compiled'),
    cache:[...select('page-previous-cached'),...select('page-next-cached')],typing:profileJob.rapid?select('typing-overlap'):select('edit-letter'),edit:profileJob.rapid?select('backspace-overlap'):select('edit-text'),coordinate:profileJob.rapid?select('coordinate-overlap'):select('edit-coordinate'),
    decode:profileFrames.filter(f=>f.decodeMs!==undefined).map(f=>f.decodeMs)}}},location.origin);
})().catch(error=>{document.getElementById('status').hidden=false;document.getElementById('status').textContent='PROFILE ERROR: '+error.message;console.error(error);profileHost?.postMessage({type:'profile-error',error:error.message,partial:{...profileJob,rows:profileRows,frames:profileFrames,inputs:profileInputs,rapidPhases,errors}});});
