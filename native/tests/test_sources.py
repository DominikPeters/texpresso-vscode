import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from common import run
from source_snapshot import snapshot
from release_sources import copy_notices, create_archive
from verify_sources import verify_archive


class CorrespondingSource(unittest.TestCase):
    def test_snapshot_retains_exact_commit_and_unchanged_files_without_credentials_or_old_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, target = root / 'source', root / 'snapshot'
            run(['git', 'init', '-q', source])
            run(['git', 'config', 'user.name', 'Source Test'], cwd=source)
            run(['git', 'config', 'user.email', 'source@example.invalid'], cwd=source)
            (source / 'retained.c').write_text('unchanged source\n')
            (source / 'deleted-secret').write_text('unrelated prior history\n')
            run(['git', 'add', '.'], cwd=source)
            run(['git', 'commit', '-qm', 'first'], cwd=source)
            parent = run(['git', 'rev-parse', 'HEAD'], cwd=source, capture=True)
            old_blob = run(['git', 'rev-parse', 'HEAD:deleted-secret'], cwd=source, capture=True)
            (source / 'deleted-secret').unlink()
            (source / 'new.c').write_text('current source\n')
            run(['git', 'add', '-A'], cwd=source)
            run(['git', 'commit', '-qm', 'second'], cwd=source)
            run(['git', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: secret-ci-token'], cwd=source)
            revision = run(['git', 'rev-parse', 'HEAD'], cwd=source, capture=True)
            run(['git', 'gc', '--quiet'], cwd=source)
            target.mkdir()  # Empty gitlink directories are valid destinations.
            snapshot(source, target, revision)
            self.assertEqual(run(['git', 'rev-parse', 'HEAD'], cwd=target, capture=True), revision)
            self.assertEqual((target / 'retained.c').read_text(), 'unchanged source\n')
            self.assertFalse((target / 'deleted-secret').exists())
            self.assertNotIn('secret-ci-token', (target / '.git/config').read_text())
            self.assertNotEqual(subprocess.run(['git', 'cat-file', '-e', parent], cwd=target, capture_output=True).returncode, 0)
            self.assertNotEqual(subprocess.run(['git', 'cat-file', '-e', old_blob], cwd=target, capture_output=True).returncode, 0)
            self.assertEqual(run(['git', 'status', '--porcelain'], cwd=target, capture=True), '')

    def test_source_notices_include_british_spelling_and_actual_freetype_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / 'source', Path(temporary) / 'notices'
            (source / 'docs').mkdir(parents=True)
            (source / 'LICENCE').write_text('PCRE2 actual license text')
            (source / 'docs/FTL.TXT').write_text('FreeType actual license text')
            (source / 'README.ijg').write_text('Copyright and permission terms in an IJG-style README')
            (source / 'credit.c').write_bytes(b'/* Copyright \xa9 contributor; licensed under MIT. */\nint example;\n')
            copy_notices(source, output)
            self.assertEqual((output / 'LICENCE').read_text(), 'PCRE2 actual license text')
            self.assertEqual((output / 'docs/FTL.TXT').read_text(), 'FreeType actual license text')
            self.assertIn('permission terms', (output / 'README.ijg').read_text())
            self.assertIn('© contributor', (output / 'SOURCE-HEADERS.txt').read_text())

    def test_source_archive_inventory_detects_omissions_and_different_release_identities(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / 'payload'
            for name in ['BUILDING.txt', 'THIRD-PARTY-NOTICES.txt', 'project/package.json', 'project/package-lock.json',
                         'project/THIRD-PARTY-NOTICES.txt', 'project/licenses/tmp-MIT.txt', 'project/licenses/wsl-path-MIT.txt']:
                file = payload / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('source fixture')
            manifest = {'version': '2.0.0', 'extensionRevision': '1' * 40, 'target': 'universal', 'components': []}
            archive = root / 'sources.tar.gz'
            info = create_archive(payload, archive, manifest)
            verify_archive(archive, info)
            with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                verify_archive(archive, {**info, 'extensionRevision': '2' * 40})
            manifest['files'].pop()
            (payload / 'SOURCE-MANIFEST.json').write_text(json.dumps(manifest))
            with tarfile.open(archive, 'w:gz') as tar:
                tar.add(payload, arcname='texpresso-sources')
            from common import sha256
            info.update(sha256=sha256(archive), bytes=archive.stat().st_size)
            with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
                verify_archive(archive, info)
