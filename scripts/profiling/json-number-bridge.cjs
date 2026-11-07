// Measurement-only workaround for native annotation JSON such as -.999.
// This does not alter image bytes. Remove once the shared engine uses JSON
// number formatting rather than MuPDF's compact PDF-number formatting.
'use strict';
const {Transform}=require('node:stream');
function normalize(line) {
  let quoted=false,escaped=false,result='';
  for(let i=0;i<line.length;i++) {
    const c=line[i];
    if(quoted) {result+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;result+=c;continue;}
    if(c==='.'&&/\d/.test(line[i+1]||'')&&!/\d/.test(line[i-1]||''))result+='0';
    result+=c;
  }
  return result;
}
class JsonNumberBridge extends Transform {
  constructor(){super();this.buffer=Buffer.alloc(0);this.remaining=0;this.changed=0;this.headers=0;this.headerMs=0;this.maxHeaderMs=0;}
  _transform(bytes,_encoding,done){
    try{
      this.buffer=Buffer.concat([this.buffer,bytes]);
      while(this.buffer.length){
        if(this.remaining){const n=Math.min(this.remaining,this.buffer.length);this.push(this.buffer.subarray(0,n));this.buffer=this.buffer.subarray(n);this.remaining-=n;continue;}
        const end=this.buffer.indexOf(10);if(end<0){if(this.buffer.length>4*1024*1024)throw Error('Oversized native JSON line');break;}
        const raw=this.buffer.subarray(0,end),line=raw.toString('utf8');this.buffer=this.buffer.subarray(end+1);
        if(line.startsWith('["preview-image",')){
          const start=performance.now();
          const json=normalize(line),message=JSON.parse(json),length=message[1].byteLength;
          if(!Number.isSafeInteger(length)||length<0||length>64*1024*1024)throw Error('Invalid image length');
          const elapsed=performance.now()-start;this.headerMs+=elapsed;this.maxHeaderMs=Math.max(this.maxHeaderMs,elapsed);
          this.headers++;if(json!==line)this.changed++;this.remaining=length;this.push(json+'\n');
        }else{this.push(raw);this.push('\n');}
      }
      done();
    }catch(error){done(error);}
  }
  _flush(done){if(this.remaining||this.buffer.length)done(Error('Truncated native stream'));else done();}
}
module.exports={normalize,JsonNumberBridge};
