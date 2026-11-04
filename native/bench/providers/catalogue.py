#!/usr/bin/env python3
"""Experimental, read-only MiKTeX FNDB-5 resolver in WSL.

Independent parser of the public FNDB layout; no MiKTeX code is vendored.
Reference: MiKTeX/miktex 76d1b3b, Core/Fndb/{fndbmem.h,FileNameDatabase.cpp}
and Core/Session/{findfile.cpp,searchpath.cpp,texmfroot.cpp} (GPL-2.0-or-later).
Unknown/ambiguous cases return None for the real resolver, never a guessed miss.
"""
import base64
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import struct
import subprocess
import time


def normal(value):
    return value.replace('\\', '/').lower()


def fingerprint(path):
    try:
        s = Path(path).stat()
        return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    except FileNotFoundError:
        return None


def read_fndb(path):
    data = Path(path).read_bytes()
    if len(data) < 40: raise ValueError('truncated FNDB header')
    signature,version,flags,strings,table,dirs,count,depth,size,reserved = struct.unpack_from('<10I',data)
    if signature != 0x42444e46 or version != 5 or flags != 0:
        raise ValueError('unsupported FNDB signature/version/flags')
    if not 40 <= size <= len(data) or not (40 <= strings <= len(data) or strings == 0) or not (40 <= table <= len(data) or table == 0 and count == 0) or count > (len(data)-table)//16 or count and strings == len(data):
        raise ValueError('invalid FNDB offsets/count')
    def string(offset, optional=False):
        if optional and offset == 0: return ''
        if not 40 <= offset < len(data): raise ValueError('invalid FNDB string offset')
        end = data.find(b'\0',offset)
        if end < 0: raise ValueError('unterminated FNDB string')
        return data[offset:end].decode('utf8')
    records = {}
    def put(name,directory,info):
        directory = directory.replace('\\','/').strip('/')
        if not name or '/' in name or '\\' in name or name in ('.','..') or '..' in directory.split('/') or ':' in directory:
            raise ValueError('invalid relative FNDB record')
        key=(normal(name),normal(directory))
        if key in records and records[key][:2] != (name,directory): raise ValueError('ambiguous FNDB case variants')
        records[key] = (name,directory,info)
    for i in range(count):
        name,directory,info,unused = struct.unpack_from('<4I',data,table+16*i)
        put(string(name),string(directory),string(info,True))
    journal = Path(str(path)+'.log')
    if journal.exists():
        raw = journal.read_bytes()
        if raw and not raw.endswith(b'\n'): raise ValueError('incomplete FNDB journal')
        for line in raw.decode('utf8').splitlines():
            fields = line[1:].split(';')
            if line.startswith('+') and len(fields) >= 3:
                put(*fields[:3])
            elif line.startswith('-') and len(fields) >= 2:
                key=(normal(fields[0]),normal(fields[1]).strip('/'))
                if key not in records: raise ValueError('journal removes unknown record')
                records.pop(key)
            else: raise ValueError('invalid FNDB journal record')
    result = {}
    for name,directory,info in records.values():
        result.setdefault(normal(name),[]).append((name,directory,info))
    return result


def pattern_regex(pattern):
    # // means zero or more complete directory components, not arbitrary text.
    pattern = normal(pattern)
    if any(c in pattern for c in '{}$%*?'): raise ValueError('unsupported path expansion')
    if not pattern.endswith('/'): pattern += '/'
    parts = re.split(r'/{2,}',pattern)
    return re.compile('^'+r'/(?:[^/]+/)*'.join(re.escape(p) for p in parts)+'$')


