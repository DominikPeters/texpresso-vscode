"""Build the locked native-API PNG compressor from supplied sources, offline."""
import shlex
from common import check_source, export_source, load_lock, run, sha256


def make_flags(values):
    return shlex.join([str(v) for v in values]).replace('$', '$$').replace('#', '\\#')


def verify_capabilities(capabilities):
    compression = capabilities.get('pngCompression', {})
    if compression.get('library') != 'zlib-ng' or compression.get('level') != 2 or compression.get('version') != load_lock()['zlibNg']['version']:
        raise ValueError('Bundled PNG encoder must use locked zlib-ng at level 2')


def build(source, work, jobs, cflags=()):
    lock = load_lock()['zlibNg']
    check_source(source, lock['revision'])
    exported, output = work / 'source', work / 'build'
    export_source(source, exported)
    run(['cmake', '-S', exported, '-B', output, '-DCMAKE_BUILD_TYPE=Release',
         '-DCMAKE_POSITION_INDEPENDENT_CODE=ON', '-DZLIB_COMPAT=OFF',
         '-DBUILD_SHARED_LIBS=OFF', '-DBUILD_TESTING=OFF', '-DWITH_GTEST=OFF',
         '-DWITH_GZFILEOP=OFF', '-DWITH_NATIVE_INSTRUCTIONS=OFF', '-DWITH_RUNTIME_CPU_DETECTION=ON',
         *(['-DCMAKE_C_FLAGS=' + shlex.join(cflags)] if cflags else [])])
    run(['cmake', '--build', output, '--parallel', str(jobs)])
    library = output / 'libz-ng.a'
    metadata = {'version': lock['version'], 'revision': lock['revision'],
                'api': 'native', 'linkage': 'static', 'pngLevel': 2,
                'librarySha256': sha256(library)}
    return output, library, exported / 'LICENSE.md', metadata
