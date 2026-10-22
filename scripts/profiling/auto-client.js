/* Auto end-to-end experiment: production assets/controller, a local binary
 * bridge, and separate first-visible/idle-refined paint opportunities. */
const profileJob = __JOB__;
const profileHost = profileJob.vscode ? acquireVsCodeApi() : undefined;
const profileRows = [], profileFrames = [], errors = [], pendingMain = new Set();
let current, latestSequence = 0, latestRequest = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const until = async (check, description) => {
  const deadline = performance.now() + 60000;
  while (!check()) {
    if (performance.now() > deadline || errors.length) throw Error(description + ': ' + errors.join('; '));
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
    frame.inlineSvg = !!m.svg; frame.canvasPng = !!m.png;
    frame.dispatchToDecoded = performance.now() - frame.dispatched;
    latestSequence = Math.max(latestSequence, frame.sequence);
    latestRequest = Math.max(latestRequest, m.id);
    const op = current;
    painted().then(() => {
      frame.paintedAt = performance.now();
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
      cacheReference:!data.frame && !data.svgPatch && !data.rasterPatch,
      patchBytes:data.svgPatch ? new TextEncoder().encode(JSON.stringify(data.svgPatch)).length : 0,
      width:data.header.width,height:data.header.height, vectorCost:data.header.vectorCost,
      refining:data.refining, processingMs:data.profileProcessingMs,transferMs,dispatched});
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
  await finish(650);
  const operation = async (name,page,edit,action,idle=80) => {
    current = {name,page,start:performance.now(),minSequence:latestSequence+(edit?1:0),afterRequest:latestRequest,frames:[]};
    await action(); await finish(idle);
  };
  const navigate = page => { const input=document.getElementById('page');input.value=String(page+1);input.dispatchEvent(new Event('change')); };
  const edit = body => profileHost ? profileHost.postMessage({type:'profile-edit',page:0,...body}) :
    fetch('/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page:0,...body})});
  if (profileJob.pages > 1) {
    await operation('page-next-new',1,false,()=>navigate(1),650);
    await operation('page-previous-cached',0,false,()=>navigate(0));
    await operation('page-next-cached',1,false,()=>navigate(1));
    await operation('page-last-new',profileJob.pages-1,false,()=>navigate(profileJob.pages-1),650);
    await operation('page-first-compiled',0,false,()=>navigate(0),650);
  }
  if (!profileJob.navOnly) {
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
  const result={...profileJob,ua:navigator.userAgent,dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],
    rows:profileRows,frames:profileFrames,rasterReadbackMs:readback,errors};
  if (profileHost) { profileHost.postMessage({type:'profile-result',result});return; }
  await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
  const select=name=>profileRows.filter(r=>r.name===name).map(r=>r.ms);
  parent.postMessage({profileDone:true,summary:{...profileJob,dpr:devicePixelRatio,metrics:{initial:select('initial'),page:select('page-first-compiled'),
    cache:[...select('page-previous-cached'),...select('page-next-cached')],typing:select('edit-letter'),edit:select('edit-text'),coordinate:select('edit-coordinate'),
    decode:profileFrames.filter(f=>f.decodeMs!==undefined).map(f=>f.decodeMs)}}},location.origin);
})().catch(error=>{document.getElementById('status').textContent='PROFILE ERROR: '+error.message;console.error(error);profileHost?.postMessage({type:'profile-error',error:error.message});});
