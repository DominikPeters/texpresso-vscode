#!/usr/bin/env node
/* Native-only PNG density/compressor comparison. Uses local TeX Live; no downloads.
 * npm run compile-tests
 * TEXPRESSO_PROFILE_VARIANTS='[{"name":"system","binary":"/abs/system/bin/texpresso"},{"name":"ng","binary":"/abs/ng/bin/texpresso"}]' \
 *   node scripts/profiling/png-density.cjs --output artifacts/png-density
 * Optional: --kinds dense,tikz,mixed --widths 1600,2240,3200 --budgets 4000000,16000000
 *           --samples 7 --sample-memory 1 --keep-frames 1
 * The seven nearby widths are independent export-cache keys, not seven repetitions
 * at identical pixel dimensions. PNG decoding/hashing occurs after all timed trials.
 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),{performance}=require('node:perf_hooks'),{inflateSync}=require('node:zlib');
const {fixtures,percentile}=require('../profile-preview.cjs');
const repo=path.resolve(__dirname,'../..');
const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1];};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash=file=>fs.existsSync(file)?hash(fs.readFileSync(file)):null;
const active=new Set();

class Native {
  constructor(binary,fixture,budget,sampler) {
    this.binary=binary;this.fixture=fixture;this.budget=budget;this.waiters=new Set();this.frames=new Map();this.retries=new Set();
    this.profile=[];this.memory=[];this.messages=[];this.nextId=0;this.tail='';this.stderrPending='';this.lineParts=[];this.lineBytes=0;
    const args=['-texlive','-headless','-json','-lines','-stream'];
    // The default case deliberately does not opt into the larger area/body limits.
    if(budget!==4000000)args.push('-preview-max-pixels',String(budget));
    args.push(fixture.file);this.args=args;
    this.child=cp.spawn(binary,args,{cwd:fixture.root,detached:true,stdio:['pipe','pipe','pipe'],
      env:{...process.env,SDL_VIDEODRIVER:'dummy',TEXPRESSO_PROFILE:'1',TEXPRESSO_PROFILE_ACTIVITY:'0'}});
    active.add(this);
    this.child.on('error',error=>this.fail(error));
    this.child.on('close',(code,signal)=>{this.closed=true;this.closeCode=code;this.closeSignal=signal;
      if(!this.stopping)this.fail(Error(`Native exited ${code}/${signal}\n${this.tail}`));this.notify();});
    this.child.stdin.on('error',error=>{if(!this.stopping)this.fail(error);});
    this.child.stdout.on('data',bytes=>{try{this.consume(bytes);}catch(error){this.fail(error);}});
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',text=>{
      this.tail=(this.tail+text).slice(-12000);this.stderrPending+=text;
      const lines=this.stderrPending.split('\n');this.stderrPending=lines.pop();
      for(const line of lines){const index=line.indexOf('[profile] ');if(index>=0){try{this.profile.push(JSON.parse(line.slice(index+10)));}catch{}}}
      this.notify();
    });
    if(sampler&&this.child.pid){
      this.sampler=cp.spawn(sampler,[String(this.child.pid)]);let pending='';
      this.sampler.stdout.setEncoding('utf8');this.sampler.stdout.on('data',text=>{pending+=text;const lines=pending.split('\n');pending=lines.pop();
        for(const line of lines){try{this.memory.push(JSON.parse(line));}catch{}}});this.sampler.stderr.resume();
    }
  }
  fail(error){this.failure=error;this.notify();}
  notify(){for(const waiter of [...this.waiters])waiter();}
  until(check,label,timeout=60000){return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.waiters.delete(waiter);reject(Error(label+' timed out\n'+this.tail));},timeout);
    const waiter=()=>{if(this.failure||check()){clearTimeout(timer);this.waiters.delete(waiter);this.failure?reject(this.failure):resolve();}};
    this.waiters.add(waiter);waiter();
  });}
  send(command){this.child.stdin.write(JSON.stringify(command)+'\n');}
  message(message){
    this.messages.push(message);if(this.messages.length>200)this.messages.shift();
    if(message[0]==='preview-state')this.state=message;
    else if(message[0]==='preview-retry')this.retries.add(message[1]);
    else if(message[0]==='preview-error'||message[0]==='engine-error')this.fail(Error(JSON.stringify(message)+'\n'+this.tail));
    this.notify();
  }
  consume(bytes){
    // A body is collected from zero-copy chunk slices and concatenated once.
    // Never search binary PNG data for newline or grow a body with repeated copies.
    let offset=0;
    while(offset<bytes.length){
      if(this.body){
        const size=Math.min(this.body.remaining,bytes.length-offset);this.body.chunks.push(bytes.subarray(offset,offset+size));
        this.body.remaining-=size;offset+=size;
        if(!this.body.remaining){const {header,chunks}=this.body;this.body=undefined;
          this.frames.set(header.requestId,{header,bytes:Buffer.concat(chunks,header.byteLength),receivedAt:performance.now()});this.notify();}
        continue;
      }
      const end=bytes.indexOf(10,offset),stop=end<0?bytes.length:end;
      this.lineParts.push(bytes.subarray(offset,stop));this.lineBytes+=stop-offset;
      if(this.lineBytes>1024*1024)throw Error('Oversized native JSON line');
      offset=stop+(end<0?0:1);if(end<0)break;
      const line=Buffer.concat(this.lineParts,this.lineBytes).toString('utf8');this.lineParts=[];this.lineBytes=0;
      if(!line.trim())continue;const message=JSON.parse(line);
      if(message[0]==='preview-image'){
        const header=message[1];assert.equal(header.mime,'image/png');assert.ok(Number.isSafeInteger(header.byteLength)&&header.byteLength>8&&header.byteLength<=64*1024*1024);
        assert.ok(Number.isInteger(header.width)&&Number.isInteger(header.height)&&header.width>0&&header.height>0&&header.width<=8192&&header.height<=8192);
        assert.ok(header.width*header.height<=this.budget);assert.equal(header.patch,undefined,'full-frame command must not return a dirty patch');
        this.body={header,remaining:header.byteLength,chunks:[]};
      }else this.message(message);
    }
  }
  async start(){
    this.send(['open',this.fixture.file,this.fixture.text]);this.send(['preview-barrier',1]);this.send(['resume']);
    await this.until(()=>this.state&&this.state[2]===1,'initial source barrier');
  }
  async render(width){
    for(let attempt=0;attempt<12;attempt++){
      await this.until(()=>this.state&&this.state[2]===1,'current source state');
      const request=++this.nextId,start=performance.now();this.send(['preview-render',request,0,width,this.state[1],this.state[2]]);
      await this.until(()=>this.frames.has(request)||this.retries.has(request),'PNG export');
      if(!this.frames.has(request))continue;
      const frame=this.frames.get(request);this.frames.delete(request);
      const elapsedMs=frame.receivedAt-start;
      await this.until(()=>this.profile.some(p=>p.stage==='pipe-write'&&p.request===request),'request profile records',5000);
      return {...frame,elapsedMs,requestedWidth:width,stages:this.profile.filter(p=>p.request===request)};
    }
    throw Error('Too many obsolete native render requests');
  }
  async dispose(){
    if(this.disposePromise)return this.disposePromise;
    this.disposePromise=(async()=>{
      this.stopping=true;this.sampler?.kill();this.child.stdin.end();
      const until=Date.now()+5000;while(!this.closed&&Date.now()<until)await delay(10);
      if(!this.closed){try{process.kill(-this.child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
        await new Promise(resolve=>this.child.once('close',resolve));}
      active.delete(this);
    })();return this.disposePromise;
  }
}

// Restricted validator for this engine's opaque 8-bit gray/RGB unfiltered PNGs.
// Hash canonical RGB scanlines without retaining an additional 3-channel page.
function pixelHash(file){
  const png=fs.readFileSync(file),idat=[];assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  let width,height,channels,ended=false;
  for(let offset=8;offset<png.length;){
    assert.ok(offset+12<=png.length);const n=png.readUInt32BE(offset),tag=png.toString('ascii',offset+4,offset+8);
    assert.ok(n<=png.length-offset-12);const data=png.subarray(offset+8,offset+8+n);
    if(tag==='IHDR'){assert.equal(n,13);width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);
      assert.ok([0,2].includes(data[9]));assert.equal(data[10],0);assert.equal(data[11],0);assert.equal(data[12],0);channels=data[9]===0?1:3;}
    if(tag==='IDAT')idat.push(data);if(tag==='IEND')ended=true;offset+=n+12;
  }
  assert.ok(ended&&channels&&width*height<=16000000);const stride=width*channels+1;
  const raw=inflateSync(Buffer.concat(idat),{maxOutputLength:stride*height});assert.equal(raw.length,stride*height);
  const digest=crypto.createHash('sha256'),rgb=channels===1?Buffer.alloc(width*3):undefined;
  for(let y=0;y<height;y++){
    const start=y*stride;assert.equal(raw[start],0,'expected unfiltered writer scanline');
    if(channels===3)digest.update(raw.subarray(start+1,start+stride));
    else{for(let x=0;x<width;x++)rgb.fill(raw[start+1+x],x*3,x*3+3);digest.update(rgb);}
  }
  return {width,height,channels,rgbSha256:digest.digest('hex')};
}
function summarize(rows){
  const groups=[];
  for(const variant of new Set(rows.map(r=>r.variant)))for(const fixture of new Set(rows.map(r=>r.fixture)))
    for(const budget of new Set(rows.map(r=>r.budget)))for(const targetWidth of new Set(rows.map(r=>r.targetWidth))){
      const selected=rows.filter(r=>r.variant===variant&&r.fixture===fixture&&r.budget===budget&&r.targetWidth===targetWidth);if(!selected.length)continue;
      const q=field=>({p50:percentile(selected.map(r=>r[field]),.5),p95:percentile(selected.map(r=>r[field]),.95)});
      groups.push({variant,fixture,budget,targetWidth,samples:selected.length,actualDimensions:[...new Set(selected.map(r=>r.width+'x'+r.height))],
        exportMs:q('exportMs'),elapsedMs:q('elapsedMs'),bytes:q('bytes'),encodeMs:q('encodeMs'),drawMs:q('drawMs')});
    }
  return groups;
}
async function main(){
  if(process.argv.includes('--help')){console.log('Native PNG density benchmark. Set TEXPRESSO_PROFILE_VARIANTS JSON [{name,binary}], then --output NEW_DIR [--kinds dense,tikz,mixed] [--widths 1600,2240,3200] [--budgets 4000000,16000000] [--samples 7] [--sample-memory 1] [--keep-frames 1]');return;}
  const output=path.resolve(arg('output')||'artifacts/profile-png-density');if(fs.existsSync(output)&&fs.readdirSync(output).length)throw Error('Choose a fresh output directory');
  fs.mkdirSync(output,{recursive:true});fs.mkdirSync(path.join(output,'frames'),{recursive:true});
  const variants=JSON.parse(process.env.TEXPRESSO_PROFILE_VARIANTS||JSON.stringify([{name:'default',binary:process.env.TEXPRESSO_BINARY}]));
  assert.ok(Array.isArray(variants)&&variants.length);assert.equal(new Set(variants.map(v=>v.name)).size,variants.length);
  for(const variant of variants){assert.match(variant.name,/^[a-zA-Z0-9_-]+$/);assert.ok(path.isAbsolute(variant.binary)&&fs.existsSync(variant.binary));
    variant.sha256=fileHash(variant.binary);variant.workerSha256=fileHash(path.join(path.dirname(variant.binary),'texpresso-xetex'));
    variant.capabilities=JSON.parse(cp.execFileSync(variant.binary,['-capabilities'],{encoding:'utf8',timeout:10000}));}
  const list=fixtures(output,[1],(arg('kinds')||'dense,tikz,mixed').split(','));
  const widths=(arg('widths')||'1600,2240,3200').split(',').map(Number),budgets=(arg('budgets')||'4000000,16000000').split(',').map(Number),samples=Number(arg('samples')||7);
  assert.ok(Number.isInteger(samples)&&samples>=1&&samples<=32);assert.ok(widths.every(w=>Number.isInteger(w)&&w>=2&&w+samples<=4096));
  assert.ok(budgets.every(b=>Number.isInteger(b)&&b>=1&&b<=16000000));
  for(const variant of variants)assert.ok(budgets.every(b=>b<=4000000||variant.capabilities.maxPreviewPixels>=b),'engine cannot opt into requested density');
  let sampler;
  if(arg('sample-memory')==='1'&&process.platform==='darwin'){
    sampler=path.join(output,'memory-sampler');cp.execFileSync('xcrun',['clang','-O2',path.join(__dirname,'memory.c'),'-o',sampler]);
  }
  const metadata={created:new Date().toISOString(),variants,widths,budgets,samples,platform:process.platform,arch:process.arch,node:process.version,
    scriptSha256:fileHash(__filename),fixtureGeneratorSha256:fileHash(path.join(repo,'scripts/profile-preview.cjs')),
    fixtures:list.map(f=>({id:f.id,sourceSha256:hash(f.text),assets:fs.readdirSync(f.root).map(name=>({name,sha256:fileHash(path.join(f.root,name))}))})),
    power:process.platform==='darwin'?cp.execFileSync('pmset',['-g','batt'],{encoding:'utf8'}):null,
    method:'Native-only full PNGs after one unmeasured warm-up at width target-1. Measured widths target through target+samples-1 avoid encoded cache hits. Native exportMs excludes pipe delivery; elapsedMs ends when the full frame is received. Pixel hashing runs only after timed exports. No VSCode/browser cost or edit/patch work.',
    memoryAccounting:'Optional 50ms native process-group sampled footprints include shared/COW pages and are not deduplicated RAM.'};
  fs.writeFileSync(path.join(output,'metadata.json'),JSON.stringify(metadata,null,2));
  const rows=[],jobs=[];let jobIndex=0;
  for(const fixture of list)for(const budget of budgets)for(const targetWidth of widths){
    const variantOrder=[...variants.slice(jobIndex%variants.length),...variants.slice(0,jobIndex%variants.length)];jobIndex++;
    for(const variant of variantOrder){
      fs.writeFileSync(fixture.file,fixture.text);const native=new Native(variant.binary,fixture,budget,sampler);
      const job={variant:variant.name,fixture:fixture.id,budget,targetWidth,args:native.args};
      try{
        await native.start();const warmup=await native.render(targetWidth-1);job.warmup={elapsedMs:warmup.elapsedMs,header:warmup.header};
        for(let sample=0;sample<samples;sample++){
          const frame=await native.render(targetWidth+sample);assert.ok(!frame.stages.some(p=>p.stage==='page-export-cache-hit'),'nearby-width trial hit encoded cache');
          const encode=frame.stages.find(p=>p.stage==='png-encode'),draw=frame.stages.find(p=>p.stage==='png-draw');assert.ok(encode&&draw,'missing actual PNG export stages');
          const png=path.join(output,'frames',`${variant.name}-${fixture.id}-${budget}-${targetWidth}-${sample}.png`);fs.writeFileSync(png,frame.bytes);
          const row={variant:variant.name,fixture:fixture.id,budget,targetWidth,sample,request:frame.header.requestId,requestedWidth:frame.requestedWidth,
            width:frame.header.width,height:frame.header.height,pixels:frame.header.width*frame.header.height,exportMs:frame.header.exportMs,
            elapsedMs:frame.elapsedMs,bytes:frame.bytes.length,encodeMs:encode.ms,drawMs:draw.ms,stages:frame.stages,
            png:path.relative(output,png),encodedSha256:hash(frame.bytes)};
          rows.push(row);fs.appendFileSync(path.join(output,'rows.jsonl'),JSON.stringify(row)+'\n');
        }
        job.memory=native.memory;job.profile=native.profile;jobs.push(job);
        console.log(`${variant.name} ${fixture.id} ${budget/1e6}MP width ${targetWidth}: export ${percentile(rows.filter(r=>r.variant===variant.name&&r.fixture===fixture.id&&r.budget===budget&&r.targetWidth===targetWidth).map(r=>r.exportMs),.5).toFixed(2)}ms`);
      }finally{fs.writeFileSync(path.join(output,`${variant.name}-${fixture.id}-${budget}-${targetWidth}.log`),native.tail);await native.dispose();}
    }
  }
  // Validate each pixel after measurement to keep inflate/hash CPU out of trials.
  const equal=new Map();let comparisons=0;
  for(const row of rows){const file=path.join(output,row.png),pixels=pixelHash(file);assert.equal(pixels.width,row.width);assert.equal(pixels.height,row.height);Object.assign(row,pixels);
    const key=`${row.fixture}/${row.requestedWidth}/${row.width}/${row.height}`,previous=equal.get(key);
    if(previous){assert.equal(row.rgbSha256,previous.rgbSha256,`lossless mismatch ${key}: ${previous.variant} / ${row.variant}`);comparisons++;}else equal.set(key,row);
    if(arg('keep-frames')!=='1')fs.unlinkSync(file);
  }
  const result={metadata,rows,jobs,summary:summarize(rows),validation:{decodedFrames:rows.length,exactRgbComparisons:comparisons,allExact:true,framesRetained:arg('keep-frames')==='1'}};
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));
  console.log(`PASS: decoded ${rows.length} PNGs, ${comparisons} exact matching RGB comparisons. Results: ${output}`);
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await Promise.allSettled([...active].map(run=>run.dispose()));process.exit(130);});
module.exports={Native,pixelHash,summarize};
if(require.main===module)main().catch(async error=>{console.error(error);await Promise.allSettled([...active].map(run=>run.dispose()));process.exitCode=1;});
