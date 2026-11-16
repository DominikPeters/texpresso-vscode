#!/usr/bin/env node
'use strict';
/* Opportunity measurement only. Identical bytecode does NOT establish identical
 * pixels or reusable interpreter state. Output contains hashes/counts/timings,
 * never glyph text, special contents, font names or source paths.
 *
 * node scripts/profiling/xdv-stability.cjs before.xdv after.xdv [--page N]
 * node scripts/profiling/xdv-stability.cjs before.bin after.bin --body [--version 7]
 *
 * Stream snapshots may end before POST; every supplied instruction must still
 * be complete. --body accepts a single page's post-BOP drawing program. */
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function need(bytes,offset,size) {
  if(!Number.isSafeInteger(size)||size<1||offset+size>bytes.length)throw Error(`Truncated or oversized XDV instruction at byte ${offset}`);
  return size;
}
function instructionSize(bytes,offset,version=7) {
  need(bytes,offset,1);const op=bytes[offset],remaining=bytes.length-offset;
  const u16=i=>{need(bytes,offset,i+2);return bytes.readUInt16BE(offset+i);};
  let size;
  if(op<=127 || (op>=171&&op<=234))size=1;
  else if((op>=128&&op<=131)||(op>=133&&op<=136)||(op>=143&&op<=146)||(op>=148&&op<=151)||
          (op>=153&&op<=156)||(op>=157&&op<=160)||(op>=162&&op<=165)||(op>=167&&op<=170)||(op>=235&&op<=238)) {
    const first=op<=131?128:op<=136?133:op<=146?143:op<=151?148:op<=156?153:op<=160?157:op<=165?162:op<=170?167:235;
    size=op-first+2;
  } else if(op===132||op===137)size=9;
  else if([138,140,141,142,147,152,161,166,250,251].includes(op))size=1;
  else if(op===139)size=45;
  else if(op>=239&&op<=242) {
    const n=op-238;need(bytes,offset,1+n);let length=0;
    for(let i=0;i<n;i++)length=length*256+bytes[offset+1+i];
    size=1+n+length;
  } else if(op>=243&&op<=246) {
    const at=14+op-243;need(bytes,offset,at+2);size=at+2+bytes[offset+at]+bytes[offset+at+1];
  } else if(op===247) {need(bytes,offset,15);size=15+bytes[offset+14];}
  else if(op===248)size=29;
  else if(op===249)size=6;
  else if(op===252) {
    if(![5,6,7].includes(version))throw Error(`Native-font opcode in non-XDV version ${version}`);
    need(bytes,offset,12);const flags=u16(9);
    if(flags&~0x7b00)throw Error('Unknown native-font flags');
    size=16+bytes[offset+11];
    for(const flag of [0x0200,0x1000,0x2000,0x4000])if(flags&flag)size+=4;
    if(flags&0x0800) {
      if(version!==5)throw Error('Variation records are only defined for XDV 5');
      size+=2+u16(size)*4;
    }
  } else if(op===253) {
    if(![5,6,7].includes(version))throw Error('Glyph opcode in non-XDV stream');
    size=7+10*u16(5);
  } else if(op===254) {
    if(![5,6,7].includes(version))throw Error('Text-glyph opcode in non-XDV stream');
    const at=3+2*u16(1)+4;size=at+2+10*u16(at);
  } else throw Error(`Unsupported opcode ${op} at byte ${offset}`);
  assert.ok(remaining>=1);return need(bytes,offset,size);
}
function specialKind(bytes,offset,size) {
  const op=bytes[offset];if(op<239||op>242)return undefined;
  const start=offset+op-238+1;
  const text=bytes.subarray(start,Math.min(offset+size,start+64)).toString('utf8').trimStart();
  return text.startsWith('texpresso:figure')?'figure-routing':/^pdf:\s*image\s/.test(text)?'pdf-image':text.startsWith('pdf:')?'pdf':
    text.startsWith('color')?'color':'other';
}
function tokenize(bytes,{body=false,version=7}={}) {
  if(!Buffer.isBuffer(bytes))throw Error('Expected XDV bytes');
  let current=body?{index:0,start:0,tokens:[],complete:false}:undefined;
  const pages=body?[current]:[],all=[];let postamble=false,finished=false;
  if(!body) {
    if(bytes[0]!==247)throw Error('Expected PRE, or use --body for a page program');
    need(bytes,0,2);version=bytes[1];
    if(![2,3,5,6,7].includes(version))throw Error('Unsupported DVI/XDV version');
  }
  for(let offset=0;offset<bytes.length;) {
    if(finished) {
      if(bytes.subarray(offset).some(b=>b!==223))throw Error('Non-padding data after POST_POST');
      break;
    }
    const op=bytes[offset],size=instructionSize(bytes,offset,version);
    if((op===247&&offset!==0)||(body&&[139,247,248,249].includes(op))||(postamble&&op===139))throw Error('Unexpected structural opcode');
    const token={offset,end:offset+size,size,op,key:hash(bytes.subarray(offset,offset+size)),special:specialKind(bytes,offset,size)};
    all.push(token);
    if(op===139) {
      if(body||current)throw Error('Nested BOP or BOP in --body input');
      current={index:pages.length,start:offset+size,tokens:[],complete:false};pages.push(current);
    } else if(op===140) {
      if(!current)throw Error('EOP outside page');
      current.end=offset;current.complete=true;current=undefined;
    } else if(op===248) {
      if(current)throw Error('POST inside page');postamble=true;
    } else if(op===249) {
      if(current||(!body&&!postamble))throw Error('POST_POST before POST');finished=true;
    } else if(current)current.tokens.push(token);
    offset+=size;
  }
  if(current) {current.end=bytes.length;current.complete=body;}
  for(const p of pages) {
    if(p.end===undefined)p.end=bytes.length;
    p.bytes=bytes.subarray(p.start,p.end);p.hash=hash(p.bytes);
  }
  return {version,pages,all,postamble,finished,byteLength:bytes.length,hash:hash(bytes)};
}
function commonEnds(a,b,equal=(a,b)=>a===b) {
  let prefix=0,suffix=0;
  while(prefix<a.length&&prefix<b.length&&equal(a[prefix],b[prefix]))prefix++;
  while(suffix<a.length-prefix&&suffix<b.length-prefix&&equal(a[a.length-1-suffix],b[b.length-1-suffix]))suffix++;
  return {prefix,suffix,oldMiddle:a.length-prefix-suffix,newMiddle:b.length-prefix-suffix};
}
/* Bounded Myers insertion/deletion distance over exact instruction keys.
 * Linear frontier memory; no edit script or source fragments are retained. */
