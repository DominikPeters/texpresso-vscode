const api=acquireVsCodeApi(),surface=document.getElementById('surface');
let page,received=[],hidden=[];
document.addEventListener('visibilitychange',()=>hidden.push(document.visibilityState));
const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
function normalized(page) {
  const visit=node=>[node.localName,[...node.attributes].filter(a=>a.namespaceURI!=='http://www.w3.org/2000/xmlns/').map(a=>{
    let value=a.value;
    if(a.localName==='id')value=value.slice(page.scope.length);
    else if(a.localName==='href')value='#'+value.slice(1+page.scope.length);
    else if(['clip-path','mask','fill','stroke'].includes(a.localName)&&value.startsWith('url(#'+page.scope))value='url(#'+value.slice(5+page.scope.length);
    return [a.namespaceURI||'',a.localName,value];
  }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),[...node.children].map(visit)];
  return JSON.stringify(visit(page.root));
}
function assertions() {
  const xml='<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="a" d="M0 0L1 1"/></defs><use href="#a" transform="translate(1 2)"/><use href="#a" transform="translate(3 4)"/></svg>';
  const page=TexpressoSvgPage.create(xml,'a'),a=page.root.children[1],b=page.root.children[2];
  page.patch({base:'a',operations:[{path:[],start:1,remove:0,xml:'<use href="#a" transform="translate(0 0)"/>'}],transforms:[{path:[],start:1,values:['translate(7 8)','translate(9 10)']}]},'b');
  if(page.root.children[2]!==a||page.root.children[3]!==b||a.getAttribute('transform')!=='translate(7 8)')throw Error('Glyph identity/indices not retained');
  const snapshot=page.root.outerHTML;
  for(const bad of [
    {operations:[{path:[],start:1,remove:0,xml:'<use href="#a"/>'}],transforms:[{path:[],start:2,values:['javascript:alert(1)']}]},
    {operations:[{path:[],start:2,remove:1,xml:''}],transforms:[{path:[],start:2,values:['translate(1 2)']}]},
    {operations:[],transforms:[{path:[],start:2,values:['translate(1 2)']},{path:[],start:2,values:['translate(3 4)']}]},
    {operations:[],transforms:[{path:[],start:0,values:['translate(1 2)']}]},
    {operations:[],transforms:[{path:[],start:1,values:Array(1025).fill('translate(1 2)')}]}
  ]) {
    let rejected=false;try{page.patch({base:'b',...bad},'bad');}catch{rejected=true;}
    if(!rejected||page.root.outerHTML!==snapshot||page.contentId!=='b')throw Error('Invalid patch was not atomic');
  }
}
window.addEventListener('message',async event=>{
  try {
    const m=event.data;
    if(m.type==='render') {
      const start=performance.now();
      if(m.patch)page.patch(m.patch,m.id);
      else {page=TexpressoSvgPage.create(new TextDecoder().decode(m.bytes),m.id);if(!page)throw Error('SVG mount rejected');surface.replaceChildren(page.root);}
      const workMs=performance.now()-start;received.push(m);await paint();
      api.postMessage({type:'rendered',index:m.index,workMs,paintMs:performance.now()-start,dpr:devicePixelRatio});
    }else if(m.type==='validate') {
      // Independent full-mount oracle for every step, after all timing samples.
      let replay;
      for(let i=0;i<received.length;i++) {
        const step=received[i],expected=TexpressoSvgPage.create(m.frames[i],'expected');
        if(step.patch)replay.patch(step.patch,step.id);else replay=TexpressoSvgPage.create(m.frames[i],step.id);
        if(!expected||!replay||normalized(expected)!==normalized(replay))throw Error('DOM mismatch at '+i);
      }
      if(received.some(m=>m.patch?.transforms?.length))assertions();
      api.postMessage({type:'validated',frames:received.length,dpr:devicePixelRatio,hidden,innerWidth});
    }
  }catch(error){api.postMessage({type:'error',error:error.stack||String(error)});}
});
if(innerWidth+1<job.width)api.postMessage({type:'error',error:'Replay viewport clipped'});else api.postMessage({type:'ready'});
