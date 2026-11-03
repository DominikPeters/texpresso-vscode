import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REVISION = '1' * 40


@unittest.skipUnless(shutil.which('node') and shutil.which('git'), 'Node and Git release verifier')
class ReleaseArtifacts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / 'artifacts'
        self.artifacts.mkdir()
        self.identity = {'publisher': 'DominikPeters', 'name': 'texpresso-basic', 'version': '2.0.0'}
        (self.root / 'package.json').write_text(json.dumps(self.identity))
        subprocess.run(['git', 'init', '-q', self.root], check=True)
        subprocess.run(['git', 'update-index', '--add', '--cacheinfo', f'160000,{REVISION},native/texpresso'], cwd=self.root, check=True)
        self.production = json.loads(subprocess.check_output(['node', '-e',
            'console.log(JSON.stringify(require(process.argv[1]).productionFiles))', str(ROOT / 'scripts/vsix-payload.cjs')]))
        for target in ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'universal']:
            self.write_artifact(target)

    def tearDown(self):
        self.temporary.cleanup()

    def write_artifact(self, target, revision=REVISION, signing='developer-id'):
        files = {'extension/' + ('readme.md' if p == 'README.md' else 'LICENSE.txt' if p == 'LICENSE' else p): b'fixture'
                 for p in self.production}
        files['extension/package.json'] = json.dumps(self.identity).encode()
        files['extension.vsixmanifest'] = (f'<Identity TargetPlatform="{target}"/>' if target != 'universal' else '<Identity/>').encode()
        executables = set()
        if target != 'universal':
            platform, architecture = target.rsplit('-', 1)
            prefix = f'extension/runtime/{target}/'
            entries = []
            for binary in ['bin/texpresso', 'bin/texpresso-xetex']:
                data = binary.encode()
                files[prefix + binary] = data
                executables.add(prefix + binary)
                entries.append({'path': binary, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
            files[prefix + 'notices/LICENSE'] = b'dependency license'
            files[prefix + 'build-manifest.json'] = json.dumps({'platform': platform, 'architecture': architecture,
                'engineRevision': revision, 'features': {'embeddedPreview': True}, 'capabilities': {'previewProtocol': 1},
                'signing': {'kind': signing, 'hardenedRuntime': True, 'secureTimestamp': True}, 'files': entries}).encode()
        filename = self.artifacts / f'texpresso-{target}.vsix'
        with zipfile.ZipFile(filename, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (0o100755 if name in executables else 0o100644) << 16
                archive.writestr(entry, data)
        Path(str(filename) + '.sha256').write_text(hashlib.sha256(filename.read_bytes()).hexdigest() + '  ' + filename.name + '\n')

    def verify(self):
        return subprocess.run(['node', '-e', 'require(process.argv[1]).verifyRelease(process.argv[2], process.argv[3])',
            str(ROOT / 'scripts/verify-release.cjs'), str(self.artifacts), str(self.root)], capture_output=True, text=True)

    def test_complete_release_is_accepted(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_target_and_tampered_archive_are_rejected(self):
        (self.artifacts / 'texpresso-linux-arm64.vsix').unlink()
        self.assertIn('complete release target set', self.verify().stderr)
        self.write_artifact('linux-arm64')
        with (self.artifacts / 'texpresso-linux-arm64.vsix').open('ab') as file:
            file.write(b'tampering')
        self.assertIn('checksum', self.verify().stderr)

    def test_unsigned_mac_and_wrong_engine_revision_are_rejected(self):
        self.write_artifact('darwin-arm64', signing='ad-hoc')
        self.assertIn('Developer ID', self.verify().stderr)
        self.write_artifact('darwin-arm64')
        self.write_artifact('linux-x64', revision='2' * 40)
        self.assertIn('engine pin', self.verify().stderr)
