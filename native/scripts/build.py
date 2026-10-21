#!/usr/bin/env python3
"""Build the compact macOS engine from pinned/local inputs, without downloads."""
import argparse
import json
import os
import platform
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from common import NATIVE, ROOT, check_source, export_source, load_lock, pinned_engine, run, sha256
from icu_data import prepare
from bundle import bundle


def shell_flags(values):
    # These values are parsed once by make and once by the recipe's shell.
    return shlex.join([str(v) for v in values]).replace('$', '$$').replace('#', '\\#')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mupdf-source', type=Path, required=True)
    parser.add_argument('--icu-prefix', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=NATIVE / '.bundles' / ('darwin-' + platform.machine()))
    parser.add_argument('--jobs', type=int, default=min(os.cpu_count() or 2, 8))
    parser.add_argument('--check', action='store_true', help='validate inputs without compiling')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or platform.machine() not in ('arm64', 'x86_64'):
        parser.error('The initial bundle builder supports native macOS arm64/x86_64 hosts')
    if args.jobs < 1:
        parser.error('--jobs must be positive')
    args.mupdf_source = args.mupdf_source.resolve()
    args.icu_prefix = args.icu_prefix.resolve()
    args.output = args.output.resolve()
    lock = load_lock()
    engine, revision = pinned_engine()
    check_source(args.mupdf_source, lock['mupdf']['revision'])
    for path, sha in lock['mupdf']['submodules'].items():
        check_source(args.mupdf_source / path, sha)
    for command in ('make', 'pkg-config', 'xcrun', 'otool', 'install_name_tool', 'codesign', 'strip'):
        if not shutil.which(command):
            parser.error(f'Missing build tool: {command}')
    packages = ['freetype2', 'libjpeg', 'libopenjp2', 'libbrotlidec', 'libbrotlienc',
                'sdl2', 'harfbuzz', 'graphite2', 'fontconfig', 'libpng']
    versions = {p: run(['pkg-config', '--modversion', p], capture=True) for p in packages}
    version_header = (args.icu_prefix / 'include/unicode/uvernum.h').read_text()
    if f'#define U_ICU_VERSION "{lock["icu"]["version"]}"' not in version_header:
        parser.error('Installed ICU does not match dependencies.lock.json')
    if args.check:
        print(json.dumps({'engine': revision, 'mupdf': lock['mupdf']['revision'],
                          'icu': lock['icu']['version'], 'hostPackages': versions}, indent=2))
        return
    if args.output.exists() or args.output.with_suffix('.zip').exists():
        parser.error('Output already exists; choose a new --output directory')
    work_root = NATIVE / '.work'
    work_root.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='build-', dir=work_root))
    print('Build directory:', work, flush=True)
    txp = work / 'texpresso'
    mupdf = work / 'mupdf'
    export_source(engine, txp)
    export_source(args.mupdf_source, mupdf)
    for path in lock['mupdf']['submodules']:
        (mupdf / path).rmdir()  # git archive leaves an empty gitlink directory.
        export_source(args.mupdf_source / path, mupdf / path)
    shutil.copyfile(NATIVE / 'profiles/mupdf.mk', mupdf / 'user.make')
    compiler = run(['xcrun', '--find', 'clang'], capture=True)
    cxx = run(['xcrun', '--find', 'clang++'], capture=True)
    sdk = run(['xcrun', '--sdk', 'macosx', '--show-sdk-path'], capture=True)
    codec_flags = shlex.split(run(['pkg-config', '--cflags', 'freetype2', 'libjpeg',
                                  'libopenjp2', 'libbrotlidec', 'libbrotlienc'], capture=True))
    # Homebrew has no pkg-config files for some of the small codecs.
    host_prefix = Path(run(['pkg-config', '--variable=prefix', 'sdl2'], capture=True)).parents[1]
    if not (host_prefix / 'include/jbig2.h').exists():
        host_prefix = Path(run(['brew', '--prefix'], capture=True))
    include_flags = ['-isysroot', sdk, '-I' + str(mupdf / 'include'),
                     '-I' + str(host_prefix / 'include')] + codec_flags
    run(['make', f'-j{args.jobs}', 'libs', 'OUT=build/vscode', 'CC=' + compiler,
         'XCFLAGS=' + shell_flags(include_flags)], cwd=mupdf)
    data_object, icu_metadata = prepare(args.icu_prefix, work / 'icu', lock['icu']['version'])
    renderer_libraries = shlex.split(run(['pkg-config', '--libs', 'freetype2', 'libjpeg',
                                         'libopenjp2', 'libbrotlidec', 'libbrotlienc', 'sdl2'], capture=True))
    renderer_libraries = [mupdf / 'build/vscode/libmupdf.a', mupdf / 'build/vscode/libmupdf-third.a'] + renderer_libraries
    renderer_libraries += ['-L' + str(host_prefix / 'lib'), '-ljbig2dec', '-lz', '-lm']
    cflags = ['-O2', '-fPIC', '-ffunction-sections', '-fdata-sections', '-I.',
              '-I' + str(mupdf / 'include')] + include_flags
    (txp / 'Makefile.config').write_text(
        'CFLAGS=' + shell_flags(cflags) + '\nCC=' + shell_flags([compiler]) + ' $(CFLAGS)\n' +
        'LDCC=' + shell_flags([cxx]) + ' $(CFLAGS) -Wl,-dead_strip\nLIBS=' + shell_flags(renderer_libraries) + '\n')
    run(['make', 'common'], cwd=txp)
    # Preserve upstream's source lists and build rules; replace only the ICU
    # linkage rather than maintaining a copied list of engine object files.
    system_libraries = [args.icu_prefix / 'lib/libicuuc.a', data_object]
    for name in ('Foundation', 'CoreFoundation', 'CoreGraphics', 'CoreText', 'AppKit'):
        system_libraries += ['-framework', name]
    run(['make', f'-j{args.jobs}', 'all', '_CC=' + compiler, '_CXX=' + cxx, '_LD=' + cxx,
         '_FLAGS=-ffunction-sections -fdata-sections',
         '_LDFLAGS=' + shell_flags(['-isysroot', sdk, '-Wl,-dead_strip']),
         'LDSYSFLAGS=' + shell_flags(system_libraries),
         'CSYSFLAGS=' + shell_flags(['-isysroot', sdk, '-DXETEX_MAC',
                                    '-I' + str(args.icu_prefix / 'include'),
                                    '-I' + str(host_prefix / 'include'), '-fno-common'])], cwd=txp)
    probe = subprocess.run([str(txp / 'build/texpresso'), '-capabilities'], capture_output=True, text=True, timeout=5)
    try:
        capabilities = json.loads(probe.stdout) if probe.returncode == 0 else {}
    except ValueError:
        capabilities = {}
    if not isinstance(capabilities, dict):
        capabilities = {}
    metadata = {'schema': 1, 'kind': 'development-host-build', 'platform': 'darwin',
                'architecture': platform.machine(), 'engineRevision': revision,
                'mupdfRevision': lock['mupdf']['revision'], 'icu': icu_metadata,
                'compiler': run([compiler, '--version'], capture=True).splitlines()[0],
                'sdk': Path(sdk).name,
                'hostPackageVersions': versions,
                'profiles': {p.name: sha256(p) for p in (NATIVE / 'profiles').iterdir()},
                'features': {'externalWindow': True, 'embeddedPreview': capabilities.get('previewProtocol') == 1},
                'capabilities': capabilities}
    notices = {'texpresso-LICENSE': txp / 'LICENSE', 'mupdf-COPYING': mupdf / 'COPYING',
               'lcms2-LICENSE': mupdf / 'thirdparty/lcms2/LICENSE',
               'icu-LICENSE': args.icu_prefix / 'share/icu' / lock['icu']['version'] / 'LICENSE'}
    bundle([txp / 'build/texpresso', txp / 'build/texpresso-xetex'], args.output, metadata, notices)


if __name__ == '__main__':
    main()
