import json
import platform
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import bundle_linux
from common import run, sha256


class ElfDependencies(unittest.TestCase):
    def test_only_glibc_is_left_to_the_host(self):
        output = 'linux-vdso.so.1 (0x123)\nlibc.so.6 => /lib/libc.so.6 (0x123)\n' + \
                 'libstdc++.so.6 => /usr/lib/libstdc++.so.6 (0x123)\n/lib64/ld-linux-x86-64.so.2 (0x123)'
        with patch.object(bundle_linux, 'run', return_value=output):
            self.assertEqual(set(bundle_linux.libraries(Path('/fixture'))), {'libstdc++.so.6'})

    def test_missing_libraries_fail_the_build(self):
        with patch.object(bundle_linux, 'run', return_value='libmissing.so => not found'):
            with self.assertRaisesRegex(ValueError, 'unresolved dependency'):
                bundle_linux.libraries(Path('/fixture'))

    @unittest.skipUnless(platform.system() == 'Linux' and shutil.which('patchelf'), 'Linux relocation acceptance')
    def test_bundle_runs_after_original_library_and_build_directory_are_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = root / 'build'
            build.mkdir()
            (build / 'library.c').write_text('int value(void) { return 41; }')
            (build / 'main.c').write_text('#include <stdio.h>\nint value(void); int main(void) { printf("%d\\n", value()); }')
            run(['cc', '-shared', '-fPIC', build / 'library.c', '-Wl,-soname,libfixture.so', '-o', build / 'libfixture.so'])
            run(['cc', build / 'main.c', '-L' + str(build), '-lfixture', '-Wl,-rpath,' + str(build), '-o', build / 'texpresso'])
            shutil.copyfile(build / 'texpresso', build / 'texpresso-xetex')
            notice = root / 'LICENSE'
            notice.write_text('fixture notice')
            destination = root / 'bundle'
            with patch.object(bundle_linux, 'package_notice', return_value='fixture-source\t1'):
                bundle_linux.bundle([build / 'texpresso', build / 'texpresso-xetex'], destination, {}, {'LICENSE': notice})
            shutil.rmtree(build)
            moved = root / 'relocated bundle'
            destination.rename(moved)
            self.assertEqual(run([moved / 'bin/texpresso'], capture=True), '41')
            manifest = json.loads((moved / 'build-manifest.json').read_text())
            for entry in manifest['files']:
                self.assertEqual(sha256(moved / entry['path']), entry['sha256'])
