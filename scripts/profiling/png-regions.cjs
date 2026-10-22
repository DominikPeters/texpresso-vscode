/* Probe-only opaque, unfiltered 8-bit PNG helpers for the current native writer. */
'use strict';
const assert = require('node:assert/strict'), zlib = require('node:zlib');
function decode(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const data = []; let width, height, channels;
  for (let offset = 8; offset < png.length;) {
    const n = png.readUInt32BE(offset), tag = png.toString('ascii', offset + 4, offset + 8), chunk = png.subarray(offset + 8, offset + 8 + n);
    if (tag === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      assert.equal(chunk[8], 8); assert.ok([0, 2].includes(chunk[9])); assert.equal(chunk[12], 0);
      channels = chunk[9] === 0 ? 1 : 3;
    }
    if (tag === 'IDAT') data.push(chunk);
    offset += n + 12;
  }
  assert.ok(width * height <= 4000000);
  const stride = width * channels + 1, raw = zlib.inflateSync(Buffer.concat(data));
  assert.equal(raw.length, stride * height);
  for (let y = 0; y < height; y++) assert.equal(raw[y * stride], 0);
  return { width, height, channels, stride, raw };
}
function dirty(a, b) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height); assert.equal(a.channels, b.channels);
  let x0 = b.width, y0 = b.height, x1 = -1, y1 = -1;
  for (let y = 0; y < b.height; y++) {
    const start = y * b.stride + 1;
    if (a.raw.subarray(start, start + b.width * b.channels).equals(b.raw.subarray(start, start + b.width * b.channels))) continue;
    y0 = Math.min(y0, y); y1 = y;
    let left = 0, right = b.width - 1;
    const equal = x => { for (let c = 0; c < b.channels; c++) if (a.raw[start + x * b.channels + c] !== b.raw[start + x * b.channels + c]) return false; return true; };
    while (left < b.width && equal(left)) left++;
    while (right > left && equal(right)) right--;
    x0 = Math.min(x0, left); x1 = Math.max(x1, right);
  }
  return x1 < 0 ? undefined : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
function crc32(bytes) {
  if (zlib.crc32) return zlib.crc32(bytes);
  let crc = 0xffffffff;
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(tag, bytes) {
  const body = Buffer.concat([Buffer.from(tag), bytes]), length = Buffer.alloc(4), sum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}
function crop(frame, rect) {
  const stride = rect.width * frame.channels + 1, raw = Buffer.alloc(stride * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const start = (rect.y + y) * frame.stride + 1 + rect.x * frame.channels;
    frame.raw.copy(raw, y * stride + 1, start, start + rect.width * frame.channels);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(rect.width); header.writeUInt32BE(rect.height, 4); header[8] = 8; header[9] = frame.channels === 1 ? 0 : 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
function verify(a, b, rect, patch) {
  const p = decode(patch), restored = Buffer.from(a.raw);
  assert.equal(p.channels, b.channels);
  for (let y = 0; y < rect.height; y++) p.raw.copy(restored, (rect.y + y) * b.stride + 1 + rect.x * b.channels, y * p.stride + 1, (y + 1) * p.stride);
  assert.deepEqual(restored, b.raw, 'patch must erase old marks and exactly reproduce the new pixels');
}
module.exports = { decode, dirty, crop, verify };
