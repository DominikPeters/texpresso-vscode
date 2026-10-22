#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), {inflateSync} = require('node:zlib');

// Deliberately restricted to the opaque, unfiltered 8-bit PNGs written by the
// baseline MuPDF writer and this preview writer. This is not a general decoder.
function pixels(file) {
  const png = fs.readFileSync(file);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8, width, height, channels;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      assert.ok(data[9] === 0 || data[9] === 2);
      channels = data[9] === 0 ? 1 : 3;
      assert.equal(data[12], 0);
    }
    if (type === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels + 1, rgb = Buffer.alloc(width * height * 3);
  assert.equal(raw.length, stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, 'expected unfiltered PNG scanline');
    for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) rgb[(y * width + x) * 3 + c] = raw[y * stride + 1 + x * channels + (channels === 1 ? 0 : c)];
  }
  return {
    width,
    height,
    rgb
  };
}

const before = path.resolve(process.argv[2]), after = path.resolve(process.argv[3]);

const kinds = process.argv[4]?.split(',') || [ 'sparse', 'dense', 'packed', 'tikz' ];

for (const kind of kinds) {
  const name = kind + '-1', a = pixels(path.join(before, name + '.png')), b = pixels(path.join(after, name + '.png'));
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  assert.deepEqual(a.rgb, b.rgb, name + ' must preserve every RGB pixel');
  assert.deepEqual(fs.readFileSync(path.join(before, name + '.svg')), fs.readFileSync(path.join(after, name + '.svg')), name + ' SVG must stay byte-identical');
  console.log(name + ': exact RGB pixels and identical SVG');
}
