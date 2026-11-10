/* Test-only observer around the unmodified production webview. Timing excludes
 * PNG readback/encoding; those captures run after the measured operations. */
const job = __JOB__, host = acquireVsCodeApi();
const frames = [], operations = [], errors = [], inputs = [], visibility = [];
const byId = new Map(), shown = new Map(), acks = new Map(), pending = new Set();
const probes=new Map();let nextProbe=0;
const now = () => performance.now(), wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const viewport = () => document.getElementById('viewport');
const pageNumber = () => Number(document.getElementById('page').value)-1;
let latestSequence=0, nextInput=0;
document.addEventListener('visibilitychange',()=>visibility.push({at:now(),state:document.visibilityState}));
window.measurementAcquireVsCodeApi = () => ({getState:()=>({page:0,zoom:'width',format:job.codec}),setState:()=>{},postMessage:m=>{
  if (m.type==='decode-error'||m.type==='cache-miss') errors.push({type:m.type,id:m.id,at:now()});
  host.postMessage(m);
  if (m.type!=='decoded') return;
  const frame=byId.get(m.id); if(!frame)return;
  frame.decoded=now();frame.stale=m.stale;frame.displayed=m.displayed;frame.renderMs=m.renderMs;
  if(frame.type==='image' && !m.stale && m.displayed!==false) shown.set(frame.page,frame);
  paint().then(()=>{
    frame.painted=now();pending.delete(m.id);
    if(frame.type==='image' && shown.get(frame.page)===frame && !m.stale)latestSequence=Math.max(latestSequence,frame.sequence);
  });
}});
window.addEventListener('message',event=>{
  const m=event.data;
  if(m.type==='measurement-edit-ack'){acks.set(m.id,m);return;}
  if(m.type==='measurement-probe-ack'){probes.set(m.id,m.busy);return;}
  if(m.type==='error')errors.push({type:m.type,text:m.text,at:now()});
  if(!m.header || !['image','detail','region'].includes(m.type))return;
  const h=m.header,frame={type:m.type,id:h.requestId,page:h.page,sequence:h.sequence,revision:h.revision,mime:h.mime,
    width:h.width,height:h.height,bytes:m.bytes?.byteLength||0,svgPatch:!!m.svgPatch,pngPatch:!!m.rasterPatch,
    cache:!m.bytes&&!m.svgPatch&&!m.rasterPatch,refining:m.refining,received:now()};
  frames.push(frame);byId.set(frame.id,frame);pending.add(frame.id);
});
const until=async(check,label,timeout=45000)=>{
  const end=now()+timeout;
  while(!check()) {if(now()>end)throw Error(label+': '+JSON.stringify({page:pageNumber(),errors,frames:frames.slice(-3)}));await wait(10);}
};
const part=(sheet,name)=>sheet?.querySelector('[data-part="'+name+'"]');
const sheetFor=page=>document.querySelector('.page-sheet[data-page="'+page+'"]');
const surface=sheet=>sheet?.querySelector('[data-part="raster"]:not([hidden]) > canvas')||
  sheet?.querySelector('[data-part="vector"]:not([hidden]) .texpresso-svg-layer.active > svg')||
  sheet?.querySelector('[data-part="image"]:not([hidden])');
function quality(page) {
  const sheet=sheetFor(page),base=surface(sheet),v=viewport(),clip=v.getBoundingClientRect(),r=sheet?.getBoundingClientRect(),frame=shown.get(page);
  if(!r||!frame||sheet.dataset.stale!=='false')return {sharp:false,ready:false};
  const visible={left:Math.max(r.left,clip.left+v.clientLeft),top:Math.max(r.top,clip.top+v.clientTop),
    right:Math.min(r.right,clip.left+v.clientLeft+v.clientWidth),bottom:Math.min(r.bottom,clip.top+v.clientTop+v.clientHeight)};
  const visibleArea=visible.right>visible.left && visible.bottom>visible.top;
  const ratio=frame.width/r.width/devicePixelRatio;
  const detail=part(sheet,'detail'),d=detail&&!detail.hidden&&detail.complete&&detail.naturalWidth ? detail.getBoundingClientRect() : undefined;
  const detailRatio=d?detail.naturalWidth/d.width/devicePixelRatio:0;
  const covers=!!d&&d.left<=visible.left+2&&d.top<=visible.top+2&&d.right>=visible.right-2&&d.bottom>=visible.bottom-2;
  return {ready:visibleArea,sharp:visibleArea&&(frame.mime==='image/svg+xml'||ratio>=.98||(covers&&detailRatio>=.98)),
    mime:frame.mime,baseRatio:ratio,detailRatio,detailCovers:covers,cssWidth:r.width,cssHeight:r.height,
    rasterWidth:frame.width,rasterHeight:frame.height,visible,detail:!!d,sequence:frame.sequence,baseNode:base?.tagName};
}
function memory() {return {residentBytes:Number(viewport().dataset.residentBytes||0),
  canvasPixels:[...document.querySelectorAll('canvas')].reduce((n,c)=>n+c.width*c.height,0),domNodes:document.querySelectorAll('*').length,
  heapBytes:performance.memory?.usedJSHeapSize};}
