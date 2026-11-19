#!/usr/bin/env node
/* Native export experiment. Bypasses production's 4 MP client restriction,
 * uses the existing 16 MP engine opt-in, and never uploads private documents.
 * Every measured request uses preview-region (even full-page references),
 * avoiding the full-page export cache without rebuilding the native engine. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks'),{inflateSync}=require('node:zlib');
const {prepare,fingerprint}=require('./real-corpus.cjs'),{normalize}=require('./json-number-bridge.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

class Engine {
  constructor(binary,fixture,output) {
    this.fixture=fixture;this.output=output;this.pending=Buffer.alloc(0);this.frames=new Map();this.retries=new Set();
    this.profiles=[];this.trace='';this.profilePending='';this.sequence=1;this.nextId=0;this.normalized=0;
    this.child=cp.spawn(binary,['-texlive','-headless','-watch-parent','-json','-lines','-stream','-preview-max-pixels','16000000','-I',fixture.projectRoot,fixture.file],
      {cwd:fixture.root,detached:true,env:{...process.env,SDL_VIDEODRIVER:'dummy',TEXPRESSO_PROFILE:'1'},stdio:['pipe','pipe','pipe']});
    this.child.on('error',e=>this.failure=e);
    this.child.stdout.on('data',bytes=>{try{this.read(bytes);}catch(e){this.failure=e;}});
    this.child.stderr.on('data',bytes=>{
      const text=bytes.toString();this.trace=(this.trace+text).slice(-40000);this.profilePending+=text;
      const lines=this.profilePending.split('\n');this.profilePending=lines.pop();
      for(const line of lines)if(line.startsWith('[profile] ')){try{this.profiles.push(JSON.parse(line.slice(10)));}catch{}}
    });
    this.send(['register',fixture.file]);this.send(['open',fixture.file,fixture.text]);this.send(['preview-barrier',this.sequence]);this.send(['resume']);
  }
  send(command){this.child.stdin.write(JSON.stringify(command)+'\n');}
  read(bytes) {
    this.pending=Buffer.concat([this.pending,bytes]);
    while(this.pending.length) {
      if(this.header) {
        if(this.pending.length<this.header.byteLength)return;
        const body=Buffer.from(this.pending.subarray(0,this.header.byteLength));this.pending=this.pending.subarray(this.header.byteLength);
        this.frames.set(this.header.requestId,{header:this.header,bytes:body,received:performance.now()});this.header=undefined;continue;
      }
      const end=this.pending.indexOf(10);if(end<0)return;
      const raw=this.pending.subarray(0,end).toString('utf8');this.pending=this.pending.subarray(end+1);
      const line=normalize(raw);if(line!==raw)this.normalized++;
      const message=JSON.parse(line);
      if(message[0]==='preview-image')this.header=message[1];
      else if(message[0]==='preview-state')this.state=message;
      else if(message[0]==='preview-forward')this.forward=message;
      else if(message[0]==='preview-retry')this.retries.add(message[1]);
      else if(message[0]==='preview-error'||message[0]==='engine-error')this.failure=Error(JSON.stringify(message));
    }
  }
  async until(check) {
    const deadline=performance.now()+120000;
    while(!check()) {
      if(this.failure)throw this.failure;
      if(this.child.exitCode!==null||performance.now()>deadline)throw Error('Engine deadline/exit\n'+this.trace.slice(-6000));
      await delay(2);
    }
  }
  async render(page,width,bounds) {
    for(let attempt=0;attempt<30;attempt++) {
      await this.until(()=>this.state?.[2]===this.sequence);
      const id=++this.nextId,start=performance.now();
      this.send(bounds?['preview-region',id,page,width,this.state[1],this.state[2],...bounds]:['preview-render',id,page,width,this.state[1],this.state[2]]);
      await this.until(()=>this.frames.has(id)||this.retries.has(id));
      if(this.retries.has(id))continue;
      const frame=this.frames.get(id);this.frames.delete(id);
      await this.until(()=>this.profiles.some(p=>p.request===id&&p.stage==='pipe-write'));
      return {...frame,roundTripMs:frame.received-start,stages:this.profiles.filter(p=>p.request===id)};
    }
    throw Error('Repeated obsolete render');
  }
  edit() {
    const before=this.fixture.text.slice(0,this.fixture.editOffset),line=before.split('\n').length-1,column=before.length-before.lastIndexOf('\n')-1;
    this.send(['change-range',this.fixture.file,line,column,line,column,' X']);this.send(['preview-barrier',++this.sequence]);
  }
  async sourcePoint() {
    this.forward=undefined;
    const line=this.fixture.text.slice(0,this.fixture.editOffset).split('\n').length;
    this.send(['synctex-forward',this.fixture.file,line]);
    await this.until(()=>this.forward?.[2]===this.sequence);
    return {page:this.forward[3],x:this.forward[4],y:this.forward[5]};
  }
  async close() {
    this.child.stdin.end();
    await Promise.race([new Promise(resolve=>this.child.once('exit',resolve)),delay(3000)]);
    try{process.kill(-this.child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
    fs.writeFileSync(path.join(this.output,this.fixture.id+'-trace.log'),this.trace);
  }
}

function decode(png) {
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const idat=[];let width,height,channels;
  for(let pos=8;pos<png.length;) {
    const n=png.readUInt32BE(pos),kind=png.toString('ascii',pos+4,pos+8),data=png.subarray(pos+8,pos+8+n);pos+=n+12;
    if(kind==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);assert.ok([0,2].includes(data[9]));assert.equal(data[12],0);channels=data[9]===0?1:3;}
    if(kind==='IDAT')idat.push(data);
  }
  const raw=inflateSync(Buffer.concat(idat)),stride=width*channels+1,rgb=Buffer.alloc(width*height*3);
  assert.equal(raw.length,stride*height);
  for(let y=0;y<height;y++) {
    assert.equal(raw[y*stride],0,'Only the native unfiltered writer is supported');
    if(channels===3)raw.copy(rgb,y*width*3,y*stride+1,(y+1)*stride);
    else for(let x=0;x<width;x++)rgb.fill(raw[y*stride+x+1],(y*width+x)*3,(y*width+x+1)*3);
  }
  return {width,height,rgb};
}
function damage(a,b,tileSizes=[256,512,1024]) {
  assert.equal(a.width,b.width);assert.equal(a.height,b.height);
  const tiles=tileSizes.map(size=>({size,changed:new Set(),total:Math.ceil(a.width/size)*Math.ceil(a.height/size)}));
  let changed=0,x0=a.width,y0=a.height,x1=0,y1=0;
  for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++) {
    const p=(y*a.width+x)*3;
    if(a.rgb[p]===b.rgb[p]&&a.rgb[p+1]===b.rgb[p+1]&&a.rgb[p+2]===b.rgb[p+2])continue;
    changed++;x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);
    for(const t of tiles)t.changed.add(Math.floor(y/t.size)*Math.ceil(a.width/t.size)+Math.floor(x/t.size));
  }
  return {changedPixels:changed,totalPixels:a.width*a.height,bounds:changed?[x0,y0,x1,y1]:[0,0,0,0],
    tiles:tiles.map(t=>({size:t.size,changed:t.changed.size,total:t.total}))};
}
function compareCrop(full,crop,x,y) {
  const w=Math.min(crop.width,full.width-x),h=Math.min(crop.height,full.height-y);
  let changed=0,maxChannelDelta=0,sum=0;
  for(let j=0;j<h;j++)for(let i=0;i<w;i++) {
    let different=false;
    for(let c=0;c<3;c++){const d=Math.abs(full.rgb[((y+j)*full.width+x+i)*3+c]-crop.rgb[(j*crop.width+i)*3+c]);if(d)different=true;maxChannelDelta=Math.max(maxChannelDelta,d);sum+=d;}
    if(different)changed++;
  }
  return {comparedPixels:w*h,differentPixels:changed,maxChannelDelta,meanChannelDelta:sum/(w*h*3)};
}
async function main() {
  const [inputs,binaryArg,outputArg]=process.argv.slice(2),binary=path.resolve(binaryArg),output=path.resolve(outputArg);
  fs.mkdirSync(output,{recursive:true});const fixtures=prepare(inputs,output);
  const repeats=Number(process.env.TEXPRESSO_CLIP_REPEATS||6),rows=[],validations=[];
  const metadata={created:new Date().toISOString(),platform:process.platform,architecture:process.arch,
    binarySha256:sha(binary),workerSha256:sha(path.join(path.dirname(binary),'texpresso-xetex')),
    nativeManifest:JSON.parse(fs.readFileSync(path.resolve(path.dirname(binary),'../build-manifest.json'))),
    harnessSha256:sha(__filename),viewportCss:[1000,700],dpr:2,repeats,
    fixtures:fixtures.map(f=>({id:f.id,focusPage:f.focusPage,sourceSha256:f.sourceSha256,originalSha256:f.originalSha256,compatibility:f.compatibility}))};
  fs.writeFileSync(path.join(output,'metadata.json'),JSON.stringify(metadata,null,2));
  for(const fixture of fixtures) {
    const engine=new Engine(binary,fixture,output);
    try {
      const initial=await engine.render(fixture.focusPage,1000),bounds=initial.header.bounds,[l,t,r,b]=bounds,w=r-l,h=b-t;
      const point=await engine.sourcePoint();assert.equal(point.page,fixture.focusPage,'Current SyncTeX must confirm the source edit page');
      const highWidth=Math.min(4000,Math.floor(Math.sqrt(15000000*w/h)));
      const modeDefinitions=[['fit',2000],['zoom',highWidth]];
      for(const [mode,fullWidth] of modeDefinitions) {
        const scale=fullWidth/w,fullHeight=Math.ceil(h*scale),cw=Math.min(fullWidth,2000),ch=Math.min(fullHeight,1400);
        const make=(name,x,y,pw,ph)=>({name,x,y,width:pw,pixelSize:[pw,ph],bounds:[l+x/scale,t+y/scale,l+(x+pw)/scale,t+(y+ph)/scale]});
        const x=Math.max(0,Math.min(fullWidth-cw,Math.floor((point.x-l)*scale-cw/2)));
        // Landscape slide SyncTeX reports the frame anchor rather than its title.
        const y=w>h?0:Math.max(0,Math.min(fullHeight-ch,Math.floor((point.y-t)*scale-ch/3)));
        const plans=[{name:'full-sharp',width:fullWidth,bounds},
          {name:'old-base',width:Math.min(fullWidth,Math.floor(Math.sqrt(4000000*w/h))),bounds},make('viewport',x,y,cw,ch),
          make('center',Math.floor((fullWidth-cw)/2),Math.floor((fullHeight-ch)/2),cw,ch),
          make('top',0,0,cw,ch),make('bottom',fullWidth-cw,fullHeight-ch,cw,ch),
          make('scroll-strip',x+cw-Math.min(128,cw),y,Math.min(128,cw),ch),
          make('tile-512',Math.min(x,fullWidth-512),Math.min(y,fullHeight-512),Math.min(512,fullWidth),Math.min(512,fullHeight))];
        const reference={},hashes=new Map();
        for(let repeat=0;repeat<repeats;repeat++) {
          for(const plan of repeat%2?[...plans].reverse():plans) {
            const frame=await engine.render(fixture.focusPage,plan.width,plan.bounds),pixels=frame.header.width*frame.header.height;
            assert.equal(frame.header.mime,'image/png');assert.ok(frame.stages.some(p=>p.stage==='png-draw'),'Region must rasterize, not hit exported-page cache');
            const digest=crypto.createHash('sha256').update(frame.bytes).digest('hex');
            if(hashes.has(plan.name))assert.equal(digest,hashes.get(plan.name),'Static exports must stay pixel/byte stable');
            else hashes.set(plan.name,digest);
            const row={fixture:fixture.id,mode,repeat,warmup:repeat===0,plan:plan.name,bounds:frame.header.bounds,payloadSha256:digest,
              width:frame.header.width,height:frame.header.height,pixels,rawRgbBytes:pixels*3,pngBytes:frame.bytes.length,
              exportMs:frame.header.exportMs,roundTripMs:frame.roundTripMs,stages:frame.stages};
            rows.push(row);fs.appendFileSync(path.join(output,'runs.jsonl'),JSON.stringify(row)+'\n');
            if(repeat===0&&['full-sharp','viewport'].includes(plan.name))reference[plan.name]={...frame,image:decode(frame.bytes)};
            if(repeat===0&&mode==='fit'&&plan.name==='full-sharp')fs.writeFileSync(path.join(output,fixture.id+'-sample.png'),frame.bytes);
          }
          console.log(`${fixture.id} ${mode} repeat ${repeat} complete`);
        }
        const full=reference['full-sharp'].image,view=reference.viewport.image;
        validations.push({fixture:fixture.id,mode,fullSize:[full.width,full.height],viewportSize:[view.width,view.height],cropComparison:compareCrop(full,view,x,y)});
        if(mode==='zoom') {
          engine.edit();
          const viewPlan=plans.find(p=>p.name==='viewport');
          const fullAfter=await engine.render(fixture.focusPage,fullWidth,bounds),viewportAfter=await engine.render(fixture.focusPage,viewPlan.width,viewPlan.bounds);
          const fullDamage=damage(full,decode(fullAfter.bytes)),viewportDamage=damage(view,decode(viewportAfter.bytes));
          assert.ok(viewportDamage.changedPixels>0,'The sharp crop must include the actual visible edit');
          const oracle=[];
          // Post-hoc oracle only: pixel damage is already known, not predicted.
          for(const size of [256,512,1024]) {
            const [dx0,dy0,dx1,dy1]=fullDamage.bounds;
            const ox=Math.floor(dx0/size)*size,oy=Math.floor(dy0/size)*size;
            const right=Math.min(fullWidth,Math.ceil(dx1/size)*size),bottom=Math.min(fullHeight,Math.ceil(dy1/size)*size);
            const plan=make('oracle',ox,oy,right-ox,bottom-oy),samples=[];
            for(let repeat=0;repeat<repeats;repeat++) {
              const frame=await engine.render(fixture.focusPage,plan.width,plan.bounds);
              samples.push({warmup:repeat===0,width:frame.header.width,height:frame.header.height,pngBytes:frame.bytes.length,
                exportMs:frame.header.exportMs,roundTripMs:frame.roundTripMs,stages:frame.stages});
            }
            oracle.push({gridSize:size,bounds:plan.bounds,samples});
          }
          validations.push({fixture:fixture.id,mode,kind:'prose-edit',fullDamage,viewportDamage,
            oracle,sourcePoint:point,viewportOriginPixels:[x,y],fullExportMs:fullAfter.header.exportMs,viewportExportMs:viewportAfter.header.exportMs});
        }
      }
      assert.equal(fingerprint(fixture.projectRoot).sha256,fixture.projectFingerprint.sha256,'Copied source stays unchanged on disk');
      validations.push({fixture:fixture.id,normalizedLegacyHeaders:engine.normalized,sourceFingerprintUnchanged:true});
    }finally{await engine.close();}
  }
  fs.writeFileSync(path.join(output,'validations.json'),JSON.stringify(validations,null,2));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={decode,damage,compareCrop};
