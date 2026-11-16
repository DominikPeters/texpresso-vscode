#!/usr/bin/env node
'use strict';
// Public direct-TikZ workloads, with coordinates generated outside TeX so the
// experiment spends its time on painting rather than random-number macros.
const fs=require('node:fs'),path=require('node:path');
const output=path.resolve(process.argv[2]||'artifacts/general-fixtures');fs.mkdirSync(output,{recursive:true});
const cases=[];
for(const [id,count,partial] of [['tikz-curves',768,false],['tikz-partial-themed',64,true]]) {
  let drawing='';
  for(let i=0;i<count;i++) {
    const y=(i*137%650)/100,a=(i*73%650)/100,b=(i*311%650)/100,c=(i*197%650)/100;
    drawing+=`\\draw[blue,opacity=.15,line width=.3pt] (0,${y}) .. controls (3,${a}) and (7,${b}) .. (10,${c});\n`;
  }
  const text=String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage[margin=20mm]{geometry}
\usepackage{tikz}
\pagestyle{empty}
\begin{document}
\section*{Direct drawing workload}
Editing this sentence. This paragraph sits above the drawing. Its small changes should leave the drawing alone; wrapping it can move the drawing.

\begin{tikzpicture}
`+drawing+String.raw`\end{tikzpicture}
\end{document}
`;
  fs.writeFileSync(path.join(output,id+'.tex'),text);
  cases.push({id,project:output,entry:id+'.tex',focusPage:0,viewportPoint:[80,100],editAfter:'Editing this sentence.',figureChange:{from:'\\draw[blue,opacity',to:'\\draw[red,opacity'},...(partial?{clipOffset:[73,91],theme:[[.08,.1,.15],[.9,.8,.7]]}:{})});
}
fs.writeFileSync(path.join(output,'inputs.json'),JSON.stringify(cases,null,2)+'\n');console.log(path.join(output,'inputs.json'));
