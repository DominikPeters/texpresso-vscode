'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {deflateSync}=require('node:zlib');
const {decode,damage,compareCrop}=require('./clipped-raster.cjs');

// Synthetic chunks exercise the analysis reader; CRC validation belongs to the
// native writer/browser, not this measurement-only decoder.
function png(type,pixels) {
  const chunk=(name,data)=>{
    const out=Buffer.alloc(data.length+12);
    out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);return out;
  };
  const header=Buffer.alloc(13);
  header.writeUInt32BE(2);header.writeUInt32BE(1,4);header[8]=8;header[9]=type;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.from([0,...pixels]))),chunk('IEND',Buffer.alloc(0))]);
}
test('native grayscale and RGB samples decode to the same RGB pixels',()=>{
  assert.deepEqual(decode(png(0,[12,240])),decode(png(2,[12,12,12,240,240,240])));
});
test('damage counts pixels once and respects tile boundaries and half-open bounds',()=>{
  const a={width:5,height:3,rgb:Buffer.alloc(45)},b={...a,rgb:Buffer.alloc(45)};
  b.rgb[(1*5+1)*3]=1;b.rgb[(2*5+2)*3+1]=2;
  assert.deepEqual(damage(a,b,[2]),{changedPixels:2,totalPixels:15,bounds:[1,1,3,3],
    tiles:[{size:2,changed:2,total:6}]});
  assert.deepEqual(damage(a,a,[2]).bounds,[0,0,0,0]);
});
test('crop comparison uses both the crop stride and full-page origin',()=>{
  const full={width:3,height:2,rgb:Buffer.from(Array.from({length:18},(_,i)=>i))};
  const crop={width:2,height:1,rgb:Buffer.from(full.rgb.subarray(12,18))};
  assert.equal(compareCrop(full,crop,1,1).differentPixels,0);
  crop.rgb[4]+=3;
  assert.deepEqual(compareCrop(full,crop,1,1),{comparedPixels:2,differentPixels:1,
    maxChannelDelta:3,meanChannelDelta:0.5});
});
