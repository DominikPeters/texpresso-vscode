#!/usr/bin/env node
/* Native export cost of display-density surfaces: drawing and encoding a whole
 * page and a zoomed viewport rectangle, and a one-letter edit patched against
 * the retained raster. Compilation and browser presentation are excluded.
 *
 *   node scripts/profiling/surface-export.cjs <texpresso> <file.tex> [anchor] ...
 *
 * `anchor` is text in the document body after which the edit types; it defaults
 * to the start of the body. Requires TeX Live and an engine advertising
 * `surfaces`. Prints one JSON line per document. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {performance}=require('node:perf_hooks');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];

class Engine {
  constructor(binary,file) {
    this.file=file;this.text=fs.readFileSync(file,'utf8');this.pending=Buffer.alloc(0);this.frames=new Map();this.retries=new Set();
    this.errors=new Map();this.profiles=[];this.trace='';this.partial='';this.sequence=1;this.nextId=0;
    this.child=cp.spawn(binary,['-texlive','-headless','-json','-lines','-stream','-preview-max-pixels','16000000',file],
      {cwd:path.dirname(file),env:{...process.env,SDL_VIDEODRIVER:'dummy',TEXPRESSO_PROFILE:'1'},stdio:['pipe','pipe','pipe']});
    this.child.on('error',error=>this.failure=error);
    this.child.stdout.on('data',bytes=>{try{this.read(bytes);}catch(error){this.failure=error;}});
    this.child.stderr.on('data',bytes=>{
      const text=bytes.toString();this.trace=(this.trace+text).slice(-20000);this.partial+=text;
      const lines=this.partial.split('\n');this.partial=lines.pop();
      for(const line of lines)if(line.startsWith('[profile] ')){try{this.profiles.push(JSON.parse(line.slice(10)));}catch{}}
    });
    this.send(['register',file]);this.send(['open',file,this.text]);this.send(['preview-barrier',this.sequence]);this.send(['resume']);
  }
  send(command){this.child.stdin.write(JSON.stringify(command)+'\n');}
  read(bytes) {
    this.pending=Buffer.concat([this.pending,bytes]);
    while(this.pending.length) {
      if(this.header) {
        if(this.pending.length<this.header.byteLength)return;
        const body=Buffer.from(this.pending.subarray(0,this.header.byteLength));this.pending=this.pending.subarray(this.header.byteLength);
        this.frames.set(this.header.requestId,{header:this.header,bytes:body});this.header=undefined;continue;
      }
      const end=this.pending.indexOf(10);if(end<0)return;
      const raw=this.pending.subarray(0,end).toString('utf8');this.pending=this.pending.subarray(end+1);
      let message;try{message=JSON.parse(raw);}catch{continue;}
      if(message[0]==='preview-image') {
        if(message[1].byteLength)this.header=message[1];
        else this.frames.set(message[1].requestId,{header:message[1],bytes:Buffer.alloc(0)});
      } else if(message[0]==='preview-state')this.state=message;
      else if(message[0]==='preview-retry'||message[0]==='preview-cancelled')this.retries.add(message[1]);
      else if(message[0]==='preview-error')this.errors.set(message[1],message[2]);
    }
  }
  async until(check) {
    const deadline=performance.now()+120000;
    while(!check()) {
      if(this.failure)throw this.failure;
      if(this.child.exitCode!==null||performance.now()>deadline)throw Error('Engine deadline/exit\n'+this.trace.slice(-3000));
      await delay(1);
    }
  }
  async surface(page,grid,clip,base=0) {
    for(let attempt=0;attempt<50;attempt++) {
      await this.until(()=>this.state?.[2]===this.sequence);
      const id=++this.nextId;
      this.send(['preview-surface',id,page,grid,this.state[1],this.state[2],...clip,0,0,base,0]);
      await this.until(()=>this.frames.has(id)||this.retries.has(id)||this.errors.has(id));
      if(this.errors.has(id))throw Error('preview-error '+this.errors.get(id));
      if(this.retries.has(id)){await delay(5);continue;}
      const frame=this.frames.get(id);this.frames.delete(id);
      await this.until(()=>this.profiles.some(p=>p.request===id&&p.stage==='pipe-write'));
      return {...frame,stages:Object.fromEntries(this.profiles.filter(p=>p.request===id).map(p=>[p.stage,p.ms]))};
    }
    throw Error('Repeated obsolete render');
  }
  type(offset,text) {
    const before=this.text.slice(0,offset),line=before.split('\n').length-1,column=before.length-before.lastIndexOf('\n')-1;
    this.send(['change-range',this.file,line,column,line,column,text]);
    this.text=this.text.slice(0,offset)+text+this.text.slice(offset);this.send(['preview-barrier',++this.sequence]);
  }
  async close() {
    this.child.stdin.end();
    await Promise.race([new Promise(resolve=>this.child.once('exit',resolve)),delay(2000)]);
    try{this.child.kill('SIGTERM');}catch{}
  }
}

async function measure(binary,file,anchor) {
  const engine=new Engine(binary,path.resolve(file));
  try {
    const at=()=>anchor?engine.text.indexOf(anchor)+anchor.length:engine.text.indexOf('\\begin{document}')+'\\begin{document}\n\n'.length;
    if(at()<(anchor?anchor.length:0))throw Error(`Anchor not found in ${file}`);
    const row={document:path.basename(file)};
    // The export cache answers a repeated identical request; an edit between
    // samples makes every one a real draw, as it is while typing.
    for(const [name,grid,clip] of [['whole2000',2000,[0,0,2000,8192]],['view3404',3404,[0,1024,2048,2560]]]) {
      const draw=[],encode=[];let header;
      for(let i=0;i<7;i++) {
        engine.type(at(),'x');
        const frame=await engine.surface(0,grid,clip);header=frame.header;
        if(i){draw.push(frame.stages['png-draw']);encode.push(frame.stages['png-encode']);}
      }
      row[name]={pixels:[header.width,header.height],drawMs:median(draw),encodeMs:median(encode)};
    }
    const clip=[0,1024,2048,2560];let base=(await engine.surface(0,3404,clip)).header.rasterId;
    const total=[],bytes=[],patches=[];
    for(let i=0;i<9;i++) {
      engine.type(at(),'x');
      const frame=await engine.surface(0,3404,clip,base);base=frame.header.rasterId;
      total.push(frame.header.exportMs);bytes.push(frame.bytes.length);patches.push(frame.header.patch?frame.header.patch.rect.slice(2):null);
    }
    row.edit={exportMs:median(total),bytes:median(bytes),patched:patches.filter(Boolean).length,of:patches.length};
    return row;
  } finally { await engine.close(); }
}

(async()=>{
  const [binary,...rest]=process.argv.slice(2);
  if(!binary||!rest.length){console.error('usage: surface-export.cjs <texpresso> <file.tex> [anchor] ...');process.exit(2);}
  for(let i=0;i<rest.length;i++) {
    const file=rest[i],anchor=rest[i+1]&&!rest[i+1].endsWith('.tex')?rest[++i]:undefined;
    console.log(JSON.stringify(await measure(path.resolve(binary),file,anchor)));
  }
})().catch(error=>{console.error(error);process.exit(1);});