function instructionDiff(a,b,{maxWork=2000000,maxDistance=20000,equal=(a,b)=>a.key===b.key,unit='instructions'}={}) {
  const ends=commonEnds(a,b,equal);
  const left=a.slice(ends.prefix,a.length-ends.suffix),right=b.slice(ends.prefix,b.length-ends.suffix);
  const n=left.length,m=right.length,limit=Math.min(n+m,maxDistance),off=limit+1;
  const v=new Int32Array(limit*2+3);v.fill(-1);v[off+1]=0;let work=0;
  for(let d=0;d<=limit;d++)for(let k=-d;k<=d;k+=2) {
    if(++work>maxWork)return {complete:false,work,distanceLowerBound:d,...ends};
    let x=k===-d||(k!==d&&v[off+k-1]<v[off+k+1])?v[off+k+1]:v[off+k-1]+1,y=x-k;
    while(x<n&&y<m&&equal(left[x],right[y])) {
      x++;y++;if(++work>maxWork)return {complete:false,work,distanceLowerBound:d,...ends};
    }
    v[off+k]=x;
    if(x>=n&&y>=m)return {complete:true,work,distance:d,[unit==='bytes'?'matchedBytes':'matchedInstructions']:(a.length+b.length-d)/2,...ends};
  }
  return {complete:false,work,distanceLowerBound:limit+1,...ends};
}
/* Merkle structure avoids rehashing the bytes of every ancestor for deeply
 * nested PUSH/POP groups. Equality is syntactic, NOT state independence. */
