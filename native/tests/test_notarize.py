import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import notarize
from common import sha256


class Signing(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'adhoc'
        self.paths = ['bin/texpresso', 'bin/texpresso-xetex', 'lib/example.dylib']
        for name in self.paths:
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(bytes.fromhex('cffaedfe') + b'unsigned')
            file.chmod(0o755)
        (self.source / 'build-manifest.json').write_text(json.dumps({'files': [
            {'path': name, 'sha256': sha256(self.source / name), 'bytes': (self.source / name).stat().st_size}
            for name in self.paths]}))

    def test_sign_every_library_before_executables_and_refresh_archive_hashes(self):
        calls = []
        def run(args, **options):
            calls.append(args)
            if args[:2] == ['security', 'find-identity']:
                return subprocess.CompletedProcess(args, 0, '  1) ' + 'A' * 40 + ' \"Developer ID Application: Test\"', '')
            if '--force' in args:
                file = args[-1]
                file.write_bytes(file.read_bytes() + b'-signed')
                self.assertIn('--timestamp', args)
                self.assertEqual(args[args.index('--options') + 1], 'runtime')
            details = 'Authority=Developer ID Application: Test\nTeamIdentifier=TEAM\nTimestamp=Oct 22 2026\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=2\n'
            return subprocess.CompletedProcess(args, 0, '', details)
        with patch.object(notarize, 'command', side_effect=run):
            output = notarize.sign_bundle(self.source, self.root / 'signed', 'IDENTITY', 'KEYCHAIN')
        signed = [str(c[-1].relative_to(self.root / 'signed')) for c in calls if '--force' in c]
        self.assertEqual(signed, ['lib/example.dylib', 'bin/texpresso', 'bin/texpresso-xetex'])
        self.assertEqual(sum('--verify' in c for c in calls), 3)
        with zipfile.ZipFile(output) as archive:
            manifest = json.loads(archive.read('build-manifest.json'))
            self.assertEqual(manifest['signing']['teamId'], 'TEAM')
            for file in manifest['files']:
                target = self.root / 'signed' / file['path']
                self.assertEqual(file['sha256'], sha256(target))
                self.assertEqual(file['bytes'], len(archive.read(file['path'])))
                self.assertTrue(archive.read(file['path']).endswith(b'-signed'))
                self.assertTrue((archive.getinfo(file['path']).external_attr >> 16) & 0o111)
        self.assertTrue((self.source / self.paths[0]).read_bytes().endswith(b'unsigned'))

    def test_reject_unmanifested_and_modified_binaries_before_signing(self):
        extra = self.source / 'lib/unlisted.dylib'
        extra.write_bytes(b'anything')
        with self.assertRaisesRegex(ValueError, 'every bundled library'):
            notarize.bundle_inputs(self.source)
        extra.unlink()
        (self.source / self.paths[0]).write_bytes(bytes.fromhex('cffaedfe') + b'modified')
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            notarize.bundle_inputs(self.source)

    def test_reject_adhoc_or_untimestamped_signatures(self):
        result = subprocess.CompletedProcess([], 0, '', 'TeamIdentifier=TEAM\nCodeDirectory flags=0x0(none)\n')
        with patch.object(notarize, 'imported_identity', return_value='IDENTITY'), patch.object(notarize, 'command', return_value=result), self.assertRaisesRegex(ValueError, 'timestamped Developer ID'):
            notarize.sign_bundle(self.source, self.root / 'signed', 'IDENTITY', 'KEYCHAIN')
        self.assertFalse((self.root / 'signed.zip').exists())

    def test_accept_only_explicit_apple_acceptance_and_preserve_timeout_id(self):
        archive = self.root / 'signed.zip'
        archive.write_bytes(b'archive')
        for status, code in [('Accepted', 0), ('Invalid', 0), ('In Progress', 1)]:
            reports = self.root / status
            checksum = archive.with_suffix('.zip.sha256')
            checksum.unlink(missing_ok=True)
            calls = []
            def run(args, **options):
                calls.append(args)
                value = {'id': 'submission-123', 'status': status} if args[2] == 'wait' else {'id': 'submission-123'}
                return subprocess.CompletedProcess(args, code if args[2] == 'wait' else 0, json.dumps(value), '')
            with self.subTest(status=status), patch.object(notarize, 'command', side_effect=run):
                if status == 'Accepted':
                    notarize.notarize(archive, reports, 'KEYCHAIN', '20m')
                    self.assertTrue(checksum.is_file())
                else:
                    with self.assertRaisesRegex(RuntimeError, 'has not accepted'):
                        notarize.notarize(archive, reports, 'KEYCHAIN', '20m')
                    self.assertFalse(checksum.exists())
                self.assertEqual(json.loads((reports / 'submission.json').read_text())['id'], 'submission-123')
                self.assertTrue(any(c[2] == 'log' for c in calls))
                self.assertEqual(archive.read_bytes(), b'archive', 'submitted archive never changes afterward')

    def test_sensitive_failures_never_echo_argv_output_or_environment(self):
        result = subprocess.CompletedProcess([], 1, 'private-output', 'private-error')
        with patch.dict(os.environ, {'APPLE_CERTIFICATE_PASSWORD': 'secret-value'}), patch.object(notarize.subprocess, 'run', return_value=result) as run:
            with self.assertRaises(RuntimeError) as failure:
                notarize.command(['security', 'import', '-P', 'secret-value'], sensitive=True)
            self.assertNotIn('secret', str(failure.exception))
            self.assertNotIn('private', str(failure.exception))
            self.assertNotIn('APPLE_CERTIFICATE_PASSWORD', run.call_args.kwargs['env'])

    def test_keychain_and_private_files_removed_after_signing_failure(self):
        env = {name: 'test-value' for name in notarize.SECRETS}
        env['APPLE_CERTIFICATE'] = base64.b64encode(b'p12').decode()
        env['APPLE_API_PRIVATE_KEY'] = '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'
        env['RUNNER_TEMP'] = str(self.root)
        calls = []
        def run(args, **options):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, '', '')
        argv = ['notarize.py', '--bundle', str(self.source), '--output', str(self.root / 'signed'), '--reports', str(self.root / 'reports')]
        with patch.dict(os.environ, env), patch.object(sys, 'argv', argv), patch.object(notarize.platform, 'system', return_value='Darwin'), patch.object(notarize, 'command', side_effect=run), patch.object(notarize, 'sign_bundle', side_effect=ValueError('signing failed')):
            with self.assertRaisesRegex(ValueError, 'signing failed'):
                notarize.main()
        self.assertEqual(calls[-1][1], 'delete-keychain')
        self.assertFalse(list(self.root.glob('texpresso-sign-*')))

    def test_accept_plain_and_base64_p8_and_reject_invalid_secrets(self):
        pem = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n'
        self.assertEqual(notarize.private_key(pem), pem)
        self.assertEqual(notarize.private_key(base64.b64encode(pem.encode()).decode()), pem)
        with self.assertRaises(ValueError):
            notarize.private_key('invalid')
        with self.assertRaises(ValueError):
            notarize.binary_secret('invalid')

    def test_resolve_uploaded_certificate_and_fail_if_private_key_is_missing(self):
        fingerprint = 'A' * 40
        identity = 'Developer ID Application: Test (TEAM)'
        result = subprocess.CompletedProcess([], 0, f'  1) {fingerprint} "{identity}"\n 1 valid identities found', '')
        with patch.object(notarize, 'command', return_value=result):
            self.assertEqual(notarize.imported_identity(identity, 'KEYCHAIN'), fingerprint)
            self.assertEqual(notarize.imported_identity(fingerprint.lower(), 'KEYCHAIN'), fingerprint)
            self.assertEqual(notarize.imported_identity('stale name', 'KEYCHAIN'), fingerprint)
        with patch.object(notarize, 'command', return_value=subprocess.CompletedProcess([], 0, '0 valid identities found', '')):
            with self.assertRaisesRegex(ValueError, 'private key'):
                notarize.imported_identity(identity, 'KEYCHAIN')
