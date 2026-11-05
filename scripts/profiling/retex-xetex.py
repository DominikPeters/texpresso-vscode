#!/usr/bin/env python3
"""Serial, offline compiler comparison; no preview UI or engine snapshots.

Uses the extension's existing page-fill and varied fixtures. Each timed process
runs one complete pass. This cannot measure incremental keystroke latency.
macOS wait4 peak RSS is OS process accounting, not a sampled process-group sum.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import statistics
import subprocess
import time


def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def checked(argv, **kwargs):
    return subprocess.check_output([str(a) for a in argv], text=True, **kwargs)


def measured(argv, cwd, log, env):
    """wait4 gives precise per-child CPU; kernel accounting includes waited children."""
    with open(log, 'wb') as stream:
        start = time.perf_counter()
        proc = subprocess.Popen([str(a) for a in argv], cwd=cwd, env=env,
                                stdout=stream, stderr=subprocess.STDOUT,
                                start_new_session=True)
        expired = False
        def timeout(_signum, _frame):
            nonlocal expired
            expired = True
            os.killpg(proc.pid, signal.SIGKILL)
        previous = signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, 120)
        try:
            _, status, usage = os.wait4(proc.pid, 0)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        elapsed = time.perf_counter() - start
        proc.returncode = os.waitstatus_to_exitcode(status)
    return dict(wallMs=elapsed*1000, userMs=usage.ru_utime*1000,
                systemMs=usage.ru_stime*1000, cpuMs=(usage.ru_utime+usage.ru_stime)*1000,
                maxRssBytes=usage.ru_maxrss if platform.system() == 'Darwin' else usage.ru_maxrss*1024,
                exitCode=proc.returncode, timedOut=expired)


def configure(args):
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def prepare(args, root):
    assert not (root/'manifest.json').exists(), 'Use a fresh output directory'
    repo = Path(args.repo).resolve()
    js = r'''
const path=require('node:path'),fs=require('node:fs');
const repo=process.argv[1],out=process.argv[2];
const {fixtures}=require(path.join(repo,'scripts/profile-preview.cjs'));
const {createVariedFixture}=require(path.join(repo,'scripts/profiling/varied-fixture.cjs'));
const cases=[...fixtures(out,[1],['sparse']),...fixtures(out,[10,50],['dense']),...fixtures(out,[10],['tikz'])];
cases.push(createVariedFixture(path.join(out,'fixtures'),{targetPages:30,included:true}));
for(const f of cases){
 let text=fs.readFileSync(f.file,'utf8');
 text=text.replace('\\usepackage[margin=22mm]{geometry}', '\\usepackage[margin=22mm]{geometry}\n\\usepackage{fontspec}\n\\setmainfont{lmroman10-regular.otf}[BoldFont=lmroman10-bold.otf,ItalicFont=lmroman10-italic.otf,BoldItalicFont=lmroman10-bolditalic.otf]');
 fs.writeFileSync(f.file,text);
}
const math=cases.find(f=>f.id==='dense-10');
let text=fs.readFileSync(math.file,'utf8').replace('\\usepackage{lipsum}', '\\usepackage{lipsum,amsmath,amsthm}\n\\newtheorem{theorem}{Theorem}');
text=text.replace(/\\lipsum\[1-5\]/g, String.raw`\\lipsum[1-2]
\\begin{align*}
f(x+h)&=f(x)+hf'(x)+\\frac{h^2}{2}f''(x)+O(h^3),\\\\
\\int_0^1 t^k(1-t)\\,dt&=\\frac{1}{(k+1)(k+2)},\\\\
\\sum_{j=1}^n j^2&=\\frac{n(n+1)(2n+1)}{6}.
\\end{align*}
\\begin{theorem}For $0<x<1$, the finite sum $\\sum_{j=1}^n x^j$ is at most $x/(1-x)$.\\end{theorem}
\\begin{proof}Compare the summands with a geometric series and sum the bounds.\\end{proof}`);
const dir=path.join(out,'fixtures','math-10');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'main.tex'),text);
const manifest=cases.map(f=>({id:f.id,source:f.file,files:(f.files||[]).map(x=>x.file),kind:f.kind,nominalPages:f.pages}));
manifest.push({id:'math-10',source:path.join(dir,'main.tex'),files:[],kind:'math',nominalPages:10});
console.log(JSON.stringify(manifest));
'''
    cases = json.loads(checked(['node', '-e', js, repo, root]))
    # JS raw strings above must preserve a single TeX command backslash.
    math = Path(next(c['source'] for c in cases if c['id']=='math-10'))
    # String.raw needs single slashes; normalize the deliberately isolated block.
    data = math.read_text()
    data = data.replace('\\\\lipsum','\\lipsum').replace('\\\\begin','\\begin').replace('\\\\end','\\end')
    data = data.replace('\\\\frac','\\frac').replace('\\\\int','\\int').replace('\\\\sum','\\sum').replace('\\\\,','\\,')
    data = data.replace('\\\\\\\\\n','\\\\\n')
    math.write_text(data)
    tikz = next(c for c in cases if c['kind']=='tikz')
    cached_dir = root/'fixtures'/'tikz-inline-10'
    cached_dir.mkdir(parents=True,exist_ok=True)
    cached_file = cached_dir/'main.tex'
    cached_file.write_text(Path(tikz['source']).read_text().replace(r'\begin{tikzpicture}',r'\noindent\begin{tikzpicture}'))
    cases.append(dict(id='tikz-inline-10',source=str(cached_file),files=[],kind='tikz-inline',nominalPages=10))
    timer = r"""
