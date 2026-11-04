#!/usr/bin/env python3
"""Same-runner provider/cache benchmark; binaries and packages must be installed.

Outputs compact JSON/Markdown plus diagnostics, never modifies installed packages.
Primer/download time is excluded. Cold means empty TeXpresso format+lookup caches,
not a cold OS page cache. Measures engine PNG payload arrival, not browser paint.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import selectors
import shutil
import signal
import statistics
import subprocess
import time

DOCUMENT = r'''\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section*{Provider benchmark}
Benchmark marker INITIAL. Caf\'e and Unicode input.
\[\int_0^1 x^2\,dx=\frac13,\qquad \sum_{n=1}^{10} n=55.\]
\begin{tabular}{ll}Input & Live preview\\Packages & Identical document\end{tabular}
\par Repeated text for a representative visible paragraph. A compiler should
update this paragraph without restarting its package provider or format.
\end{document}
'''


def tree_size(path):
    return sum(p.stat().st_size for p in path.rglob('*') if p.is_file())


def session(engine, provider, source, env, logfile, automatic=False, edits=5):
    started = time.monotonic()
    args = [engine, '-'+provider, '-headless', '-json', '-lines']
    if automatic: args.append('-miktex-auto-install')
    with logfile.open('wb') as log:
        p = subprocess.Popen(args+[str(source)], cwd=source.parent, env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
        pending = b''; header = None; requested = set(); request = 0
        last_hash = None
        selector = selectors.DefaultSelector(); selector.register(p.stdout, selectors.EVENT_READ)
        def send(message):
            p.stdin.write((json.dumps(message)+'\n').encode()); p.stdin.flush()
        def frame(sequence, timeout):
            nonlocal pending, header, request
            end = time.monotonic()+timeout; ready = None
            while time.monotonic() < end:
                if not selector.select(.05):
                    if p.poll() is not None: raise RuntimeError('Engine exited: '+str(p.returncode))
                    continue
                data = os.read(p.stdout.fileno(), 65536)
                if not data: raise RuntimeError('Engine EOF')
                pending += data
                while True:
                    if header:
                        size = header['byteLength']
                        if len(pending) < size: break
                        body, pending = pending[:size], pending[size:]
                        current = header; header = None
                        identity = hashlib.sha256(body).hexdigest()
                        if current['sequence'] == sequence and identity != last_hash:
                            assert body.startswith(b'\x89PNG'), 'Expected PNG payload'
                            assert len(body) > 1000, 'Suspiciously empty preview'
                            return {'payload_at': time.monotonic(), 'ready_at': ready, 'png_sha256': identity, 'bytes': len(body)}
                    elif b'\n' in pending:
                        line, pending = pending.split(b'\n',1); msg = json.loads(line)
                        if msg[0] == 'preview-image': header = msg[1]
                        elif msg[0] == 'preview-state' and msg[2] == sequence and msg[3] > 0:
                            if ready is None: ready = time.monotonic()
                            key = (msg[1], msg[2])
                            if key not in requested:
                                requested.add(key); request += 1
                                send(['preview-render', request, 0, 800, msg[1], msg[2]])
                        elif msg[0] == 'preview-error':
                            # A newer state can supersede an outstanding image.
                            raise RuntimeError(str(msg))
                    else: break
            raise TimeoutError('No current changed PNG for sequence '+str(sequence))
        try:
            image = frame(0, 600); last_hash = image['png_sha256']
            result = {'startup_ms': (image['payload_at']-started)*1000,
                      'ready_ms': (image['ready_at']-started)*1000 if image['ready_at'] else None,
                      'initial_png_sha256': last_hash, 'edit_ms': []}
            for sequence in range(1, edits+1):
                changed = DOCUMENT.replace('INITIAL', 'EDIT '+str(sequence)+' changed '+('word '*sequence))
                tick = time.monotonic()
                send(['open', str(source), changed]); send(['preview-barrier', sequence]); send(['rerun', True])
                image = frame(sequence, 60); last_hash = image['png_sha256']
                result['edit_ms'].append((image['payload_at']-tick)*1000)
            p.stdin.close(); assert p.wait(timeout=10) == 0
            return result
        except Exception:
            print(logfile.read_text(errors='replace')[-8000:], flush=True)
            raise
        finally:
            selector.close()
            try: os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            p.wait(); p.stdout.close()
            if not p.stdin.closed: p.stdin.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    output = Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
    engine = str(Path(args.engine).resolve())
    source = output/'main.tex'; source.write_text(DOCUMENT)
    real_ps = shutil.which('powershell.exe'); real_wslpath = shutil.which('wslpath')
    assert real_ps and real_wslpath and shutil.which('findtexmf') and shutil.which('tectonic')
    wrappers = output/'proxy-bin'; wrappers.mkdir(exist_ok=True)
    proxy = Path(__file__).with_name('cache_proxy.py').resolve()
    proxy.chmod(0o755)
    for name in ('powershell.exe', 'wslpath'):
        (wrappers/name).symlink_to(proxy)
    base = {**os.environ, 'SDL_VIDEODRIVER': 'dummy'}
    cases = [('texlive','direct'), ('tectonic','direct'), ('miktex','direct'),
             ('miktex-windows','direct'), ('miktex-windows','none'),
             ('miktex-windows','paths'), ('miktex-windows','mirror')]
    results = {}
    # Provision with this exact document before any timed case. All measured
    # MiKTeX sessions have downloads disabled. Do not count network setup as startup.
    for provider in dict.fromkeys(p for p,_ in cases):
        print('Priming installed packages: '+provider, flush=True)
        env = {**base, 'XDG_CACHE_HOME': str(output/'prime'/provider)}
        session(engine,provider,source,env,output/('prime-'+provider+'.log'),provider.startswith('miktex'),0)
    for provider, mode in cases:
        label = provider+'-'+mode; folder = output/label; folder.mkdir()
        if provider == 'tectonic':
            shutil.copytree(output/'prime'/provider, folder/'formats')
            shutil.rmtree(folder/'formats/texpresso', ignore_errors=True)
        env = {**base, 'XDG_CACHE_HOME': str(folder/'formats'), 'TXP_BENCH_CACHE_MODE': mode,
               'TXP_BENCH_CACHE': str(folder/'lookup-cache'), 'TXP_BENCH_REAL_POWERSHELL': real_ps,
               'TXP_BENCH_REAL_WSLPATH': real_wslpath}
        if mode != 'direct': env['PATH'] = str(wrappers)+os.pathsep+base['PATH']
        stats = folder/'stats-cold'; env['TXP_BENCH_STATS'] = str(stats)
        print('Measuring empty format/cache: '+label, flush=True)
        cold = session(engine,provider,source,env,folder/'cold.log')
        print(label+' cold '+json.dumps(cold),flush=True)
        results[label] = {'cold': cold, 'warm': [], 'folder': str(folder), 'env': env}
    # Fixed random seed interleaves warm cases to reduce ordering/host-load bias.
    schedule = [label for label in results for _ in range(args.repeats)]
    random.Random(20261104).shuffle(schedule)
    for label in schedule:
        value = results[label]; trial = len(value['warm']); folder = Path(value['folder'])
        env = {**value['env'], 'TXP_BENCH_STATS': str(folder/('stats-warm-'+str(trial)))}
        provider = label.rsplit('-',1)[0]
        print('Measuring warm '+label+' trial '+str(trial+1), flush=True)
        before = {str(p): p.stat().st_mtime_ns for p in (folder/'formats').rglob('*.fmt')}
        run = session(engine,provider,source,env,folder/('warm-'+str(trial)+'.log'))
        after = {str(p): p.stat().st_mtime_ns for p in (folder/'formats').rglob('*.fmt')}
        assert before and before == after, 'Warm run rebuilt format: '+label
        assert run['initial_png_sha256'] == value['cold']['initial_png_sha256'], 'Cache changed rendered output: '+label
        value['warm'].append(run)
        print(label+' warm '+json.dumps(run),flush=True)
    assert len({value['cold']['initial_png_sha256'] for label,value in results.items() if label.startswith('miktex-windows-')}) == 1, 'Cache strategy changed initial pixels'
    rows = ['| Provider / cache | Empty format (s) | Warm median (s) | Edit median / max (ms) | Cache MiB |',
            '| --- | ---: | ---: | ---: | ---: |']
    for label, value in results.items():
        folder = Path(value.pop('folder')); value.pop('env')
        value['cache_bytes'] = tree_size(folder/'lookup-cache')
        value['proxy_stats'] = {str(p.relative_to(folder)): json.loads(p.read_text()) for p in folder.glob('stats-*/*.json')}
        warm = value['warm']; edits = [n for run in warm for n in run['edit_ms']]
        rows.append('| %s | %.3f | %.3f | %.1f / %.1f | %.2f |' % (label,value['cold']['startup_ms']/1000,
            statistics.median(r['startup_ms'] for r in warm)/1000,statistics.median(edits),max(edits),value['cache_bytes']/1024**2))
    metadata = {'engine_revision': subprocess.check_output(['git','-C',str(Path(engine).parents[1]),'rev-parse','HEAD'],text=True).strip(),
                'versions': {command: subprocess.check_output([command, '--version'],stderr=subprocess.STDOUT,text=True).splitlines()[0] for command in ('kpsewhich','findtexmf','tectonic')},
                'document_sha256': hashlib.sha256(DOCUMENT.encode()).hexdigest(), 'repeats': args.repeats,
                'environment': subprocess.check_output(['uname','-a'],text=True).strip(), 'results': results}
    (output/'results.json').write_text(json.dumps(metadata,indent=2)+'\n')
    report = '# Provider/cache benchmark\n\n'+ '\n'.join(rows)+'\n\nAll cases use the same document and WSL runner. Packages are primed before timing; measured MiKTeX sessions disable installation. Empty-format timing does not clear OS caches. Warm trials are interleaved in a fixed random order; each has five visible edits. Latency ends at current changed PNG payload arrival, before VS Code/browser decoding or paint. Direct Windows versus proxy-none quantifies harness overhead. Paths/mirror are benchmark-only positive caches under a frozen package installation; original files are stat-validated, misses retried, and font-map configuration clears path records. Package database/ranking changes need a production invalidation design. Local mirroring adds storage and licensing/distribution considerations. No runtime caching policy is changed.\n'
    (output/'results.md').write_text(report); print(report,flush=True)


if __name__ == '__main__': main()
