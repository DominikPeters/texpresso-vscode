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
    parser.add_argument('--maximum-glibc', help='reject any bundled ELF requiring a newer glibc')
    parser.add_argument('--bundled-jbig2dec', action='store_true', help='build the decoder pinned by MuPDF when no host development package exists')
    parser.add_argument('--bundled-harfbuzz', action='store_true', help='build the text shaper pinned by MuPDF on older distributions')
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
        parser.error('Build on a native Linux x64 or arm64 runner')
    for name in ('mupdf_source', 'zlib_ng_source', 'icu_prefix', 'output'):
        setattr(args, name, getattr(args, name).resolve())
    manager = 'debian' if shutil.which('dpkg-query') else 'rpm'
    for command in ('gcc', 'g++', 'cmake', 'make', 'pkg-config', 'patchelf', 'strip', 'ldd', 'readelf', 'dpkg-query' if manager == 'debian' else 'rpm'):
        if not shutil.which(command):
            parser.error('Missing build tool: ' + command)
    if args.output.exists() or args.output.with_suffix('.zip').exists():
        parser.error('Output already exists')
    lock = load_lock()
    engine, revision = pinned_engine()
    check_source(args.mupdf_source, lock['mupdf']['revision'])
    submodules = dict(lock['mupdf']['submodules'])
    for enabled, component in [(args.bundled_jbig2dec, 'jbig2dec'), (args.bundled_harfbuzz, 'harfbuzz')]:
        if enabled:
            path = 'thirdparty/' + component
            entry = run(['git', 'ls-tree', 'HEAD', path], cwd=args.mupdf_source, capture=True)
            if not entry.startswith('160000 commit '):
                raise ValueError('MuPDF must pin ' + component)
            submodules[path] = entry.split()[2]
    for path, sha in submodules.items():
        check_source(args.mupdf_source / path, sha)
    work_root = NATIVE / '.work'
    work_root.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='linux-', dir=work_root))
    jobs = min(os.cpu_count() or 2, 8)
    txp, mupdf = work / 'texpresso', work / 'mupdf'
    export_source(engine, txp)
    run(['make', 'test-profile'], cwd=txp)
    export_source(args.mupdf_source, mupdf)
    for path in submodules:
        (mupdf / path).rmdir()
        export_source(args.mupdf_source / path, mupdf / path)
    shutil.copyfile(NATIVE / 'profiles/mupdf.mk', mupdf / 'user.make')
    if args.bundled_jbig2dec:
        with (mupdf / 'user.make').open('a') as profile:
            profile.write('\nUSE_SYSTEM_JBIG2DEC := no\n')
    cpu_flags = ['-march=x86-64', '-mtune=generic'] if platform.machine() == 'x86_64' else ['-march=armv8-a', '-mtune=generic']
    if args.bundled_harfbuzz:
        prefix = work / 'harfbuzz-prefix'
        run(['cmake', '-S', mupdf / 'thirdparty/harfbuzz', '-B', work / 'harfbuzz-build',
             '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
             '-DCMAKE_INSTALL_PREFIX=' + str(prefix), '-DCMAKE_INSTALL_LIBDIR=lib',
             '-DCMAKE_C_FLAGS=' + shell_flags(cpu_flags), '-DCMAKE_CXX_FLAGS=' + shell_flags(cpu_flags),
             '-DBUILD_SHARED_LIBS=OFF', '-DHB_HAVE_FREETYPE=ON', '-DHB_HAVE_GRAPHITE2=ON',
             '-DHB_BUILD_UTILS=OFF', '-DHB_BUILD_SUBSET=OFF'])
        run(['cmake', '--build', work / 'harfbuzz-build', '--parallel', str(jobs)])
        run(['cmake', '--install', work / 'harfbuzz-build'])
        # MuPDF's locked HarfBuzz fork prefixes symbols through this public
        # header, but its upstream CMake install list does not include it.
        shutil.copyfile(mupdf / 'thirdparty/harfbuzz/src/hb-rename.h', prefix / 'include/harfbuzz/hb-rename.h')
        os.environ['PKG_CONFIG_PATH'] = str(prefix / 'lib/pkgconfig') + os.pathsep + os.environ.get('PKG_CONFIG_PATH', '')
    zng_include, zng_library, zng_notice, zng_metadata = zlib_ng.build(args.zlib_ng_source, work / 'zlib-ng', jobs, cpu_flags)
    packages = ['freetype2', 'libjpeg', 'libopenjp2', 'libbrotlidec', 'libbrotlienc', 'sdl2',
                'harfbuzz', 'graphite2', 'fontconfig', 'libpng']
    versions = {p: run(['pkg-config', '--modversion', p], capture=True) for p in packages}
    shaper_includes = ['-I' + str(work / 'harfbuzz-prefix/include')] if args.bundled_harfbuzz else []
    # XeTeX uses <harfbuzz/hb.h>; pkg-config's include/harfbuzz path
    # alone only covers <hb.h> and otherwise silently selects system headers.
    include_flags = [*shaper_includes, '-I' + str(mupdf / 'include')] + shlex.split(run(['pkg-config', '--cflags', *packages], capture=True))
    run(['make', f'-j{jobs}', 'libs', 'OUT=build/vscode', 'CC=gcc',
         'XCFLAGS=' + shell_flags(['-fPIC', *cpu_flags, *include_flags])], cwd=mupdf)
    data_object, icu_metadata = prepare(args.icu_prefix, work / 'icu', lock['icu']['version'])
    libraries = [mupdf / 'build/vscode/libmupdf.a', mupdf / 'build/vscode/libmupdf-third.a', zng_library]
    libraries += shlex.split(run(['pkg-config', '--libs', *packages], capture=True))
    if not args.bundled_jbig2dec:
        libraries += ['-ljbig2dec']
    libraries += ['-lz', '-lm', '-pthread', '-ldl']
    flags = ['-O2', '-fPIC', *cpu_flags, '-ffunction-sections', '-fdata-sections', '-I.',
             '-DTXP_ZLIB_NG', '-I' + str(zng_include), *include_flags]
    (txp / 'Makefile.config').write_text('CFLAGS=' + shell_flags(flags) + '\nCC=gcc $(CFLAGS)\n' +
        'LDCC=g++ $(CFLAGS) -Wl,--gc-sections\nLIBS=' + shell_flags(libraries) + '\n')
    run(['make', 'common'], cwd=txp)
    run(['make', f'-j{jobs}', 'all', 'PKGSYS=', '_FLAGS=' + shell_flags([*cpu_flags, '-ffunction-sections', '-fdata-sections']),
         '_LDFLAGS=-Wl,--gc-sections',
         'CSYSFLAGS=' + shell_flags([*shaper_includes, '-DU_STATIC_IMPLEMENTATION', '-I' + str(args.icu_prefix / 'include')]),
         'LDSYSFLAGS=' + shell_flags([args.icu_prefix / 'lib/libicuuc.a', data_object, '-pthread', '-ldl'])], cwd=txp)
    run(['make', 'test-preview-png'], cwd=txp)
    capabilities = json.loads(run([txp / 'build/texpresso', '-capabilities'], capture=True))
    zlib_ng.verify_capabilities(capabilities)
    metadata = {'schema': 1, 'kind': 'linux-host-build', 'platform': 'linux',
        'architecture': 'arm64' if platform.machine() == 'aarch64' else 'x86_64', 'engineRevision': revision,
        'mupdfRevision': lock['mupdf']['revision'], 'icu': icu_metadata, 'zlibNg': zng_metadata,
        'compiler': run(['gcc', '--version'], capture=True).splitlines()[0],
        'glibc': platform.libc_ver()[1], 'hostPackageVersions': versions,
        'hostPackageManager': manager, 'cpuBaseline': 'x86-64' if platform.machine() == 'x86_64' else 'armv8-a',
        'profiles': {p.name: sha256(p) for p in (NATIVE / 'profiles').iterdir()},
        'features': {'externalWindow': True, 'embeddedPreview': capabilities.get('previewProtocol') == 1},
        'capabilities': capabilities}
    notices = {'jbig2dec-COPYING': mupdf / 'thirdparty/jbig2dec/COPYING'} if args.bundled_jbig2dec else {}
    if args.bundled_harfbuzz:
        notices['harfbuzz-COPYING'] = mupdf / 'thirdparty/harfbuzz/COPYING'
    metadata['mupdfSubmodules'] = submodules
    bundle([txp / 'build/texpresso', txp / 'build/texpresso-xetex'], args.output, metadata, {
        'texpresso-LICENSE': txp / 'LICENSE', 'mupdf-COPYING': mupdf / 'COPYING',
        'lcms2-LICENSE': mupdf / 'thirdparty/lcms2/LICENSE', 'zlib-ng-LICENSE': zng_notice,
        'icu-LICENSE': args.icu_prefix / 'share/icu' / lock['icu']['version'] / 'LICENSE', **notices}, maximum_glibc=args.maximum_glibc)
    if not args.keep_work:
        shutil.rmtree(work)
        print('Removed successful build workspace:', work)


if __name__ == '__main__':
    main()