\ExplSyntaxOn
\cs_new_protected:Npn \txpbenchtimer #1
  { \iow_term:x { TXPBENCH~#1~\sys_timer: } }
\ExplSyntaxOff
"""
    for c in cases:
        f = Path(c['source'])
        text = f.read_text().replace(r'\begin{document}', timer + r'\begin{document}' + '\n' + r'\txpbenchtimer{body-start}')
        text = text.replace(r'\end{document}', r'\clearpage\txpbenchtimer{body-end}' + '\n' + r'\end{document}')
        f.write_text(text)
    binaries = {'retex': str(Path(args.retex).resolve()),
                'xetex-pdf': '/Library/TeX/texbin/xelatex',
                'xetex-xdv': '/Library/TeX/texbin/xelatex',
                'lualatex': '/Library/TeX/texbin/lualatex'}
    for c in cases:
        c['sha256'] = digest(c['source'])
        c['files'] = [{'source':p,'sha256':digest(p)} for p in c['files']]
    manifest = {'created':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
                'repo':str(repo),'retexRepo':str(Path(args.retex).resolve().parents[2]),
                'platform':platform.platform(),'machine':platform.machine(),
                'binaries':binaries,'binarySha256':{k:digest(v) for k,v in binaries.items()},
                'cases':cases,'repeats':args.repeats,'harnessSha256':digest(__file__),
                'sourceCommits':{str(p):checked(['git','-C',str(p),'rev-parse','HEAD']).strip() for p in (repo,Path(args.retex).resolve().parents[2])},
                'method':'Serial one-pass fresh-process compilation. No engine snapshots; no preview IPC or rendering.',
                'environment':{'RETEX_NO_SNAPSHOT':'1','SOURCE_DATE_EPOCH':'1700000000',
                               'FORCE_SOURCE_DATE':'1','RETEX_FIGURES':'on'}}
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    for engine,binary in binaries.items():
        env=dict(os.environ,RETEX_CACHE=str(root/'cache'))
        (root/(engine+'-version.txt')).write_text(checked([binary,'--version'],env=env))
    print('Prepared '+', '.join(c['id'] for c in cases),flush=True)


def run(args, root, case, engine, phase, repeat, text=None, cache=None, extra=None):
    manifest=json.loads((root/'manifest.json').read_text())
    key=engine.split(':')[0]
    folder=root/'work'/case['id']/engine.replace(':','-')
    folder.mkdir(parents=True,exist_ok=True)
    source=Path(case['source'])
    original=source.read_text()
    (folder/'main.tex').write_text(original if text is None else text)
    for f in case['files']:
        shutil.copyfile(f['source'],folder/Path(f['source']).name)
    env=dict(os.environ,RETEX_NO_SNAPSHOT='1',RETEX_CACHE=str(cache or root/'cache'),
             RETEX_FIGURES='on',SOURCE_DATE_EPOCH='1700000000',FORCE_SOURCE_DATE='1',
             NO_COLOR='1',max_print_line='1000')
    for name in ('RETEX_NO_NATIVE','RETEX_TIMING','RETEX_NATIVE_DEBUG','RETEX_DEBUG_PASSES'):
        env.pop(name,None)
    if extra: env.update(extra)
    argv=[manifest['binaries'][key],'-interaction=nonstopmode','-halt-on-error',
          '-no-shell-escape','-synctex=1','-recorder']
    if key=='retex': argv+=['--passes=1','--no-aux-dir','--message-format=json']
    if key=='xetex-xdv': argv+=['-no-pdf']
    draft = engine=='retex:draft'
    if draft: argv+=['-draftmode']
    argv+=['main.tex']
    logs=root/'logs'/case['id']/engine.replace(':','-')
    logs.mkdir(parents=True,exist_ok=True)
    log=logs/f'{phase}-{repeat}.txt'
    # Avoid accepting an output left behind by a failed compiler invocation.
    output=folder/('main.xdv' if key=='xetex-xdv' else 'main.pdf')
    output.unlink(missing_ok=True)
    result=measured(argv,folder,log,env)
    content=log.read_text(errors='replace')
    finished=None
    if key=='retex':
        records=[]
        for line in content.splitlines():
            try: records.append(json.loads(line))
            except json.JSONDecodeError: pass
        finished=next((r for r in reversed(records) if r.get('type')=='finished'),None)
    texlog = (folder/'main.log').read_text(errors='replace') if (folder/'main.log').exists() else ''
    ticks = {name:int(value) for name,value in re.findall(r'TXPBENCH (body-start|body-end) (\d+)',texlog)}
    body_ms = (ticks['body-end']-ticks['body-start'])*1000/65536 if len(ticks)==2 else None
    figures=re.findall(r'\[figures\] (\d+) pictures typeset, ([\d.]+) s; (\d+) cacheable, ([\d.]+) s; (\d+) replayed, ([\d.]+) s saved',content)
    row=dict(case=case['id'],engine=engine,phase=phase,repeat=repeat,
             sourceSha256=digest(folder/'main.tex'),command=argv,log=str(log),
             output=str(output),outputBytes=output.stat().st_size if output.exists() else 0,
             bodyMs=body_ms,bodyTimerTicks=ticks,finished=finished,figureStats=[list(x) for x in figures],**result)
    with (root/'runs.jsonl').open('a') as stream: stream.write(json.dumps(row)+'\n')
    print(f"{phase} {case['id']} {engine} #{repeat}: {row['wallMs']:.1f} ms, {row['maxRssBytes']/2**20:.1f} MiB, exit {row['exitCode']}",flush=True)
    if row['exitCode'] or row['timedOut'] or (not draft and not row['outputBytes']) or (finished and finished.get('errors',0)):
        raise RuntimeError(f'Compile failed; see {log}\n'+content[-4500:])
    if (phase == 'warm' or phase.startswith('edit-')) and repeat == args.repeats-1:
        saved=root/'snapshots'/phase/case['id']/engine.replace(':','-')
        saved.mkdir(parents=True,exist_ok=True)
        for f in folder.iterdir():
            if f.suffix in ('.pdf','.tex','.gz') and f.is_file(): shutil.copyfile(f,saved/f.name)
    return row


def preflight(args, root, cases):
    # Empty application cache, not a cold OS disk cache. Do not mix into medians.
    run(args,root,cases[0],'retex','empty-cache',0,cache=root/'first-use-cache')
    for c in cases:
        for engine in ('xetex-pdf','retex','xetex-xdv'):
            for n in range(3): run(args,root,c,engine,'preflight',n)
        for n in range(3): run(args,root,c,'lualatex','oracle',n)
        # Preserve independently converged PDFs before any edits or timing runs.
        for engine in ('xetex-pdf','retex','lualatex'):
            dest=root/'outputs'/c['id']
            dest.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(root/'work'/c['id']/engine/'main.pdf',dest/(engine+'.pdf'))
            shutil.copyfile(root/'work'/c['id']/engine/'main.synctex.gz',dest/(engine+'.synctex.gz'))
    (root/'preflight.done').write_text('ok\n')


def measure(args,root,cases):
    assert (root/'preflight.done').exists()
    engines=['retex','xetex-pdf','xetex-xdv']
    for repeat in range(args.repeats):
        for c in cases:
            for engine in engines[repeat%3:]+engines[:repeat%3]:
                run(args,root,c,engine,'warm',repeat)
    # Validate the representative measured cache path, rather than just preflight.
    for c in cases:
        for engine in ('retex','xetex-pdf'):
            saved=root/'snapshots'/'warm'/c['id']/engine
            shutil.copyfile(saved/'main.pdf',root/'outputs'/c['id']/(engine+'.pdf'))
    varied=next(c for c in cases if c['kind']=='varied')
    for location in ('early','middle','late'):
        for repeat in range(args.repeats):
            text=Path(varied['source']).read_text().replace(f'%<VARIED-CURSOR:{location}>',
                f' An inserted comparison sentence records variant {repeat+1} at the {location} location.\n%<VARIED-CURSOR:{location}>')
            for engine in engines[repeat%3:]+engines[:repeat%3]:
                run(args,root,varied,engine,'edit-'+location,repeat,text=text)
    tikz=next(c for c in cases if c['kind']=='tikz')
    # Every coordinate is novel: do not credit warm cache hits on the changed figure.
    for repeat in range(args.repeats):
        text=Path(tikz['source']).read_text().replace('(12,1.0)',f'(12,{1.101+repeat*0.031:.3f})',1)
        for engine in engines[repeat%3:]+engines[:repeat%3]:
            run(args,root,tikz,engine,'edit-coordinate',repeat,text=text)
    (root/'measure.done').write_text('ok\n')


def repair(args,root,cases):
    assert (root/'measure.done').exists()
    assert not (root/'repair.done').exists()
    reason='Auxiliary text-diff process overlapped warm rounds 0 and 1; excluded whole rounds, replaced by 5 and 6.'
    rows=[json.loads(line) for line in (root/'runs.jsonl').read_text().splitlines()]
    for row in rows:
        if row['phase']=='warm' and row['repeat'] in (0,1): row['excludedReason']=reason
    (root/'runs.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
    (root/'exclusions.json').write_text(json.dumps({'reason':reason,'excluded':42,'replacementRounds':[5,6]},indent=2)+'\n')
    engines=['retex','xetex-pdf','xetex-xdv']
    varied=next(c for c in cases if c['kind']=='varied')
    for engine in engines:
        for n in range(2): run(args,root,varied,engine,'repair-setup',n)
    for repeat in (5,6):
        for c in cases:
            for engine in engines[repeat%3:]+engines[:repeat%3]:
                run(args,root,c,engine,'warm',repeat)
    for c in cases:
        for engine in ('retex','xetex-pdf'):
            shutil.copyfile(root/'work'/c['id']/engine/'main.pdf',root/'outputs'/c['id']/(engine+'.pdf'))
    (root/'repair.done').write_text('ok\n')


def ablate(args,root,cases):
    for c in cases:
        if c['kind'] not in ('tikz','tikz-inline','varied'): continue
        for name,extra in [('figures-off',{'RETEX_FIGURES':'off'}),
                           ('native-and-figures-off',{'RETEX_FIGURES':'off','RETEX_NO_NATIVE':'1'})]:
            for n in range(2): run(args,root,c,'retex:'+name,'ablation-setup',n,extra=extra)
            for n in range(args.repeats): run(args,root,c,'retex:'+name,'ablation',n,extra=extra)


def draft(args,root,cases):
    for c in cases:
        if c['id'] not in ('dense-50','math-10','tikz-10'): continue
        for n in range(2): run(args,root,c,'retex:draft','draft-setup',n)
        for n in range(args.repeats): run(args,root,c,'retex:draft','draft',n)


def verify(args,root,cases):
    rows=[]
    for c in cases:
        item={'case':c['id'],'engines':{},'rasterDpi':150}
        for engine in ('xetex-pdf','retex','lualatex'):
            pdf=root/'outputs'/c['id']/(engine+'.pdf')
            info=checked(['pdfinfo',pdf])
            pages=int(re.search(r'^Pages:\s+(\d+)',info,re.M).group(1))
            size=re.search(r'^Page size:\s+(.+)',info,re.M).group(1)
            text=checked(['pdftotext',pdf,'-'])
            normalized=''.join(text.split())
            hashes={}
            for page in sorted(set([1,(pages+1)//2,pages])):
                stem=root/'verification'/c['id']/(engine+'-'+str(page))
                stem.parent.mkdir(parents=True,exist_ok=True)
                subprocess.run(['pdftoppm','-r','150','-gray','-f',str(page),'-l',str(page),'-singlefile',str(pdf),str(stem)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                pgm=stem.with_suffix('.pgm')
                hashes[str(page)]=digest(pgm)
                pgm.unlink()  # Retain hashes, PDFs, and sources; not hundreds of MB of rasters.
            item['engines'][engine]={'pages':pages,'pageSize':size,'normalizedTextSha256':hashlib.sha256(normalized.encode()).hexdigest(),
                                    'normalizedCharacters':len(normalized),'unresolvedReferences':'??' in text,
                                    'sampledRasterSha256':hashes,'pdfSha256':digest(pdf)}
        ref=item['engines']['lualatex'];tx=item['engines']['xetex-pdf'];rt=item['engines']['retex']
        item['retexVsLua']={k:rt[k]==ref[k] for k in ('pages','pageSize','normalizedTextSha256','sampledRasterSha256')}
        item['retexVsXe']={k:rt[k]==tx[k] for k in ('pages','pageSize','normalizedTextSha256','sampledRasterSha256')}
        assert all(item['retexVsLua'].values()), 'Retex must match the LuaLaTeX oracle'
        assert not any(e['unresolvedReferences'] for e in item['engines'].values())
        rows.append(item)
        (root/'verification.json').write_text(json.dumps(rows,indent=2)+'\n')
        print('Verified '+c['id']+': '+json.dumps({'retexVsLua':item['retexVsLua'],'retexVsXe':item['retexVsXe']}),flush=True)


def edited_pdf_metrics(pdf,stem):
    info=checked(['pdfinfo',pdf])
    pages=int(re.search(r'^Pages:\s+(\d+)',info,re.M).group(1))
    text=checked(['pdftotext',pdf,'-'])
    normalized=''.join(text.split())
    plain=re.sub('[\ufe00-\ufe0f]','',normalized)
    hashes={}
    for page in sorted(set([1,(pages+1)//2,pages])):
        prefix=stem/str(page);prefix.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['pdftoppm','-r','150','-gray','-f',str(page),'-l',str(page),'-singlefile',str(pdf),str(prefix)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        pgm=prefix.with_suffix('.pgm');hashes[str(page)]=digest(pgm);pgm.unlink()
    return {'pages':pages,'textSha256':hashlib.sha256(normalized.encode()).hexdigest(),
            'textWithoutVariationSelectorsSha256':hashlib.sha256(plain.encode()).hexdigest(),
            'unresolvedReferences':'??' in text,'sampledRasterSha256':hashes},plain


def verifyedits(args,root,cases):
    cases={c['id']:c for c in cases}
    results=[]
    for phase in ('edit-early','edit-middle','edit-late','edit-coordinate'):
        original=cases['tikz-10' if phase=='edit-coordinate' else 'varied-30']
        saved=root/'snapshots'/phase/original['id']
        sources={engine:digest(saved/engine/'main.tex') for engine in ('retex','xetex-pdf','xetex-xdv')}
        assert len(set(sources.values()))==1
        case=dict(original,id=original['id']+'-'+phase,source=str(saved/'retex'/'main.tex'))
        for n in range(3): run(args,root,case,'lualatex','edited-oracle',n)
        pdfs={engine:saved/engine/'main.pdf' for engine in ('retex','xetex-pdf')}
        pdfs['lualatex']=root/'work'/case['id']/'lualatex'/'main.pdf'
        values={}; texts={}
        for engine,pdf in pdfs.items():
            values[engine],texts[engine]=edited_pdf_metrics(pdf,root/'verification-edits'/phase/engine)
        row={'phase':phase,'case':original['id'],'sourceHashes':sources,'engines':values,
             'retexVsLua':{key:values['retex'][key]==values['lualatex'][key] for key in ('pages','textSha256','sampledRasterSha256')},
             'retexVsXePlainText':values['retex']['textWithoutVariationSelectorsSha256']==values['xetex-pdf']['textWithoutVariationSelectorsSha256']}
        if phase=='edit-coordinate':
            base,_=edited_pdf_metrics(root/'outputs'/'tikz-10'/'retex.pdf',root/'verification-edits'/'base')
            row['changedFirstPage']=base['sampledRasterSha256']['1']!=values['retex']['sampledRasterSha256']['1']
            assert row['changedFirstPage']
        else:
            location=phase.removeprefix('edit-')
            row['newSentencePresent']={engine:f'variant5atthe{location}location.' in text for engine,text in texts.items()}
            assert all(row['newSentencePresent'].values())
        results.append(row)
        (root/'verification-edits.json').write_text(json.dumps(results,indent=2)+'\n')
        print(json.dumps({k:v for k,v in row.items() if k!='engines'}),flush=True)
        assert all(row['retexVsLua'].values())
        assert not any(v['unresolvedReferences'] for v in values.values())

    print('All representative edited outputs passed.',flush=True)


def summarize(args,root,cases):
    rows=[json.loads(x) for x in (root/'runs.jsonl').read_text().splitlines()]
    excluded=[r for r in rows if r.get('excludedReason')]
    rows=[r for r in rows if not r.get('excludedReason')]
    groups=[]
    keys=sorted(set((r['case'],r['engine'],r['phase']) for r in rows))
    for case,engine,phase in keys:
        if phase not in ('warm','edit-early','edit-middle','edit-late','edit-coordinate','ablation','draft','empty-cache'): continue
        selected=[r for r in rows if (r['case'],r['engine'],r['phase'])==(case,engine,phase)]
        group={'case':case,'engine':engine,'phase':phase,'count':len(selected),'failures':sum(bool(r['exitCode']) for r in selected)}
        for field in ('wallMs','cpuMs','userMs','systemMs','maxRssBytes','outputBytes','bodyMs'):
            values=[r[field] for r in selected if r[field] is not None]
            if not values: continue
            group[field]={'median':statistics.median(values),'min':min(values),'max':max(values)}
        groups.append(group)
    output={'excludedRows':len(excluded),'finalHarnessSha256':digest(__file__),'manifest':json.loads((root/'manifest.json').read_text()),'groups':groups,
            'verification':json.loads((root/'verification.json').read_text()) if (root/'verification.json').exists() else None}
    for key,filename in [('editedVerification','verification-edits.json'),('measurementContext','measurement-context.json'),('exclusions','exclusions.json')]:
        if (root/filename).exists(): output[key]=json.loads((root/filename).read_text())
    (root/'summary.json').write_text(json.dumps(output,indent=2)+'\n')
    for g in groups: print(g['case'],g['engine'],g['phase'],round(g['wallMs']['median'],1),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','preflight','measure','repair','ablate','draft','verify','verifyedits','summarize'])
    parser.add_argument('--repo',default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument('--retex',default='/Users/dominik/GitHub/retex/target/release/retex')
    parser.add_argument('--output',required=True)
    parser.add_argument('--repeats',type=int,default=5)
    args=parser.parse_args()
    root=configure(args)
    if args.action=='prepare': prepare(args,root)
    else:
        manifest=json.loads((root/'manifest.json').read_text())
        assert args.repeats==manifest['repeats'],'Keep repeat count consistent'
        globals()[args.action](args,root,manifest['cases'])
