#!/usr/bin/env python3
# Generalized from the exact offline recipe used for the 1 November comparison.
import sys, json, argparse
from pathlib import Path
root=Path(__file__).resolve().parents[2];sys.path.insert(0,str(root/'native/scripts'))
from common import export_source, run, sha256, load_lock, pinned_engine, check_source
from bundle import bundle
import zlib_ng
parser=argparse.ArgumentParser(description='Build matched PNG backends offline using an existing compact MuPDF/ICU build. Does not download dependencies.')
parser.add_argument('--reuse-work',type=Path,required=True)
parser.add_argument('--dependency-bundle',type=Path,required=True)
parser.add_argument('--zlib-ng-source',type=Path,required=True)
parser.add_argument('--work',type=Path,required=True)
parser.add_argument('--bundle-prefix',type=Path,required=True,help='New path prefix; backend name is appended')
parser.add_argument('--icu-prefix',type=Path,required=True)
parser.add_argument('--check',action='store_true')
args=parser.parse_args()
prior=args.reuse_work.resolve();dep=args.dependency_bundle.resolve()/'build-manifest.json'
work=args.work.resolve();engine,revision=pinned_engine();txp=work/'texpresso'
lock=load_lock();old=json.loads(dep.read_text())
check_source(args.zlib_ng_source.resolve(),lock['zlibNg']['revision'])
if f'#define U_ICU_VERSION "{lock["icu"]["version"]}"' not in (args.icu_prefix/'include/unicode/uvernum.h').read_text():
 raise ValueError('ICU prefix does not match the lock')
if old['mupdfRevision']!=lock['mupdf']['revision'] or old['icu']['version']!=lock['icu']['version']:
 raise ValueError('Cached dependency manifest must match current MuPDF/ICU locks')
for name,digest in old['profiles'].items():
 if sha256(root/'native/profiles'/name)!=digest:raise ValueError('Cached dependency profile changed: '+name)
for relative in ['mupdf/build/vscode/libmupdf.a','mupdf/build/vscode/libmupdf-third.a','icu/filtered/icudata.o','texpresso/Makefile.config']:
 if not (prior/relative).is_file():raise ValueError('Missing cached input: '+relative)
for package,version in old['hostPackageVersions'].items():
 if run(['pkg-config','--modversion',package],capture=True)!=version:raise ValueError('Host dependency changed: '+package)
if args.check:
 print('Cached profiles, MuPDF/ICU locks, host package versions and engine pin match.');sys.exit(0)
work.mkdir(parents=True,exist_ok=False);export_source(engine,txp)
metadata=json.loads(dep.read_text());metadata.pop('zlibNg',None);metadata['kind']='matched-codec-ablation';metadata['engineRevision']=run(['git','rev-parse','HEAD'],cwd=engine,capture=True);metadata['reusedDependencyManifestSha256']=sha256(dep)
inc,lib,notice,zmeta=zlib_ng.build(args.zlib_ng_source.resolve(),work/'zlib-ng',8)
config=(prior/'texpresso/Makefile.config').read_text();(txp/'Makefile.config').write_text(config)
compiler=run(['xcrun','--find','clang'],capture=True);cxx=run(['xcrun','--find','clang++'],capture=True);sdk=run(['xcrun','--sdk','macosx','--show-sdk-path'],capture=True)
metadata['compiler']=run([compiler,'--version'],capture=True).splitlines()[0];metadata['sdk']=Path(sdk).name
metadata['recipeSha256']=sha256(Path(__file__))
flags=zlib_ng.make_flags
icu=args.icu_prefix.resolve();syslibs=[icu/'lib/libicuuc.a',prior/'icu/filtered/icudata.o']
for name in ['Foundation','CoreFoundation','CoreGraphics','CoreText','AppKit']:syslibs+=['-framework',name]
make_args=['make','-j8','all','_CC='+compiler,'_CXX='+cxx,'_LD='+cxx,'_FLAGS=-ffunction-sections -fdata-sections','_LDFLAGS='+flags(['-isysroot',sdk,'-Wl,-dead_strip']),'LDSYSFLAGS='+flags(syslibs),'CSYSFLAGS='+flags(['-isysroot',sdk,'-DXETEX_MAC','-I'+str(icu/'include'),'-I'+str(Path(run(['brew','--prefix'],capture=True))/'include'),'-fno-common'])]
ngconfig=config.replace('CFLAGS=','CFLAGS='+flags(['-DTXP_ZLIB_NG','-I'+str(inc)])+' ',1).replace('LIBS=','LIBS='+flags([lib])+' ',1)
notices={'texpresso-LICENSE':engine/'LICENSE','mupdf-COPYING':prior/'mupdf/COPYING','lcms2-LICENSE':prior/'mupdf/thirdparty/lcms2/LICENSE','icu-LICENSE':icu/'share/icu'/lock['icu']['version']/'LICENSE'}
for backend,cfg in [('zlib-ng',ngconfig),('zlib',config)]:
 (txp/'Makefile.config').write_text(cfg)
 for obj in (txp/'build/frontend').glob('*.o'):
  obj.unlink()
 run(make_args,cwd=txp)
 caps=json.loads(run([txp/'build/texpresso','-capabilities'],capture=True))
 m={**metadata,'capabilities':caps,'comparisonBackend':backend,'buildConfigSha256':sha256(txp/'Makefile.config'),'reusedMuPDFStaticSha256':sha256(prior/'mupdf/build/vscode/libmupdf.a'),'reusedICUObjectSha256':sha256(prior/'icu/filtered/icudata.o')}
 if backend=='zlib-ng':m['zlibNg']=zmeta;zlib_ng.verify_capabilities(caps)
 bundle([txp/'build/texpresso',txp/'build/texpresso-xetex'],Path(str(args.bundle_prefix.resolve())+'-'+backend),m,{**notices,**({'zlib-ng-LICENSE':notice} if backend=='zlib-ng' else {})})

workers=[Path(str(args.bundle_prefix.resolve())+'-'+name)/'bin/texpresso-xetex' for name in ['zlib','zlib-ng']]
if sha256(workers[0])!=sha256(workers[1]):raise ValueError('Matched worker executables differ')
print('PASS: matched XeTeX workers; backend and dependency hashes recorded in each manifest.')
