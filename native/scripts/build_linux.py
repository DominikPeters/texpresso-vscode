#!/usr/bin/env python3
"""Build a compact Linux engine from pinned local sources, without downloads."""
import argparse
import json
import os
import platform
import shlex
import shutil
import tempfile
from pathlib import Path
from common import NATIVE, check_source, export_source, load_lock, pinned_engine, run, sha256
from build import shell_flags
from icu_data import prepare
from bundle_linux import bundle
import zlib_ng


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mupdf-source', type=Path, required=True)
    parser.add_argument('--zlib-ng-source', type=Path, required=True)
    parser.add_argument('--icu-prefix', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--keep-work', action='store_true', help='retain successful build intermediates for debugging')
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
        parser.error('Build on a native Linux x64 or arm64 runner')
    for name in ('mupdf_source', 'zlib_ng_source', 'icu_prefix', 'output'):
        setattr(args, name, getattr(args, name).resolve())
    for command in ('gcc', 'g++', 'cmake', 'make', 'pkg-config', 'patchelf', 'strip', 'ldd', 'dpkg-query'):
        if not shutil.which(command):
            parser.error('Missing build tool: ' + command)
    if args.output.exists() or args.output.with_suffix('.zip').exists():
        parser.error('Output already exists')
    lock = load_lock()
    engine, revision = pinned_engine()
    check_source(args.mupdf_source, lock['mupdf']['revision'])
    for path, sha in lock['mupdf']['submodules'].items():
        check_source(args.mupdf_source / path, sha)
    work_root = NATIVE / '.work'
    work_root.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='linux-', dir=work_root))
    jobs = min(os.cpu_count() or 2, 8)
    txp, mupdf = work / 'texpresso', work / 'mupdf'
    export_source(engine, txp)
    run(['make', 'test-profile'], cwd=txp)
    export_source(args.mupdf_source, mupdf)
    for path in lock['mupdf']['submodules']:
        (mupdf / path).rmdir()
        export_source(args.mupdf_source / path, mupdf / path)
    shutil.copyfile(NATIVE / 'profiles/mupdf.mk', mupdf / 'user.make')
    zng_include, zng_library, zng_notice, zng_metadata = zlib_ng.build(args.zlib_ng_source, work / 'zlib-ng', jobs)
    packages = ['freetype2', 'libjpeg', 'libopenjp2', 'libbrotlidec', 'libbrotlienc', 'sdl2',
                'harfbuzz', 'graphite2', 'fontconfig', 'libpng']
    versions = {p: run(['pkg-config', '--modversion', p], capture=True) for p in packages}
    include_flags = ['-I' + str(mupdf / 'include')] + shlex.split(run(['pkg-config', '--cflags', *packages], capture=True))
    run(['make', f'-j{jobs}', 'libs', 'OUT=build/vscode', 'CC=gcc',
         'XCFLAGS=' + shell_flags(['-fPIC', *include_flags])], cwd=mupdf)
    data_object, icu_metadata = prepare(args.icu_prefix, work / 'icu', lock['icu']['version'])
    libraries = [mupdf / 'build/vscode/libmupdf.a', mupdf / 'build/vscode/libmupdf-third.a', zng_library]
    libraries += shlex.split(run(['pkg-config', '--libs', *packages], capture=True))
    libraries += ['-ljbig2dec', '-lz', '-lm', '-pthread', '-ldl']
    flags = ['-O2', '-fPIC', '-ffunction-sections', '-fdata-sections', '-I.',
             '-DTXP_ZLIB_NG', '-I' + str(zng_include), *include_flags]
    (txp / 'Makefile.config').write_text('CFLAGS=' + shell_flags(flags) + '\nCC=gcc $(CFLAGS)\n' +
        'LDCC=g++ $(CFLAGS) -Wl,--gc-sections\nLIBS=' + shell_flags(libraries) + '\n')
    run(['make', 'common'], cwd=txp)
    run(['make', f'-j{jobs}', 'all', 'PKGSYS=', '_FLAGS=-ffunction-sections -fdata-sections',
         '_LDFLAGS=-Wl,--gc-sections',
         'CSYSFLAGS=' + shell_flags(['-DU_STATIC_IMPLEMENTATION', '-I' + str(args.icu_prefix / 'include')]),
         'LDSYSFLAGS=' + shell_flags([args.icu_prefix / 'lib/libicuuc.a', data_object, '-pthread', '-ldl'])], cwd=txp)
    run(['make', 'test-preview-png'], cwd=txp)
    capabilities = json.loads(run([txp / 'build/texpresso', '-capabilities'], capture=True))
    zlib_ng.verify_capabilities(capabilities)
    metadata = {'schema': 1, 'kind': 'linux-host-build', 'platform': 'linux',
        'architecture': 'arm64' if platform.machine() == 'aarch64' else 'x86_64', 'engineRevision': revision,
        'mupdfRevision': lock['mupdf']['revision'], 'icu': icu_metadata, 'zlibNg': zng_metadata,
        'compiler': run(['gcc', '--version'], capture=True).splitlines()[0],
        'glibc': platform.libc_ver()[1], 'hostPackageVersions': versions,
        'profiles': {p.name: sha256(p) for p in (NATIVE / 'profiles').iterdir()},
        'features': {'externalWindow': True, 'embeddedPreview': capabilities.get('previewProtocol') == 1},
        'capabilities': capabilities}
    bundle([txp / 'build/texpresso', txp / 'build/texpresso-xetex'], args.output, metadata, {
        'texpresso-LICENSE': txp / 'LICENSE', 'mupdf-COPYING': mupdf / 'COPYING',
        'lcms2-LICENSE': mupdf / 'thirdparty/lcms2/LICENSE', 'zlib-ng-LICENSE': zng_notice,
        'icu-LICENSE': args.icu_prefix / 'share/icu' / lock['icu']['version'] / 'LICENSE'})
    if not args.keep_work:
        shutil.rmtree(work)
        print('Removed successful build workspace:', work)


if __name__ == '__main__':
    main()
