'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {replaceOnce, injectPreview, injectSpecial, injectResmanager, injectIncdvi} = require('./build-xdv-engine.cjs');
const native = path.resolve(__dirname, '../../native/texpresso');
const read = name => fs.readFileSync(path.join(native, name), 'utf8');
test('injection rejects absent or repeated reviewed sites', () => {
  assert.throws(() => replaceOnce('abc', 'missing', 'new'));
  assert.throws(() => replaceOnce('abcabc', 'abc', 'new'));
  assert.equal(replaceOnce('abc', 'abc', 'new'), 'new');
});
test('preview enables XDV blocks before structural implementation', () => {
  const output = injectPreview(read('src/frontend/preview.c'));
  assert.match(output, /#define TXP_XDV_BLOCKS 1\n#include "[^"\n]+structural-damage\.h"/);
  assert.match(output, /damage_draw\(ctx, p, list, b, &grid, clip, renderer\)/);
});
test('PDF markers wrap exactly the page run without changing text batching', () => {
  const original = read('src/dvi/dvi_special.c');
  const output = injectSpecial(original);
  assert.equal(output.match(/pdf_run_page\(ctx, page, dc->dev, ctm, NULL\);/g).length, 1);
  const start = output.indexOf('/* Mark precisely');
  const end = output.indexOf('\n  }\n  fz_catch', start);
  const block = output.slice(start, end);
  assert.match(block, /txp_xdv_pdf_tag\(doc, xf->page \? xf->page - 1 : 0, ctm\)/);
  assert.match(block, /fz_always\(ctx\)[\s\S]*fz_end_layer/);
  assert.match(block, /fz_catch\(ctx\)[\s\S]*txp_xdv_abort\(txp_tag\);\s*fz_rethrow\(ctx\)/);
  assert.doesNotMatch(block, /dvi_flush|fz_flush/);
  // Beyond one include and precisely one call replacement, the lexer is intact.
  assert.equal(output.slice(output.indexOf('\n') + 1).slice(0, start - output.indexOf('\n') - 1),
    original.slice(0, original.indexOf('    pdf_run_page')) + '    ');
});
test('resource invalidation and free both invalidate registry identities', () => {
  const output = injectResmanager(read('src/dvi/dvi_resmanager.c'));
  assert.equal(output.match(/txp_xdv_resource_changed\(\);/g).length, 2);
});
test('snapshot hook is bounded and occurs before display-list cache lookup', () => {
  const output = injectIncdvi(read('src/frontend/incdvi.c'));
  assert.match(output, /serial >= 3/);
  assert.match(output, /buf->len > 32u\*1024u\*1024u/);
  assert.match(output, /getenv\("TEXPRESSO_XDV_DUMP_DIR"\)/);
  assert.match(output, /"%s\/%u\.xdv"/);
  assert.match(output, /incdvi_display_list\([^\n]+\)\n\{\n  txp_xdv_dump\(buf\);\n  double start/);
});