const navigate=page=>{const input=document.getElementById('page');input.value=String(page+1);input.dispatchEvent(new Event('change'));};
const zoom=value=>{const input=document.getElementById('zoom');if(![...input.options].some(o=>o.value===value)){const o=document.createElement('option');o.value=value;input.append(o);}input.value=value;input.dispatchEvent(new Event('change'));};
async function operation(name,action,page,minimumSequence=0) {
  const start=now(),frameStart=frames.length;await action();await paint();
  // Continuous scrolling can make a neighboring landscape slide the centered
  // page while the requested slide is still visibly present.
  await until(()=>quality(page).ready&&shown.get(page)?.sequence>=minimumSequence,name+' visible');
  const firstVisual=now()-start, firstQuality=quality(page);
  let sharpMs=firstQuality.sharp?firstVisual:undefined;
  const qualityTimeline=[{at:firstVisual,sharp:firstQuality.sharp,mime:firstQuality.mime,base:firstQuality.baseRatio,detail:firstQuality.detailRatio}];
  let lastSharp=firstQuality.sharp;
  let lastProbe=0,probeAt=-Infinity;
  const deadline=start+2200;
  while(now()<deadline) {
    const q=quality(page);
    if(now()-probeAt>=50){lastProbe=++nextProbe;probeAt=now();host.postMessage({type:'measurement-probe',id:lastProbe});}
    if(q.sharp!==lastSharp){qualityTimeline.push({at:now()-start,sharp:q.sharp,mime:q.mime,base:q.baseRatio,detail:q.detailRatio});lastSharp=q.sharp;}
    if(sharpMs===undefined&&q.sharp)sharpMs=now()-start;
    const last=frames.slice(frameStart).filter(f=>f.painted&&!f.stale).at(-1)?.painted||start;
    if(now()-start>=750&&!pending.size&&probes.get(lastProbe)===false&&now()-last>=180&&(sharpMs!==undefined||now()>=deadline-20))break;
    await wait(10);
  }
  const durableSharpMs=lastSharp ? qualityTimeline.filter(q=>q.sharp).at(-1)?.at : null;
  const row={name,page,start,firstVisualMs:firstVisual,sharpMs:sharpMs??null,durableSharpMs,qualityTimeline,firstQuality,finalQuality:quality(page),
    settledMs:Math.max(firstVisual,...frames.slice(frameStart).filter(f=>f.painted&&!f.stale).map(f=>f.painted-start)),
    frameIds:frames.slice(frameStart).map(f=>f.id),memory:memory(),scroll:[viewport().scrollLeft,viewport().scrollTop]};
  operations.push(row);return row;
}
async function edit(text,undo=false) {
  const id=++nextInput;host.postMessage({type:'measurement-edit',id,text,undo});
  await until(()=>acks.has(id),'source edit acknowledged');return acks.get(id).sequence;
}
async function capture(name,page) {
  const sheet=sheetFor(page),v=viewport(),clip=v.getBoundingClientRect(),rect=sheet.getBoundingClientRect();
  const canvas=document.createElement('canvas');canvas.width=v.clientWidth*devicePixelRatio;canvas.height=v.clientHeight*devicePixelRatio;
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  const draw=async node=>{
    const r=node.getBoundingClientRect();let image=node,url;
    if(node.tagName.toLowerCase()==='svg'){
      const svg=node.cloneNode(true);svg.setAttribute('xmlns','http://www.w3.org/2000/svg');svg.setAttribute('width',String(r.width*devicePixelRatio));svg.setAttribute('height',String(r.height*devicePixelRatio));
      url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'}));image=new Image();image.src=url;await image.decode();
    }
    context.drawImage(image,(r.left-clip.left-v.clientLeft)*devicePixelRatio,(r.top-clip.top-v.clientTop)*devicePixelRatio,r.width*devicePixelRatio,r.height*devicePixelRatio);
    if(url)URL.revokeObjectURL(url);
  };
  await draw(surface(sheet));const detail=part(sheet,'detail');if(detail&&!detail.hidden&&detail.complete&&detail.naturalWidth)await draw(detail);
  const image=context.getImageData(0,0,canvas.width,canvas.height);let ink=0;
  for(let i=0;i<image.data.length;i+=4)if(image.data[i]<180||image.data[i+1]<180||image.data[i+2]<180)ink++;
  if(ink<200)throw Error('Capture has no visible ink: '+name);
  host.postMessage({type:'measurement-capture',name,png:canvas.toDataURL('image/png').split(',')[1]});
  return {name,width:canvas.width,height:canvas.height,ink,quality:quality(page),pageCss:[rect.width,rect.height]};
}
(async()=>{
  const opening=now();await until(()=>shown.get(0)?.painted&&quality(0).ready,'initial page');
  if(Math.abs(devicePixelRatio-job.dpr)>.01)throw Error('DPR mismatch '+devicePixelRatio+' vs '+job.dpr);
  if(innerWidth+1<job.width)throw Error('Benchmark body is clipped by real webview '+innerWidth+' < '+job.width);
  operations.push({name:'initial',firstVisualMs:now()-opening,page:0,memory:memory(),quality:quality(0)});
  await operation('focus',()=>navigate(job.focusPage),job.focusPage);
  const page=job.focusPage;
  // Prose/title edits on the measured page; record cold separately from warm.
  const coldStart=now(),coldSequence=await edit(' ');
  await until(()=>shown.get(page)?.sequence>=coldSequence&&shown.get(page)?.painted&&!shown.get(page)?.stale,'cold edit visible');
  inputs.push({kind:'cold',id:nextInput,injected:coldStart,sequence:coldSequence,frameId:shown.get(page).id,paint:shown.get(page).painted,latencyMs:shown.get(page).painted-coldStart});
  for(let i=0;i<8;i++) {
    const start=now(),seq=await edit('abcdefgh'[i]);
    await until(()=>shown.get(page)?.sequence>=seq&&shown.get(page)?.painted&&!shown.get(page)?.stale,'warm edit visible');
    inputs.push({kind:'paced',id:nextInput,injected:start,sequence:seq,frameId:shown.get(page).id,paint:shown.get(page).painted,latencyMs:shown.get(page).painted-start});
    await wait(Math.max(0,100-(now()-start)));
  }
  // Open-loop burst: do not await image arrival or host ACK before the next key.
  const burstStart=now();let burstLast=0;const burst=[];
  for(let i=0;i<12;i++) {
    await wait(Math.max(0,burstStart+i*100-now()));const injected=now(),id=++nextInput;
    burst.push({id,injected,lateness:injected-(burstStart+i*100)});host.postMessage({type:'measurement-edit',id,text:'ijklmnopqrst'[i]});burstLast=id;
  }
  await until(()=>acks.has(burstLast),'burst acknowledged');const sequence=acks.get(burstLast).sequence;
  await until(()=>shown.get(page)?.sequence>=sequence&&shown.get(page)?.painted&&!shown.get(page)?.stale,'burst final paint');
  const burstFrame=shown.get(page),burstResult={inputs:burst,lastKeyToPaintMs:burstFrame.painted-burst.at(-1).injected,
    maximumLatenessMs:Math.max(...burst.map(i=>i.lateness)),validCadence:burst.every(i=>i.lateness<=40),
    visibleGenerations:frames.filter(f=>f.type==='image'&&f.page===page&&!f.stale&&f.painted>=burstStart&&f.painted<=burstFrame.painted).map(f=>f.sequence)};
  for(let i=0;i<21;i++)await edit('',true);
  await until(()=>shown.get(page)?.sequence>=acks.get(nextInput).sequence&&shown.get(page)?.painted,'undo settles');
  await operation('zoom-100',()=>zoom('1'),page);
  await operation('zoom-125',()=>zoom('1.25'),page);
  await operation('zoom-200',()=>zoom('2'),page);
  await operation('pan-right',()=>{viewport().scrollLeft+=Math.min(240,viewport().clientWidth/3);viewport().dispatchEvent(new Event('scroll'));},page);
  await operation('pan-down',()=>{const v=viewport(),r=sheetFor(page).getBoundingClientRect(),clip=v.getBoundingClientRect();
    const top=v.scrollTop+r.top-clip.top-v.clientTop,max=top+Math.max(0,r.height-v.clientHeight);
    v.scrollTop=Math.min(v.scrollTop+Math.min(180,v.clientHeight/3),max);v.dispatchEvent(new Event('scroll'));},page);
  const captures=[];if(job.capture)captures.push(await capture('zoom-200-panned',page));
  await operation('fit-width',()=>zoom('width'),page);
  if(job.capture)captures.push(await capture('fit-width',page));
  await operation('next-page',()=>navigate(page+1),page+1);
  await operation('cached-return',()=>navigate(page),page);
  host.postMessage({type:'measurement-result',result:{...job,dpr:devicePixelRatio,viewport:[viewport().clientWidth,viewport().clientHeight],
    operations,inputs,burst:burstResult,frames,captures,errors,visibility,hidden:document.hidden}});
})().catch(error=>host.postMessage({type:'measurement-error',error:error.stack||error.message}));
