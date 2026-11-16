#!/usr/bin/env node
'use strict';
// Experiment-only scratch build. Reuses the ordinary frontend objects, libraries,
// compiler configuration and worker; never changes native source files.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '../..');
const native = path.join(repo, 'native/texpresso');
const work = path.join(repo, 'native/.work/xdv-blocks');
function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, `Reviewed injection site must occur exactly once: ${from}`);
  return source.replace(from, to);
}
function injectPreview(source) {
  source = replaceOnce(source, 'void txp_preview_export(fz_context *ctx,',
    `#define TXP_XDV_BLOCKS 1\n#include ${JSON.stringify(path.join(__dirname, 'structural-damage.h'))}\n\nvoid txp_preview_export(fz_context *ctx,`);
  source = replaceOnce(source, 'else pix = txp_preview_draw(ctx, list, b, &grid, clip);',
    'else pix = damage_draw(ctx, p, list, b, &grid, clip, renderer);');
  return replaceOnce(source, 'txp_renderer_colorize_rgb(ctx, renderer, pix);',
    'if (!p->surface) txp_renderer_colorize_rgb(ctx, renderer, pix);');
}
function injectSpecial(source) {
  source = '#include "xdv-block-registry.h"\n' + source;
  return replaceOnce(source, '    pdf_run_page(ctx, page, dc->dev, ctm, NULL);', `    /* Mark precisely the imported page; do not flush pending DVI text. */
    const char *txp_tag = txp_xdv_pdf_tag(doc, xf->page ? xf->page - 1 : 0, ctm);
    int txp_layer_open = 0;
    fz_var(txp_layer_open);
    fz_try(ctx)
    {
      if (txp_tag) {
        fz_begin_layer(ctx, dc->dev, txp_tag);
        txp_layer_open = 1;
      }
      pdf_run_page(ctx, page, dc->dev, ctm, NULL);
    }
    fz_always(ctx)
    {
      if (txp_layer_open) fz_end_layer(ctx, dc->dev);
    }
    fz_catch(ctx)
    {
      txp_xdv_abort(txp_tag);
      fz_rethrow(ctx);
    }`);
}
function injectResmanager(source) {
  source = '#include "xdv-block-registry.h"\n' + source;
  for (const signature of [
    'void dvi_resmanager_free(fz_context *ctx, dvi_resmanager *rm)',
    'void dvi_resmanager_invalidate(fz_context *ctx, dvi_resmanager *rm, dvi_reskind kind, const char *name)',
  ]) source = replaceOnce(source, signature + '\n{', signature + '\n{\n  txp_xdv_resource_changed();');
  return source;
}
function injectIncdvi(source) {
  source = '#include <stdio.h>\n#include <stdlib.h>\n' + source;
  return replaceOnce(source,
    'fz_display_list *incdvi_display_list(fz_context *ctx, incdvi_t *d, fz_buffer *buf, int page)\n{',
    `/* Optional private snapshots: source-bearing data stays in the supplied directory. */
static void txp_xdv_dump(fz_buffer *buf)
{
  static unsigned serial;
  const char *directory = getenv("TEXPRESSO_XDV_DUMP_DIR");
  if (!directory || !*directory || serial >= 3 || !buf || buf->len > 32u*1024u*1024u) return;
  char filename[4096];
  unsigned index = serial++;
  int length = snprintf(filename, sizeof filename, "%s/%u.xdv", directory, index);
  if (length < 0 || (size_t)length >= sizeof filename) return;
  FILE *file = fopen(filename, "wb");
  if (!file) return;
  size_t written = fwrite(buf->data, 1, buf->len, file);
  int failed = fclose(file);
  if (written != buf->len || failed) remove(filename);
}
fz_display_list *incdvi_display_list(fz_context *ctx, incdvi_t *d, fz_buffer *buf, int page)
{
  txp_xdv_dump(buf);`);
}
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === '--prepare-only'), 'Only --prepare-only is supported');
  fs.mkdirSync(work, {recursive: true});
  fs.writeFileSync(path.join(work, '.keep'), 'Active XDV block experiment\n');
  const inputs = {
    'preview.c': ['src/frontend/preview.c', injectPreview],
    'dvi_special.c': ['src/dvi/dvi_special.c', injectSpecial],
    'dvi_resmanager.c': ['src/dvi/dvi_resmanager.c', injectResmanager],
    'incdvi.c': ['src/frontend/incdvi.c', injectIncdvi],
  };
  for (const [name, [input, inject]] of Object.entries(inputs))
    fs.writeFileSync(path.join(work, name), inject(fs.readFileSync(path.join(native, input), 'utf8')));
  const frontend = ['driver', 'main', 'logo', 'sprotocol', 'state', 'fs', 'myabort', 'renderer', 'engine_tex', 'engine_pdf', 'engine_dvi', 'synctex', 'prot_parser', 'sexp_parser', 'json_parser', 'editor'];
  const scratch = Object.keys(inputs).map(name => [path.join(work, name), path.join(work, name.replace(/\.c$/, '.o'))]);
  scratch.push([path.join(__dirname, 'xdv-block-registry.c'), path.join(work, 'xdv-block-registry.o')]);
  const output = path.join(work, 'texpresso');
  const makefile = path.join(work, 'Makefile');
  const compile = scratch.map(([source, object]) => `\t$(CC) -Isrc/frontend -Isrc/include -Isrc/dvi -I${quote(__dirname)} ${path.basename(source) === 'dvi_resmanager.c' ? '$(shell pkg-config --cflags freetype2) ' : ''}-c -o ${quote(object)} ${quote(source)}`).join('\n');
  fs.writeFileSync(makefile, `include Makefile.config\n.PHONY: experiment\nexperiment:\n${compile}\n\t$(LDCC) -o ${quote(output)} ${frontend.map(n => 'build/frontend/' + n + '.o').join(' ')} ${scratch.map(([, object]) => quote(object)).join(' ')} build/frontend/libmydvi.a build/common/libcommon.a $(LIBS)\n`);
  if (process.argv.includes('--prepare-only')) { console.log(makefile); return; }
  for (const name of frontend) assert.ok(fs.existsSync(path.join(native, 'build/frontend', name + '.o')), 'Build ordinary frontend first: ' + name);
  const result = cp.spawnSync('make', ['-f', makefile, 'experiment'], {cwd: native, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  for (const name of ['texpresso-xetex', ...fs.readdirSync(path.join(native, 'build')).filter(n => n.endsWith('.dylib'))]) {
    const link = path.join(work, name);
    try { fs.unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.symlinkSync(path.join(native, 'build', name), link);
  }
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sources = [__filename, ...Object.values(inputs).map(([input]) => path.join(native, input)),
    ...Object.keys(inputs).map(name => path.join(work, name)),
    ...['structural-damage.h', 'xdv-block-damage.h', 'xdv-block-registry.h', 'xdv-block-registry.c'].map(name => path.join(__dirname, name))];
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({
    engineRevision: cp.execFileSync('git', ['rev-parse', 'HEAD'], {cwd: native, encoding: 'utf8'}).trim(),
    baselineBinarySha256: sha(path.join(native, 'build/texpresso')),
    experimentBinarySha256: sha(output), workerSha256: sha(path.join(work, 'texpresso-xetex')),
    sources: Object.fromEntries(sources.map(file => [path.relative(repo, file), sha(file)])),
    reusedObjects: Object.fromEntries(frontend.map(name => [name, sha(path.join(native, 'build/frontend', name + '.o'))])),
    archives: Object.fromEntries(['build/frontend/libmydvi.a', 'build/common/libcommon.a'].map(file => [file, sha(path.join(native, file))])),
    makefileSha256: sha(makefile), compilerConfiguration: fs.readFileSync(path.join(native, 'Makefile.config'), 'utf8'),
  }, null, 2) + '\n');
  console.log(output);
}
module.exports = {replaceOnce, injectPreview, injectSpecial, injectResmanager, injectIncdvi};
if (require.main === module) main();
