'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {instructionSize,tokenize,instructionDiff,blocks,intervalCoverage,compare}=require('./xdv-stability.cjs');
const body=bytes=>Buffer.from(bytes);
function file(program,{complete=true}={}) {
  const pre=Buffer.alloc(15);pre[0]=247;pre[1]=7;
  const bop=Buffer.alloc(45);bop[0]=139;
  if(!complete)return Buffer.concat([pre,bop,program]);
  const post=Buffer.alloc(29);post[0]=248;
  return Buffer.concat([pre,bop,program,Buffer.from([140]),post,Buffer.from([249,0,0,0,0,7,223,223,223,223])]);
}
test('parses complete and streamed XDV without including BOP/postamble in drawing bodies',()=>{
  const program=body([141,143,7,65,142]);
  for(const complete of [true,false]) {
    const x=tokenize(file(program,{complete}));
    assert.equal(x.version,7);assert.equal(x.finished,complete);assert.equal(x.pages[0].complete,complete);
    assert.ok(x.pages[0].bytes.equals(program));assert.equal(x.pages[0].tokens.length,4);
  }
});
test('native font, glyph and text-glyph instruction sizes follow the engine byte layout',()=>{
  const font=Buffer.alloc(20);font[0]=252;font.writeUInt16BE(0x0200,9);
  assert.equal(instructionSize(font,0,7),20);
  const variation=Buffer.alloc(26);variation[0]=252;variation.writeUInt16BE(0x0800,9);variation.writeUInt16BE(2,16);
  assert.equal(instructionSize(variation,0,5),26);assert.throws(()=>instructionSize(variation,0,7));
  const glyph=Buffer.alloc(27);glyph[0]=253;glyph.writeUInt16BE(2,5);
  assert.equal(instructionSize(glyph,0),27);assert.throws(()=>instructionSize(glyph.subarray(0,26),0));
  const text=Buffer.alloc(35);text[0]=254;text.writeUInt16BE(3,1);text.writeUInt16BE(2,13);
  assert.equal(instructionSize(text,0),35);
});
test('rejects malformed lengths, unknown opcodes and structural confusion',()=>{
  assert.throws(()=>tokenize(body([239,10,1]),{body:true}),/Truncated/);
  assert.throws(()=>tokenize(body([255]),{body:true}),/Unsupported/);
  assert.throws(()=>tokenize(body([139,...Buffer.alloc(44)]),{body:true}),/structural/);
  assert.throws(()=>tokenize(file(body([247,...Buffer.alloc(14)]))),/structural/);
  const a=file(body([65]));a[a.length-1]=0;assert.throws(()=>tokenize(a),/padding/);
});
test('bounded instruction diff measures insertion/deletion distance with repeated tokens',()=>{
  const tokens=a=>a.map(key=>({key}));
  const result=instructionDiff(tokens(['a','b','a','c']),tokens(['a','x','b','a','d']));
  assert.equal(result.complete,true);assert.equal(result.distance,3);assert.equal(result.matchedInstructions,3);
  assert.equal(instructionDiff([],[]).distance,0);
  const raw=instructionDiff(Buffer.from([1,2,1,3]),Buffer.from([1,9,2,1,4]),{equal:(a,b)=>a===b,unit:'bytes'});
  assert.equal(raw.distance,3);assert.equal(raw.matchedBytes,3);
  assert.equal(instructionDiff(tokens(['a']),tokens(['b']),{maxWork:1}).complete,false);
});
test('bounded Myers agrees with a simple LCS oracle on repeated short sequences',()=>{
  let seed=71;
  const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  for(let trial=0;trial<100;trial++) {
    const a=Array.from({length:next()%9},()=>String(next()%4));
    const b=Array.from({length:next()%9},()=>String(next()%4));
    const table=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
    for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)
      table[i][j]=a[i-1]===b[j-1]?table[i-1][j-1]+1:Math.max(table[i-1][j],table[i][j-1]);
    const result=instructionDiff(a.map(key=>({key})),b.map(key=>({key})));
    assert.equal(result.complete,true);assert.equal(result.distance,a.length+b.length-2*table[a.length][b.length]);
  }
});

test('nested Merkle blocks find unchanged subtrees without double-counting covered bytes',()=>{
  const before=tokenize(body([141,65,141,66,142,67,142]),{body:true}).pages[0].tokens;
  const after=tokenize(body([141,90,141,66,142,67,142]),{body:true}).pages[0].tokens;
  assert.equal(blocks(before).blocks.length,2);
  const report=compare(body([141,65,141,66,142,67,142]),body([141,90,141,66,142,67,142]),{body:true});
  assert.equal(report.pages[0].balancedBlocks.matchedNewBlocks,1);
  assert.equal(report.pages[0].balancedBlocks.matchedNewByteCoverage,3);
  assert.equal(intervalCoverage([[0,10],[2,4],[9,12],[20,21]]),13);
  assert.equal(blocks(after).unclosed,0);
});
test('summary contains no special payload, font name, or glyph text',()=>{
  const payload=Buffer.from('pdf:SECRET private manuscript filename');
  const special=Buffer.concat([Buffer.from([239,payload.length]),payload]);
  const report=compare(special,special,{body:true});
  assert.equal(report.pages[0].specials.pdf.matchedNew,1);
  assert.ok(!JSON.stringify(report).includes('SECRET'));
  assert.ok(!JSON.stringify(report).includes('private manuscript'));
  const image=Buffer.from('pdf: image width 100 (SECRET.pdf)');
  const imageReport=compare(Buffer.concat([Buffer.from([239,image.length]),image]),Buffer.concat([Buffer.from([239,image.length]),image]),{body:true});
  assert.equal(imageReport.pages[0].specials['pdf-image'].matchedNew,1);
  assert.equal(imageReport.pages[0].specials.pdf.new,0);
  assert.ok(!JSON.stringify(imageReport).includes('SECRET.pdf'));
});
