#!/usr/bin/env node
'use strict';
// Public, reproducible vector-PDF import workload. Output is disposable.
const fs=require('node:fs'),path=require('node:path');
const output=path.resolve(process.argv[2]||'artifacts/xdv-fixture');fs.mkdirSync(output,{recursive:true});
function pdf(color,raster=false) {
  const drawing=['q',color+' rg','/OC /Layer BDC'];
  for(let i=0;i<6000;i++) {
    const x=(i*71)%560,y=(i*137)%290;
    drawing.push(`${x} ${y} m ${x+2} ${y+1} l ${x+1} ${y+3} l h f`);
  }
  if(raster)drawing.push('q 100 0 0 100 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID FF0000> EI Q');
  drawing.push('EMC','Q');const stream=drawing.join('\n')+'\n';
  const objects=['<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] /D << /ON [5 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 570 300] /Resources << /Properties << /Layer 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /OCG /Name (txp-xdv-forged-layer) >>'];
  let body='%PDF-1.5\n',offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const at of offsets.slice(1))body+=String(at).padStart(10,'0')+' 00000 n \n';
  body+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}
fs.writeFileSync(path.join(output,'plot.pdf'),pdf('0.1 0.3 0.8'));
fs.writeFileSync(path.join(output,'alternate.pdf'),pdf('0.8 0.1 0.2'));
fs.writeFileSync(path.join(output,'raster.pdf'),pdf('0.1 0.3 0.8',true));
fs.writeFileSync(path.join(output,'paper.tex'),String.raw`\documentclass{article}
\usepackage[margin=20mm]{geometry}
\usepackage{graphicx}
\pagestyle{empty}
\begin{document}
Editing this sentence. This public workload checks reuse of an imported vector figure.
\par\medskip
\noindent\hspace{0pt}\includegraphics[width=.9\linewidth]{plot.pdf}
\par Text after the imported figure.
\end{document}
`);
const text=fs.readFileSync(path.join(output,'paper.tex'),'utf8');
const twice=text.replace('\\par Text after', '\\par\\noindent\\includegraphics[width=.3\\linewidth]{plot.pdf}\n\\par Text after');
fs.writeFileSync(path.join(output,'twice.tex'),twice);
fs.writeFileSync(path.join(output,'raster.tex'),text.replace('{plot.pdf}','{raster.pdf}'));
const inputs=[{id:'pdf-import',project:output,entry:'paper.tex',focusPage:0,editAfter:'Editing this sentence.',figureChange:{from:'\\hspace{0pt}',to:'\\hspace{0.3pt}'}}];
const adversarial=[
  {id:'pdf-resource',entry:'paper.tex',figureChange:{from:'{plot.pdf}',to:'{alternate.pdf}'}},
  {id:'pdf-scale',entry:'paper.tex',figureChange:{from:'width=.9',to:'width=.91'}},
  {id:'pdf-raster',entry:'raster.tex',figureChange:{from:'\\hspace{0pt}',to:'\\hspace{0.3pt}'}},
  {id:'pdf-repeated',entry:'twice.tex',figureChange:{from:'width=.3',to:'width=.31'}},
].map(item=>({...inputs[0],...item,scenarios:['figure']}));
fs.writeFileSync(path.join(output,'inputs.json'),JSON.stringify(inputs,null,2)+'\n');
fs.writeFileSync(path.join(output,'adversarial.json'),JSON.stringify(adversarial,null,2)+'\n');
console.log(path.join(output,'inputs.json'));
