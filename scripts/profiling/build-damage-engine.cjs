#!/usr/bin/env node
'use strict';
// Reuse an existing local frontend/worker build. Compile ONE scratch translation
// unit and link it against existing objects; no dependency or worker build.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'../..'),native=path.join(repo,'native/texpresso');
const work=path.join(repo,'native/.work/structural-damage');
fs.mkdirSync(work,{recursive:true});fs.writeFileSync(path.join(work,'.keep'),'Active structural-damage measurement\n');
let source=fs.readFileSync(path.join(native,'src/frontend/preview.c'),'utf8');
function replace(from,to) {assert.equal(source.split(from).length,2,'The reviewed injection site must occur exactly once');source=source.replace(from,to);}
replace('void txp_preview_export(fz_context *ctx,',`#include ${JSON.stringify(path.join(__dirname,'structural-damage.h'))}\n\nvoid txp_preview_export(fz_context *ctx,`);
replace('else pix = txp_preview_draw(ctx, list, b, &grid, clip);','else pix = damage_draw(ctx, p, list, b, &grid, clip, renderer);');
replace('txp_renderer_colorize_rgb(ctx, renderer, pix);','if (!p->surface) txp_renderer_colorize_rgb(ctx, renderer, pix);');
fs.writeFileSync(path.join(work,'preview.c'),source);
const objects=['driver','main','logo','sprotocol','state','fs','incdvi','myabort','renderer','engine_tex','engine_pdf','engine_dvi','synctex','prot_parser','sexp_parser','json_parser','editor'];
for(const name of objects)assert.ok(fs.existsSync(path.join(native,'build/frontend',name+'.o')),'Build the ordinary frontend first: '+name);
// Make handles the host's existing compiler/linker configuration. Paths are
// quoted for the recipe, not interpolated into a shell command by JavaScript.
const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
const output=path.join(work,'texpresso'),object=path.join(work,'preview.o');
const makefile=path.join(work,'Makefile');
fs.writeFileSync(makefile,`include Makefile.config\n.PHONY: experiment\nexperiment:\n\t$(CC) -Isrc/frontend -Isrc/include -Isrc/dvi -c -o ${quote(object)} ${quote(path.join(work,'preview.c'))}\n\t$(LDCC) -o ${quote(output)} ${objects.map(n=>'build/frontend/'+n+'.o').join(' ')} ${quote(object)} build/frontend/libmydvi.a build/common/libcommon.a $(LIBS)\n`);
const result=cp.spawnSync('make',['-f',makefile,'experiment'],{cwd:native,stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
for(const name of ['texpresso-xetex',...fs.readdirSync(path.join(native,'build')).filter(n=>n.endsWith('.dylib'))]) {
 const link=path.join(work,name);try{fs.unlinkSync(link);}catch(e){if(e.code!=='ENOENT')throw e;}
 fs.symlinkSync(path.join(native,'build',name),link);
}
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(path.join(work,'manifest.json'),JSON.stringify({engineRevision:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:native,encoding:'utf8'}).trim(),
 baselineBinarySha256:sha(path.join(native,'build/texpresso')),experimentBinarySha256:sha(output),
 previewSourceSha256:sha(path.join(native,'src/frontend/preview.c')),experimentSourceSha256:sha(path.join(__dirname,'structural-damage.h')),
 workerSha256:sha(path.join(work,'texpresso-xetex')),compilerConfiguration:fs.readFileSync(path.join(native,'Makefile.config'),'utf8')},null,2)+'\n');
console.log(output);
