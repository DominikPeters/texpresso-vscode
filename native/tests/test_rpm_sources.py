import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from release_sources import rpm_sources, mupdf_submodules


class RpmSources(unittest.TestCase):
    def test_exact_signed_srpm_retains_recipe_sources_and_notices_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); host = root/'host'; host.mkdir(); notices = root/'notices'
            calls = []
            def run(args, **kwargs):
                calls.append(args)
                if args[0] == 'dnf':
                    (Path(args[4])/'fixture-1.2-3.el8.src.rpm').write_bytes(b'original signed sources')
                elif args[0] == 'rpmkeys':
                    return 'Header V4 RSA/SHA256 Signature, key ID abc12345: OK\nHeader SHA256 digest: OK'
                elif args[:2] == ['rpm', '-qp']:
                    return 'fixture\t1.2-3.el8\tsrc'
                elif args[:2] == ['rpm', '-i']:
                    top = Path(args[4].removeprefix('_topdir ')); (top/'SOURCES').mkdir(); (top/'SPECS').mkdir()
                    (top/'SPECS/fixture.spec').write_text('original RPM build recipe')
                    with tarfile.open(top/'SOURCES/fixture.tar.gz', 'w:gz') as archive:
                        data = b'Copyright fixture; permission to redistribute.'
                        item = tarfile.TarInfo('fixture/COPYING'); item.size = len(data)
                        archive.addfile(item, io.BytesIO(data))
            package = 'libfixture.x86_64\t0:1.2-3.el8\tfixture\t1.2-3.el8'
            with patch('release_sources.run', side_effect=run):
                component = rpm_sources(package, host, notices)
                self.assertIsNone(rpm_sources(package.replace('libfixture.', 'fixture-devel.'), host, notices))
            self.assertIn(['rpmkeys', '--checksig', '--verbose', host/'fixture-1.2-3.el8/fixture-1.2-3.el8.src.rpm'], calls)
            self.assertEqual(component['sourceRpmSigningKeys'], ['abc12345'])
            self.assertEqual(calls[0][-1], 'libfixture-0:1.2-3.el8.x86_64')
            self.assertEqual(component['version'], '1.2-3.el8')
            self.assertTrue((root/component['sourceRpm'].replace('host-sources/', 'host/')).is_file())
            self.assertEqual((host/'fixture-1.2-3.el8/fixture.spec').read_text(), 'original RPM build recipe')
            self.assertTrue(any(p.name == 'COPYING' for p in notices.rglob('*')))

    def test_different_downloaded_version_and_failed_signature_are_rejected(self):
        for signature_error in [False, True]:
            with self.subTest(signature_error=signature_error), tempfile.TemporaryDirectory() as temporary:
                host = Path(temporary)
                def run(args, **kwargs):
                    if args[0] == 'dnf':
                        (Path(args[4])/'fixture.src.rpm').write_bytes(b'wrong source')
                    if args[0] == 'rpmkeys' and signature_error:
                        raise ValueError('untrusted signature')
                    if args[0] == 'rpmkeys':
                        return 'Header V4 RSA/SHA256 Signature, key ID abc12345: OK'
                    if args[:2] == ['rpm', '-qp']:
                        return 'fixture\t1.3-1.el8\tsrc'
                with patch('release_sources.run', side_effect=run), self.assertRaises(ValueError):
                    rpm_sources('fixture.x86_64\t0:1.2-3.el8\tfixture\t1.2-3.el8', host, host/'notices')

    def test_digest_only_unsigned_rpm_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            host = Path(temporary)
            def run(args, **kwargs):
                if args[0] == 'dnf':
                    (Path(args[4])/'fixture.src.rpm').write_bytes(b'unsigned source')
                if args[0] == 'rpmkeys':
                    return 'Header SHA256 digest: OK\nPayload SHA256 digest: OK'
            with patch('release_sources.run', side_effect=run), self.assertRaisesRegex(ValueError, 'no verified signature'):
                rpm_sources('fixture.x86_64\t0:1.2-3.el8\tfixture\t1.2-3.el8', host, host/'notices')

    def test_unsafe_identity_is_rejected_before_download(self):
        with patch('release_sources.run') as run, self.assertRaisesRegex(ValueError, 'Invalid RPM'):
            rpm_sources('fixture.x86_64\t0:1.2-3\t../../outside\t1.2-3', Path('/unused'), Path('/unused'))
        run.assert_not_called()

    def test_extra_mupdf_sources_must_match_the_parent_gitlink(self):
        lock = {'mupdf': {'submodules': {'thirdparty/lcms2': '1'*40}}}
        native = {'mupdfSubmodules': {'thirdparty/lcms2': '1'*40, 'thirdparty/harfbuzz': '2'*40}}
        with patch('release_sources.run', return_value='160000 commit '+'3'*40+'\tthirdparty/lcms2'), self.assertRaisesRegex(ValueError, 'identity mismatch'):
            mupdf_submodules(Path('/source'), native, lock)
