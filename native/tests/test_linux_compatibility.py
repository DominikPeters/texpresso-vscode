import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from audit_linux import required_glibc, version, check_isa


class LinuxCompatibility(unittest.TestCase):
    def test_only_needed_versions_count_not_exported_definitions(self):
        text = '''Version definition section '.gnu.version_d':
        Name: GLIBC_2.40
        Version needs section '.gnu.version_r':
        Name: GLIBC_2.2.5 Flags: none
        Name: GLIBCXX_3.4.30 Flags: none
        Name: GLIBC_2.28 Flags: none
        Name: GLIBC_2.3 Flags: none'''
        self.assertEqual(required_glibc(text), ['2.2.5', '2.3', '2.28'])
        self.assertEqual(required_glibc('No version information found'), [])
        self.assertEqual(version('2.28'), version('2.28.0'))
        self.assertLess(version('2.9'), version('2.28'))

    def test_private_and_new_non_numeric_abi_requirements_are_rejected(self):
        for name in ['GLIBC_PRIVATE', 'GLIBC_ABI_DT_RELR']:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'glibc ABI'):
                required_glibc('Version needs section:\n Name: ' + name)

    def test_declared_x64_v2_v3_v4_dependencies_are_not_baseline(self):
        check_isa('x86 ISA needed: x86-64-baseline', 'x86_64')
        check_isa('x86 ISA used: x86-64-v3', 'x86_64')  # dispatched implementations are allowed
        for level in [2, 3, 4]:
            with self.assertRaisesRegex(ValueError, 'ISA newer'):
                check_isa(f'x86 ISA needed: x86-64-baseline, x86-64-v{level}', 'x86_64')

class FullClosureAudit(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith('linux'), 'ELF linker fixture')
    def test_newer_requirement_hidden_in_a_bundled_library_fails(self):
        import shutil
        import subprocess
        import tempfile
        from audit_linux import audit
        if not shutil.which('cc') or not shutil.which('readelf'):
            self.skipTest('C compiler and readelf required')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'bin').mkdir(); (root/'lib').mkdir()
            (root/'provider.c').write_text('int value(void) { return 1; }')
            (root/'consumer.c').write_text('int value(void); int consume(void) { return value(); }')
            (root/'main.c').write_text('int main(void) { return 0; }')
            (root/'versions').write_text('GLIBC_9.99 { global: value; };')
            def cc(*args):
                subprocess.run(['cc', *map(str, args)], check=True)
            cc('-shared', '-fPIC', root/'provider.c', '-Wl,--version-script='+str(root/'versions'), '-o', root/'lib/libprovider.so')
            cc('-shared', '-fPIC', root/'consumer.c', '-L'+str(root/'lib'), '-lprovider', '-o', root/'lib/libconsumer.so')
            cc(root/'main.c', '-o', root/'bin/texpresso')
            shutil.copyfile(root/'bin/texpresso', root/'bin/texpresso-xetex')
            import platform
            arch = 'arm64' if platform.machine() == 'aarch64' else 'x86_64'
            with self.assertRaisesRegex(ValueError, 'libconsumer.*GLIBC_9.99'):
                audit(root, '2.99', arch)

class RpmNotices(unittest.TestCase):
    def test_exact_source_identity_and_installed_license_payload_are_retained(self):
        import tempfile
        from unittest.mock import patch
        from bundle_linux import rpm_notice
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); license_file = root/'COPYING'; license_file.write_text('actual license')
            notices = root/'notices'; notices.mkdir()
            def run(args, **kwargs):
                if args[1] == '-qf':
                    return 'libfixture.x86_64\t0:1.2-3.el8\tfixture-source-1.2-3.el8.src.rpm'
                return str(license_file)+'\t128\n/usr/lib64/libfixture.so\t0'
            with patch('bundle_linux.run', side_effect=run):
                identity = rpm_notice(root/'libfixture.so', notices)
            self.assertEqual(identity.split('\t')[2:], ['fixture-source', '1.2-3.el8'])
            saved = notices/'libfixture.x86_64'/license_file.relative_to('/')
            self.assertEqual(saved.read_text(), 'actual license')
