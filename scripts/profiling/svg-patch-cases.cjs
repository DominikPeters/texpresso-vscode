/* Capture real SVG edit sequences and explain host patch rejection. Private
 * SVG/source stays in ignored output. No native build or document uploads. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {prepare}=require('./real-corpus.cjs'),{Run}=require('../profile-preview.cjs');
const {canonicalSvg,diffSvg}=require('../../out/svg-patch');
function inspect(output) {
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'cases.json'),'utf8')),results=[];
  for(const fixture of manifest) {
    let previous;
    for(const name of fs.readdirSync(path.join(output,fixture.id)).filter(n=>n.endsWith('.svg')).sort()) {
      const text=fs.readFileSync(path.join(output,fixture.id,name),'utf8'),doc=canonicalSvg(text,1000);
      assert.ok(doc,'Canonical SVG parsed');
      if(previous) {
        let normal,large;
        const patch=diffSvg(previous,doc,'base',{diagnostic:d=>normal=d});
        diffSvg(previous,doc,'base',{maxMs:1000,maxNodes:40000,maxOperations:20000,diagnostic:d=>large=d});
        results.push({fixture:fixture.id,frame:name,nodes:doc.root.count,bytes:Buffer.byteLength(doc.text),patch:!!patch,normal,large});
      }
      previous=doc;
    }
  }
  fs.writeFileSync(path.join(output,'diff-results.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));return results;
}
async function main() {
  const output=path.resolve(process.argv[3]);
  if(process.argv[2]==='--inspect'){inspect(output);return;}
  fs.mkdirSync(output,{recursive:true});const fixtures=prepare(process.argv[2],output);
  fs.writeFileSync(path.join(output,'cases.json'),JSON.stringify(fixtures.map(({text,...c})=>c),null,2));
  for(const fixture of fixtures) {
    const dir=path.join(output,fixture.id);fs.mkdirSync(dir);
    const active=new Run(fixture,process.env.TEXPRESSO_BINARY,'svg',1250,output,0);
    try {
      await active.session.start();
      let n=0;const capture=async()=>{const image=await active.render(fixture.focusPage);assert.equal(image.header.mime,'image/svg+xml');fs.writeFileSync(path.join(dir,String(n++).padStart(3,'0')+'.svg'),image.bytes);};
      await capture();active.replace(fixture.editOffset,0,' ');await capture();
      let inserted=1;
      for(const letter of 'abcdefghijklmnopqrst') {active.replace(fixture.editOffset+inserted++,0,letter);await capture();}
    } finally {fs.writeFileSync(path.join(dir,'trace.log'),active.trace);await active.dispose();}
  }
  inspect(output);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={inspect};
