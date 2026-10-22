#!/usr/bin/env node
/* Shared sustained-edit corpus. Local TeX Live only; no downloads or forced
 * one-page sections. All scheduler plans are finite and independent of paints. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const ANCHORS=['early','middle','late'];
const marker=name=>`%<VARIED-CURSOR:${name}>`;
const prose=[
  'A local change should remain attached to its source even when surrounding material moves. We compare the displayed argument with the current source version, rather than treating the last compiled page number as a permanent identity.',
  'The construction uses a finite family of examples with different paragraph lengths. Some sentences are short. Others follow the dependence of an estimate on its parameters, introduce a counterexample, and explain why a nearby bound must be reconsidered after an insertion.',
  'An observer can return to an earlier part of the document while compilation continues. The relevant statement, equation and hyperlink must still belong to the page actually displayed, including when line wrapping pushes a later theorem across a page boundary.',
  'The proof separates the algebraic estimate from the geometric example. This makes the document useful for edits to prose, formulas, headings and diagrams, while retaining enough ordinary text to exercise paragraph breaking and natural pagination.'
];
function sourceLocation(text,name){
  if(!ANCHORS.includes(name))throw Error('Unknown varied-document anchor '+name);
  const token=marker(name),offset=text.indexOf(token);
  if(offset<0||text.indexOf(token,offset+token.length)>=0)throw Error('Missing or ambiguous cursor marker '+name);
  const prefix=text.slice(0,offset),line=prefix.split('\n').length-1,column=offset-(prefix.lastIndexOf('\n')+1);
  const visibleOffset=text.lastIndexOf(`\\noindent \\texttt{${name.toUpperCase()}-`,offset);
  const visibleLine=visibleOffset<0?line:text.slice(0,visibleOffset).split('\n').length-1;
  return {offset,utf16Offset:offset,byteOffset:Buffer.byteLength(prefix,'utf8'),line,column,line1:line+1,visibleLine,visibleLine1:visibleLine+1,destination:'varied:'+name};
}
function resolveInput(text,input){
  const end=sourceLocation(text,input.anchor).offset;
  const deleted=input.deleteBefore||'';
  if(typeof deleted!=='string')throw Error('deleteBefore must name exact source text');
  const offset=end-deleted.length;
  if(offset<0||text.slice(offset,end)!==deleted)throw Error('Undo/repair source tail mismatch for '+input.anchor);
  return {offset,length:deleted.length,text:input.text||''};
}
function applyInput(text,input){const edit=resolveInput(text,input);return text.slice(0,edit.offset)+edit.text+text.slice(edit.offset+edit.length);}
function createVariedFixture(output,options={}){
  const targetPages=options.targetPages||30;
  if(![30,100].includes(targetPages)&&!options.units)throw Error('Choose targetPages30/100 or explicit units for calibration');
  const units=options.units||Math.ceil(targetPages*1.45),id=options.id||`varied-${targetPages}`;
  const root=path.join(path.resolve(output),id);fs.mkdirSync(root,{recursive:true});
  const anchorUnits={early:1,middle:Math.floor(units/2),late:units-2};
  let text=String.raw`\documentclass[a4paper,10pt]{article}
\usepackage[margin=22mm]{geometry}
\usepackage{lipsum,amsmath,amsthm,tikz}
\usepackage[colorlinks=true,linkcolor=blue,urlcolor=blue]{hyperref}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\title{A varied document for sustained live editing}
\author{TeXpresso local profiling corpus}
\date{}
\begin{document}
\maketitle
The anchors EARLY, MIDDLE and LATE are unique source locations. Cross references
lead to Sections~\ref{unit:1}, \ref{unit:MIDDLE} and \ref{unit:LAST},
and Equation~\ref{eq:1}. The accented words caf\'{e} and na\"ive coexist with
Unicode source comments; no external bibliography, image, or shell command is needed.
% Unicode offset sentinel: café 😀 章节
`.replace('\\ref{unit:MIDDLE}',`\\ref{unit:${anchorUnits.middle}}`).replace('\\ref{unit:LAST}',`\\ref{unit:${units-1}}`);
  for(let i=0;i<units;i++){
    text+=`\n\\section{A changing estimate: case ${String(i+1).padStart(3,'0')}}\\label{unit:${i}}\n`;
    const anchor=ANCHORS.find(name=>anchorUnits[name]===i);
    if(anchor)text+=`\\hypertarget{varied:${anchor}}{}\\label{anchor:${anchor}}\n\\noindent \\texttt{${anchor.toUpperCase()}-${String(i).padStart(4,'0')}}: `+
      'This uniquely marked paragraph remains visible as nearby text, mathematical statements and section boundaries change.\n'+marker(anchor)+'\n\n';
    text+=prose[i%prose.length]+'\n\n';
    text+=`\\lipsum[${1+(i*3)%30}-${2+(i*3)%30}]\n`;
    text+=String.raw`\begin{align}
 F_k(x+h)&=F_k(x)+hF_k'(x)+\frac{h^2}{2}F_k''(x)+O(h^3),\\
 \int_0^1 t^k(1-t)\,dt&=\frac{1}{(k+1)(k+2)}.
\end{align}
`.replace('\\begin{align}',`\\begin{align}\\label{eq:${i}}`);
    text+=`\\begin{${i%3===0?'lemma':'theorem'}}\\label{thm:${i}}\n`+
      `For the finite family in case ${i+1}, the normalized error is bounded by $C_k h^2$ whenever $0<h<1$. The constant may depend on $k$ but is independent of the location of the edited paragraph.\n`+
      `\\end{${i%3===0?'lemma':'theorem'}}\n`+String.raw`\begin{proof}
Expand the two terms, collect their first-order contributions, and apply the
triangle inequality. The remaining integral is bounded on the compact interval,
so the asserted estimate follows. This argument also applies after a line break
moves the statement to the next page.
\end{proof}
`;
    if(i%6===3)text+=String.raw`\begin{center}
\begin{tikzpicture}[x=0.42cm,y=0.35cm]
 \draw[->] (0,0)--(10.4,0) node[right] {$x$};
 \draw[->] (0,0)--(0,3.4) node[above] {$F(x)$};
 \foreach \x in {1,...,9} {\draw[gray!30] (\x,0)--(\x,3);}
 \draw[blue,thick] (0,0.4) .. controls (2,3.1) and (5,-0.4) .. (10,2.8);
 \foreach \x/\y in {1/1.2,3/1.8,5/1.4,7/1.7,9/2.5}
   \fill[red] (\x,\y) circle (0.09);
\end{tikzpicture}
\end{center}
`;
    text+=`The next comparison uses Theorem~\\ref{thm:${Math.max(0,i-1)}} and Equation~\\ref{eq:${i}}. `+
      prose[(i+2)%prose.length]+'\n\n'+`\\lipsum[${3+(i*5)%25}]\n`;
  }
  text+='\n\\section*{The end of the experiment}\n\\hyperref[anchor:early]{Return to the early anchor}; '+
    '\\hyperref[anchor:middle]{return to the middle anchor}; \\hyperref[anchor:late]{return to the late anchor}.\n\\end{document}\n';
  const file=path.join(root,'varied.tex');fs.writeFileSync(file,text);
  const fixture={id,root,file,text,pages:targetPages,targetPages,units,kind:'varied',anchors:Object.fromEntries(ANCHORS.map(name=>[name,{unit:anchorUnits[name],...sourceLocation(text,name)}]))};
  fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify({...fixture,text:undefined},null,2)+'\n');
  return fixture;
}
function sustainedPlans(){
  const typed=(id,anchor,text,navigate=false)=>({id,anchor,intervalMs:100,expectedText:text,finalValid:true,
    inputs:[...text].map(character=>({anchor,text:character})),
    navigation:navigate?[{afterInput:60,action:'away',anchor:'late'},{afterInput:130,action:'back',anchor}]:[]});
  const early=typed('early-prose-math','early',String.raw`
The changing estimate now includes a second observation: every new term has a source location, and a line can move without changing its meaning.
\[
 E_n(x)=\sum_{j=1}^{n}\frac{x^j}{j^2},\qquad 0\leq x\leq 1.
\]
`,true);
  const middle=typed('middle-section-theorem','middle',String.raw`
\subsection{A statement inserted during live editing}
\begin{theorem}
For $0<x<1$, the finite sum is at most $x/(1-x)$. Its source and preview must remain associated during reflow.
\end{theorem}
\begin{proof}
Compare the summands with a geometric series and sum the bounds.
\end{proof}
`);
  const late=typed('late-proof-prose','late',String.raw`
The final argument must also update while earlier sections are visible elsewhere. We keep a uniform bound, explain the dependence on the parameter, and verify the conclusion after the paragraph has crossed its old page boundary.
`);
  const broken=String.raw`
\subsection{A pasted calculation}
\begin{align*}
 Q_m &= \sum_{j=1}^{m} j^2
`;
  const repair=String.raw` &= \frac{m(m+1)(2m+1)}{6}.
\end{align*}
`;
  return [early,middle,late,
    {id:'paste-incomplete-repair','anchor':'middle',intervalMs:350,finalValid:true,expectedText:broken+repair,
      inputs:[{anchor:'middle',text:broken,temporarilyIncomplete:true},{anchor:'middle',text:repair,repair:true}],navigation:[]},
    {id:'undo-pasted-block',anchor:'middle',intervalMs:100,finalValid:true,expectedText:'',
      inputs:[{anchor:'middle',deleteBefore:broken+repair,text:'',undo:true}],navigation:[]}
  ];
}
module.exports={ANCHORS,createVariedFixture,sourceLocation,resolveInput,applyInput,sustainedPlans};
if(require.main===module){
  const output=path.resolve(process.argv[2]||'artifacts/profile-varied-fixtures');
  const pages=Number(process.argv[3]||30);
  const fixture=createVariedFixture(output,{targetPages:pages});
  console.log(JSON.stringify({...fixture,text:undefined,plans:sustainedPlans().map(p=>({id:p.id,anchor:p.anchor,inputs:p.inputs.length,durationMs:(p.inputs.length-1)*p.intervalMs}))},null,2));
}
