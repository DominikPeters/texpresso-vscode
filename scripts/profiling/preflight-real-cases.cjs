/* Local-only corpus check: compile the edit anchor, resolve its current page,
 * and inspect native feature metadata before any timed VS Code matrix. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Run}=require('../profile-preview.cjs');
async function main() {
  const file=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
  const cases=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.mkdirSync(output,{recursive:true});const results=[];
  for(const fixture of cases) {
    fixture.text=fs.readFileSync(fixture.file,'utf8');
    const active=new Run(fixture,process.env.TEXPRESSO_BINARY,'png',1250,output,0);
    let found;
    active.onPreview=event=>{if(Array.isArray(event)&&event[0]==='preview-forward')found=event;};
    try {
      await active.session.start();await active.render(0);
      const line=fixture.text.slice(0,fixture.editOffset).split('\n').length;
      active.session.send(['synctex-forward',fixture.file,line]);
      await active.until(()=>found!==undefined,'edit anchor resolved');
      const focusPage=found[3];if(focusPage<0)throw Error('No source page');
      const image=await active.render(focusPage);
      fixture.focusPage=focusPage;fixture.pages=focusPage+2;
      results.push({id:fixture.id,ok:true,focusPage,features:image.header.renderFeatures});
      console.log(JSON.stringify(results.at(-1)));
    } catch(error) {
      results.push({id:fixture.id,ok:false,error:String(error)});console.log(fixture.id+': '+String(error).slice(0,500));
    } finally {
      fs.writeFileSync(path.join(output,fixture.id+'.log'),active.trace);
      await active.dispose();delete fixture.text;
    }
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
  fs.writeFileSync(file,JSON.stringify(cases,null,2));
  if(results.some(r=>!r.ok))process.exitCode=1;
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