class Catalogue:
    def __init__(self, metadata, snapshot=False):
        self.metadata = metadata
        self.roots = metadata['roots']
        self.types = metadata['types']
        self.drives = metadata['drives']
        self.snapshot=snapshot  # benchmark-only: installation/configuration frozen
        self.absent=set()
        self.missing_requests=set()
        self.loaded = None
        self.tables = {}
        self.stats = {'local_hits':0,'local_misses':0,'fallbacks':0,'reloads':0,'load_ms':0}
        self.config_stamp = [(p,fingerprint(p)) for p in metadata.get('config_watch',[])]
        self.refresh()

    def translate(self, windows):
        value = normal(windows)
        matches = [(normal(root).rstrip('/'),linux) for root,linux in self.drives.items()
                   if value == normal(root).rstrip('/') or value.startswith(normal(root).rstrip('/')+'/')]
        if not matches: raise ValueError('unmapped Windows root')
        root,linux = max(matches,key=lambda item:len(item[0]))
        # Preserve actual filename spelling on case-sensitive mounted folders.
        suffix = windows.replace('\\','/')[len(root):].lstrip('/')
        return Path(linux)/suffix

    def refresh(self):
        states = tuple((r['windows'],r.get('fndb'),fingerprint(r['fndb']) if r.get('fndb') else None,
                        fingerprint(str(r['fndb'])+'.log') if r.get('fndb') else None) for r in self.roots)
        if states == self.loaded: return
        started=time.monotonic(); tables={}
        for root in self.roots:
            if not root.get('fndb'): continue
            try:
                before=(fingerprint(root['fndb']),fingerprint(root['fndb']+'.log'))
                table=read_fndb(root['fndb'])
                after=(fingerprint(root['fndb']),fingerprint(root['fndb']+'.log'))
                if before != after: raise ValueError('FNDB changed while reading')
                tables[normal(root['windows']).rstrip('/')]=table
            except (OSError,ValueError,UnicodeError,struct.error):
                pass  # unsupported/torn database: real resolver remains authoritative
        self.tables=tables; self.loaded=states
        self.stats['reloads']+=1; self.stats['load_ms']+=(time.monotonic()-started)*1000

    def resolve(self, arguments):
        key=tuple(arguments)
        result=(1,'') if self.snapshot and key in self.missing_requests else self._resolve(arguments)
        if self.snapshot and result == (1,''): self.missing_requests.add(key)
        self.stats['fallbacks' if result is None else 'local_hits' if result[0]==0 else 'local_misses']+=1
        return result

    def filesystem_miss(self, pattern, base):
        """Prove absence in an unmanaged recursive tree, never guess a hit.

        User config/data roots are not FNDB-authoritative. Walk their actual
        directories on misses; finding anything delegates ordering to MiKTeX.
        A bounded/incomplete traversal also delegates, including directory links.
        """
        key=(pattern,base)
        if self.snapshot and key in self.absent: return True
        prefix=re.split(r'/{2,}',pattern,maxsplit=1)[0]
        directory=self.translate(prefix)
        if not directory.exists():
            if self.snapshot: self.absent.add(key)
            return True
        match=pattern_regex(pattern)
        def failed(error): raise error
        count=0
        for folder,dirs,files in os.walk(directory,onerror=failed):
            count+=1
            if count>4096 or any((Path(folder)/d).is_symlink() for d in dirs): return False
            relative=Path(folder).relative_to(directory)
            windows=ntpath.join(prefix,str(relative).replace('/','\\')) if str(relative)!='.' else prefix
            if match.fullmatch(normal(windows).rstrip('/')+'/') and any(normal(f)==normal(base) for f in files):
                return False
        if self.snapshot: self.absent.add(key)
        return True

    def _resolve(self, arguments):
        if arguments[1] != 'findtexmf.exe': return None
        if arguments[2:]==['--version']: return (0,self.metadata['version'])
        if not self.snapshot:
            if any(fingerprint(p)!=s for p,s in self.config_stamp): return None
            self.refresh()
        kind=None; install=False; filename=None
        for i,argument in enumerate(arguments[2:]):
            if argument=='--':
                rest=arguments[i+3:]
                if len(rest)!=1: return None
                filename=rest[0]; break
            if argument.startswith('--file-type='): kind=argument.split('=',1)[1]
            elif argument=='--must-exist': install=True
            elif argument!='--the-name-of-the-game=xetex': return None
        if not filename or any(c in filename for c in '%$~\n\r') or ntpath.isabs(filename) or '..' in filename.replace('\\','/').split('/'):
            return None
        ext=ntpath.splitext(filename)[1].lower()
        if kind is None:
            kind=next((k for k,v in self.types.items() if ext and ext in v['extensions']),None)
            if kind is None:
                # A known type whose search policy was not exported belongs to
                # MiKTeX, rather than the default TeX search path.
                if ext in self.metadata.get('other_extensions',[]): return None
                kind='tex'
        if kind not in self.types: return None
        spec=self.types[kind]
        names=([filename+e for e in spec['extensions']] if ext not in spec['extensions']+spec['alternates'] else [])+[filename]
        for name in names:
            deferred=[]
            directory,base=ntpath.split(name)
            for pattern in spec['paths']:
                if pattern == '.':
                    pattern=self.metadata.get('working_directory')
                    if not pattern: return None
                pattern=pattern.replace('\\','/')
                if directory: pattern=pattern.rstrip('/')+('/' if not pattern.endswith('//') else '//')+directory.replace('\\','/')
                try: match=pattern_regex(pattern)
                except ValueError: return None
                root=next((r for r in sorted(self.roots,key=lambda r:len(r['windows']),reverse=True)
                    if normal(pattern).startswith(normal(r['windows']).rstrip('/')+'/')),None)
                table=self.tables.get(normal(root['windows']).rstrip('/')) if root else None
                if table is not None:
                    candidates=[]
                    for found,relative,info in table.get(normal(base),[]):
                        win=ntpath.join(root['windows'],relative.replace('/','\\'),found)
                        win_dir=normal(ntpath.dirname(win)).rstrip('/')+'/'
                        if match.fullmatch(win_dir):
                            try:
                                if self.translate(win).is_file(): candidates.append(win)
                            except (OSError,ValueError): return None
                    if len(candidates)>1: return None  # preserve MiKTeX tie-breaking
                    if candidates: return (0,candidates[0]+'\n')
                    if not root.get('managed'): deferred.append(pattern)
                else:
                    # Unindexed nonrecursive directories can be checked directly.
                    # Existing unindexed recursive trees must use the real resolver.
                    try:
                        if '//' in normal(pattern)[3:]:
                            if not self.filesystem_miss(pattern,base): return None
                        else:
                            win=ntpath.normpath(ntpath.join(pattern,base))
                            if self.translate(win).is_file(): return (0,win+'\n')
                    except (OSError,ValueError): return None
            for pattern in deferred:
                try:
                    if '//' in normal(pattern)[3:]:
                        if not self.filesystem_miss(pattern,base): return None
                    else:
                        win=ntpath.normpath(ntpath.join(pattern,base))
                        if self.translate(win).is_file(): return (0,win+'\n')
                except (OSError,ValueError): return None
        return None if install else (1,'')


