#!/usr/bin/env python3
"""Verify source archives without extracting them or loading them into memory."""
import argparse
import hashlib
import json
import tarfile
from pathlib import Path, PurePosixPath
from common import ROOT, run, sha256

TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'universal']


def verify_archive(filename, info):
    if sha256(filename) != info['sha256'] or filename.stat().st_size != info['bytes']:
        raise ValueError('Corresponding source checksum mismatch')
    observed = {}
    links = {}
    seen = set()
    manifest = None
    binary_manifest = None
    with tarfile.open(filename, mode='r|gz') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or path.parts[0] != 'texpresso-sources':
                raise ValueError('Unsafe source archive path')
            if member.isdir():
                continue
            name = '/'.join(path.parts[1:])
            if name in seen:
                raise ValueError('Duplicate source archive entry')
            seen.add(name)
            if member.issym():
                # Preserve source symlinks, but prohibit archive traversal.
                target = PurePosixPath(member.linkname)
                depth = len(path.parts) - 2
                if target.is_absolute():
                    raise ValueError('Absolute source symlink')
                for part in target.parts:
                    depth += -1 if part == '..' else 0 if part == '.' else 1
                    if depth < 0:
                        raise ValueError('Escaping source symlink')
                links[name] = member.linkname
                continue
            if not member.isfile() or name in observed:
                raise ValueError('Invalid or duplicate source archive entry')
            stream = archive.extractfile(member)
            if name == 'SOURCE-MANIFEST.json':
                if manifest is not None or member.size > 32 * 1024 * 1024:
                    raise ValueError('Invalid source manifest')
                manifest = json.load(stream)
                continue
            digest = hashlib.sha256()
            if name == 'BINARY-BUILD-MANIFEST.json':
                if member.size > 4 * 1024 * 1024:
                    raise ValueError('Native build manifest is too large')
                data = stream.read()
                binary_manifest = json.loads(data)
                digest.update(data)
            else:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            observed[name] = {'sha256': digest.hexdigest(), 'bytes': member.size}
    if not manifest:
        raise ValueError('Source manifest missing')
    declared = {entry['path']: {'sha256': entry['sha256'], 'bytes': entry['bytes']} for entry in manifest['files']}
    if len(declared) != len(manifest['files']) or declared != observed:
        raise ValueError('Source manifest file inventory mismatch')
    declared_links = {entry['path']: entry['target'] for entry in manifest.get('links', [])}
    if len(declared_links) != len(manifest.get('links', [])) or declared_links != links:
        raise ValueError('Source symlink inventory mismatch')
    for key in ['version', 'extensionRevision', 'target']:
        if manifest[key] != info[key]:
            raise ValueError('Source identity mismatch: ' + key)
    required = {'BUILDING.txt', 'THIRD-PARTY-NOTICES.txt', 'project/package.json', 'project/package-lock.json',
                'project/THIRD-PARTY-NOTICES.txt', 'project/licenses/tmp-MIT.txt', 'project/licenses/wsl-path-MIT.txt'}
    if manifest['target'] != 'universal':
        if manifest.get('engineRevision') != info['engineRevision']:
            raise ValueError('Source engine revision mismatch')
        required |= {'BINARY-BUILD-MANIFEST.json', 'project/native/texpresso/LICENSE',
                     'inputs/mupdf/COPYING', 'inputs/zlib-ng/LICENSE.md', 'notices/engine/EMBEDDED-COPYRIGHTS.txt',
                     'notices/AGPL-3.0.txt', 'notices/GPL-2.0.txt', 'notices/GPL-3.0.txt', 'notices/LGPL-2.1.txt',
                     'notices/COMPONENTS.json'}
        names = {component['name'] for component in manifest['components']}
        if not {'mupdf', 'lcms2', 'zlib-ng'} <= names or not {'icu', 'icu4c@78'} & names:
            raise ValueError('Incomplete native source component inventory')
        if not binary_manifest or binary_manifest['engineRevision'] != info['engineRevision']:
            raise ValueError('Native source build provenance mismatch')
        identities = {(p['name'], p.get('version')) for p in manifest['components']}
        for package in binary_manifest['hostLibraries']:
            if isinstance(package, dict):
                expected = (package['package'], package['version'])
            else:
                binary, binary_version, source, version = package.split('\t')
                expected = (source or binary.split(':')[0], version or binary_version)
            if expected not in identities:
                raise ValueError('Missing exact runtime library sources: ' + str(expected))
    for component in manifest['components']:
        if 'sourceDirectory' in component:
            prefix = component['sourceDirectory'].rstrip('/') + '/'
            if not any(name.startswith(prefix) for name in observed):
                raise ValueError('Source component directory is empty')
        if 'source' in component and component['source'] not in observed:
            raise ValueError('Source component archive is missing')
    if not required <= observed.keys():
        raise ValueError('Incomplete corresponding sources: ' + ', '.join(sorted(required - observed.keys())))
    return manifest


def verify_set(directory, root=ROOT, targets=TARGETS):
    version = json.loads((root / 'package.json').read_text())['version']
    extension = run(['git', 'rev-parse', 'HEAD'], cwd=root, capture=True)
    engine = run(['git', 'rev-parse', ':native/texpresso'], cwd=root, capture=True)
    for target in targets:
        filename = directory / f'texpresso-{version}-sources-{target}.tar.gz'
        info = json.loads(Path(str(filename) + '.json').read_text())
        expected_url = f'https://github.com/DominikPeters/texpresso-vscode/releases/download/v{version}/{filename.name}'
        if (info['name'] != filename.name or info['target'] != target or info['version'] != version or
                info['extensionRevision'] != extension or info['url'] != expected_url or
                (target != 'universal' and info['engineRevision'] != engine)):
            raise ValueError('Corresponding source release identity mismatch')
        if Path(str(filename) + '.sha256').read_text().split()[0] != info['sha256']:
            raise ValueError('Source checksum sidecar mismatch')
        verify_archive(filename, info)
        print('Verified corresponding sources: ' + filename.name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--target', choices=TARGETS)
    args = parser.parse_args()
    verify_set(args.directory, args.root, [args.target] if args.target else TARGETS)
