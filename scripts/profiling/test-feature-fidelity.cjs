/* Run after measurements, against the opt-in profiling frontend. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Run}=require('../profile-preview.cjs');
async function main() {
  const root=path.resolve(process.argv[2]||'artifacts/render-model/validation');fs.mkdirSync(root,{recursive:true});
  const text=String.raw`\documentclass{article}
\begin{document}
Feature instrumentation preserves these pixels and glyphs.
\par\rule{40pt}{3pt}
\end{document}
`;
  const file=path.join(root,'features.tex');fs.writeFileSync(file,text);
  const before=process.env.TEXPRESSO_PROFILE_FEATURES,results=[];
  try {
    for(const codec of ['png','svg']) {
      let reference;
      for(const enabled of [false,true]) {
        process.env.TEXPRESSO_PROFILE_FEATURES=enabled?'1':'0';
        const active=new Run({id:'features',file,root,text,pages:1},process.env.TEXPRESSO_BINARY,codec,1200,root,0);
        try {
          await active.session.start();const first=await active.render(0);
          assert.equal(first.header.mime,codec==='png'?'image/png':'image/svg+xml');
          if(!enabled){assert.equal(first.header.renderFeatures,undefined);reference=first.bytes;}
          else {
            assert.deepEqual(first.bytes,reference,'instrumentation must preserve the exact image payload');
            const f=first.header.renderFeatures;assert.ok(f.glyphs>0&&f.uniqueGlyphs>0&&f.paths>0&&f.fonts>0);
            const cached=await active.render(0);assert.equal(cached.header.featureCached,true);
            assert.deepEqual(cached.header.renderFeatures,f);
            active.width=1000;const resized=await active.render(0);
            assert.equal(resized.header.featureCached,true,'viewport changes reuse content features');
            assert.deepEqual(resized.header.renderFeatures,f);
            active.replace(text.indexOf('pixels'),0,'zzzz');
            const edited=await active.render(0);assert.equal(edited.header.featureCached,false);
            assert.ok(edited.header.renderFeatures.glyphs>f.glyphs,'source changes invalidate feature cache');
          }
          results.push({codec,enabled,bytes:first.bytes.length,ok:true});
        } finally {await active.dispose();}
      }
    }
  } finally {
    if(before===undefined)delete process.env.TEXPRESSO_PROFILE_FEATURES;else process.env.TEXPRESSO_PROFILE_FEATURES=before;
  }
  fs.writeFileSync(path.join(root,'feature-fidelity.json'),JSON.stringify(results,null,2)+'\n');
  console.log('PASS: PNG/SVG payloads unchanged, feature cache reused and invalidated after edits');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