class WindowsTools:
    """Reuse the existing job-controlled Windows helper for bootstrap/reference."""
    def __init__(self, engine, powershell, bin_directory, log):
        script=(Path(engine).resolve().parents[1]/'src/common/miktex_windows.ps1').read_text()
        script=script.replace("@('findtexmf.exe','miktex.exe')","@('findtexmf.exe','miktex.exe','initexmf.exe')")
        # Export the same working directory used by ProcessStartInfo, without
        # permitting arbitrary commands through the helper protocol.
        script=script.replace("    if ($tool -notin", "    if ($tool -eq 'catalogue-context') {\n      [Console]::WriteLine('0:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetTempPath())))\n      continue\n    }\n    if ($tool -notin")
        encoded=base64.b64encode(script.encode('utf-16-le')).decode()
        self.bin=bin_directory
        self.child=subprocess.Popen([powershell,'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],
                                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
    def call(self, tool, args, optional=False):
        encoded=base64.b64encode('\0'.join([self.bin,tool,*args]).encode()).decode()
        self.child.stdin.write('60000:'+encoded+'\n'); self.child.stdin.flush()
        line=self.child.stdout.readline()
        if not line: raise RuntimeError('MiKTeX metadata helper exited')
        code,body=line.strip().split(':',1); value=base64.b64decode(body).decode('utf8')
        if code!='0' and not optional: raise RuntimeError('MiKTeX metadata query failed: '+str(args))
        return value
    def close(self):
        self.child.stdin.close()
        try: self.child.wait(timeout=10)
        except subprocess.TimeoutExpired: self.child.kill(); self.child.wait()
        self.child.stdout.close()


def export_metadata(engine,powershell,bin_directory,wslpath,log):
    started=time.monotonic(); tools=WindowsTools(engine,powershell,bin_directory,log)
    try:
        working_directory=tools.call('catalogue-context',[]).strip()
        report=tools.call('initexmf.exe',['--report'])
        values={k:v.strip() for k,v in re.findall(r'^([^:\r\n]+): (.*)$',report,re.M)}
        roots=[v for k,v in values.items() if re.fullmatch(r'Root\d+',k)]
        drives={}
        def translate(windows):
            drive=ntpath.splitdrive(windows)[0]+'\\'
            if drive not in drives: drives[drive]=subprocess.check_output([wslpath,'-u',drive],text=True).strip()
            return str(Path(drives[drive])/windows.replace('\\','/')[len(drive):])
        data_roots=[values[k] for k in ('UserData','CommonData') if k in values]
        records=[]
        for root in roots:
            candidates=[]
            hashed=hashlib.md5(normal(root).encode()).hexdigest()
            common=root in [values.get(k) for k in ('CommonInstall','CommonConfig','CommonData')]
            order=sorted(data_roots,key=lambda p:p!=values.get('CommonData' if common else 'UserData'))
            for data in order:
                base=Path(translate(data))/'miktex/data'
                candidates += list(base.glob('**/'+hashed+'.fndb-5'))
            alternate=Path(translate(root))/'miktex/config/texmf.fndb-5'
            if alternate.exists(): candidates.append(alternate)
            records.append({'windows':root,'linux':translate(root),'fndb':str(candidates[0]) if candidates else None,
                            'managed':root in [values.get(k) for k in ('UserInstall','CommonInstall')]})
        types={}
        listed=tools.call('findtexmf.exe',['--list-file-types'])
        # Export the actual configured file-type policy, not guessed TDS paths.
        wanted={'tex','tfm','vf','map','enc','type1 fonts','truetype fonts','opentype fonts','misc fonts','graphic/figure','PostScript header','cid maps'}
        listed_types=dict(re.findall(r'^\s+(.+?) \(([^)]*)\)',listed,re.M))
        other_extensions=[e.lower() for name,extensions in listed_types.items() if name not in wanted
                          for e in extensions.split(';') if e]
        # --list-file-types omits types with no primary extensions (including
        # misc fonts), but explicit requests still need their search paths.
        # Preserve MiKTeX's type order when extensions overlap (e.g. .enc).
        for name in [n for n in listed_types if n in wanted]+sorted(wanted-listed_types.keys()):
            extensions=listed_types.get(name,'')
            paths=tools.call('findtexmf.exe',['--the-name-of-the-game=xetex','--show-path='+name]).strip().split(';')
            alternate=tools.call('initexmf.exe',['--show-config-value=[Core.FileTypes.'+name+']AltExtensions[]'],optional=True)
            types[name]={'extensions':[e.lower() for e in extensions.split(';') if e],
                         'alternates':[e.lower() for e in re.split('[;\r\n]+',alternate.strip()) if e],
                         'paths':[p for p in paths if p]}
        watch=[]
        for key in ('UserConfig','CommonConfig','UserInstall','CommonInstall'):
            if key in values:
                directory=Path(translate(values[key]))/'miktex/config'
                watch.append(str(directory)); watch.extend(str(p) for p in directory.glob('*.ini'))
        return {'schema':1,'source_revision':'76d1b3bd2b69857f30133c62ff9ab66c83dcf80f',
                'version':tools.call('findtexmf.exe',['--version']),'roots':records,'types':types,'drives':drives,
                'other_extensions':sorted(set(other_extensions)),
                'working_directory':working_directory,
                'listed_types':listed,
                'config_watch':sorted(set(watch)),'bootstrap_ms':(time.monotonic()-started)*1000,'report':report}
    finally: tools.close()


def validate_catalogue(metadata,engine,powershell,bin_directory,log):
    """Compare real installed catalogue answers with MiKTeX, including misses."""
    import random
    view=Catalogue(metadata)
    if not view.tables: raise AssertionError('No supported installed FNDB was found')
    names=sorted({name for table in view.tables.values() for rows in table.values() for name,_,_ in rows
                  if ntpath.splitext(name)[1].lower() in {'.tex','.sty','.cls','.tfm','.pfb','.map','.enc','.tec'}})
    random.Random(20261104).shuffle(names)
    queries=[['--the-name-of-the-game=xetex','--',name] for name in names[:80]]
    queries += [['--the-name-of-the-game=xetex','--',f'texpresso-absent-{i}.sty'] for i in range(20)]
    queries += [['--the-name-of-the-game=xetex','--file-type=tex','--','UnicodeData.txt'],
                ['--the-name-of-the-game=xetex','--file-type=misc fonts','--','tex-text.tec']]
    tools=WindowsTools(engine,powershell,bin_directory,log); hits=misses=fallbacks=0
    try:
        for query in queries:
            local=view.resolve([bin_directory,'findtexmf.exe',*query])
            if local is None: fallbacks+=1; continue
            expected=tools.call('findtexmf.exe',query,optional=True).strip().strip('"')
            code,path=local; path=path.strip().strip('"')
            assert normal(path)==normal(expected), ('Catalogue disagrees with MiKTeX',query,path,expected)
            if code==0: hits+=1
            else: misses+=1
        assert hits>=20 and misses>=10, ('Too few local answers',hits,misses,fallbacks)
        return {'compared_hits':hits,'compared_misses':misses,'fallbacks':fallbacks,
                'indexed_roots':len(view.tables),'indexed_files':sum(len(rows) for table in view.tables.values() for rows in table.values())}
    finally: tools.close()