function blocks(tokens) {
  const result=[],stack=[];let unmatchedPops=0;
  for(const token of tokens) {
    if(token.op===141)stack.push({start:token.offset,depth:stack.length,hash:crypto.createHash('sha256').update('P'),instructions:1});
    else if(token.op===142) {
      if(!stack.length){unmatchedPops++;continue;}
      const block=stack.pop();block.hash.update('O');block.key=block.hash.digest('hex');delete block.hash;
      block.end=token.end;block.instructions++;result.push(block);
      if(stack.length){stack.at(-1).hash.update('B'+block.key);stack.at(-1).instructions+=block.instructions;}
    } else if(stack.length) {stack.at(-1).hash.update('T'+token.key);stack.at(-1).instructions++;}
  }
  return {blocks:result,unclosed:stack.length,unmatchedPops};
}
function intervalCoverage(intervals) {
  intervals.sort((a,b)=>a[0]-b[0]);let total=0,end=-1;
  for(const [lo,hi]of intervals){total+=Math.max(0,hi-Math.max(lo,end));end=Math.max(end,hi);}
  return total;
}
function matchBlocks(oldTokens,newTokens) {
  const old=blocks(oldTokens),next=blocks(newTokens),known=new Set(old.blocks.map(b=>b.key));
  const matched=next.blocks.filter(b=>known.has(b.key));
  const coverage=intervalCoverage(matched.map(b=>[b.start,b.end]));
  return {oldBlocks:old.blocks.length,newBlocks:next.blocks.length,matchedNewBlocks:matched.length,
    matchedNewByteCoverage:coverage,largestMatchedBytes:matched.reduce((n,b)=>Math.max(n,b.end-b.start),0),
    oldUnclosed:old.unclosed,newUnclosed:next.unclosed,oldUnmatchedPops:old.unmatchedPops,newUnmatchedPops:next.unmatchedPops};
}
function compare(oldBytes,newBytes,options={}) {
  const started=performance.now(),old=tokenize(oldBytes,options),next=tokenize(newBytes,options),parsedAt=performance.now();
  const rawByteDiff=instructionDiff(oldBytes,newBytes,{...options,equal:(a,b)=>a===b,unit:'bytes'}),rawDiffAt=performance.now();
  const indices=options.page===undefined?[...new Set([...old.pages,...next.pages].map(p=>p.index))]:[options.page];
  const pages=indices.map(index=>{
    const a=old.pages[index],b=next.pages[index];
    if(!a||!b)return {page:index,added:!a,removed:!b};
    const begin=performance.now(),diff=instructionDiff(a.tokens,b.tokens,options),diffAt=performance.now(),blockMatch=matchBlocks(a.tokens,b.tokens),blockAt=performance.now();
    const specials={};
    for(const category of ['pdf-image','pdf','figure-routing','color','other']) {
      const before=a.tokens.filter(t=>t.special===category),after=b.tokens.filter(t=>t.special===category),known=new Set(before.map(t=>t.key));
      specials[category]={old:before.length,new:after.length,matchedNew:after.filter(t=>known.has(t.key)).length,
        matchedNewBytes:after.filter(t=>known.has(t.key)).reduce((n,t)=>n+t.size,0)};
    }
    return {page:index,oldComplete:a.complete,newComplete:b.complete,oldBytes:a.bytes.length,newBytes:b.bytes.length,
      oldSha256:a.hash,newSha256:b.hash,rawByteEnds:commonEnds(a.bytes,b.bytes),oldInstructions:a.tokens.length,newInstructions:b.tokens.length,
      instructionDiff:diff,balancedBlocks:blockMatch,specials,
      timingsMs:{instructionDiff:diffAt-begin,balancedBlocks:blockAt-diffAt}};
  });
  return {schema:1,kind:'syntactic-opportunity-only',warning:'Bytecode matches do not validate incoming interpreter state, resource identity or pixel reuse.',
    old:{sha256:old.hash,bytes:old.byteLength,version:old.version,pages:old.pages.length,finished:old.finished},
    new:{sha256:next.hash,bytes:next.byteLength,version:next.version,pages:next.pages.length,finished:next.finished},
    rawByteEnds:commonEnds(oldBytes,newBytes),rawByteDiff,pages,timingsMs:{parseAndHash:parsedAt-started,rawByteDiff:rawDiffAt-parsedAt,total:performance.now()-started}};
}
if(require.main===module) {
  const args=process.argv.slice(2),before=args.shift(),after=args.shift(),options={};
  if(!before||!after)throw Error('Usage: xdv-stability.cjs BEFORE AFTER [--body] [--version N] [--page N]');
  while(args.length) {
    const flag=args.shift();
    if(flag==='--body')options.body=true;
    else if(['--version','--page','--max-work','--max-distance'].includes(flag)) {
      const n=Number(args.shift());if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid numeric option');
      options[{'--version':'version','--page':'page','--max-work':'maxWork','--max-distance':'maxDistance'}[flag]]=n;
    }else throw Error('Unknown option '+flag);
  }
  console.log(JSON.stringify(compare(fs.readFileSync(before),fs.readFileSync(after),options),null,2));
}
module.exports={instructionSize,tokenize,commonEnds,instructionDiff,blocks,intervalCoverage,compare};
