#!/usr/bin/env python3
"""Collect corresponding sources and complete notices on release runners.

Network downloads require --fetch. This is separate from the offline builders.
"""
import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path
from common import ROOT, NATIVE, run, sha256, load_lock, pinned_engine, check_source
from source_snapshot import snapshot

REPOSITORY = 'https://github.com/DominikPeters/texpresso-vscode'
LEGAL = re.compile(r'^(?:licen[cs]e|copying|copyright|notice|authors|ftl|gpl|lgpl|ofl|apache)(?:[._-].*|\d.*)?$', re.I)
RUNTIME = {'tmp': '0.2.3', 'wsl-path': '4.0.0'}


def record(file, root):
    return {'path': file.relative_to(root).as_posix(), 'sha256': sha256(file), 'bytes': file.stat().st_size}


def download(url, destination, expected=None):
    if not url.startswith('https://'):
        raise ValueError('Release sources require HTTPS')
    # Release endpoints can transiently return 5xx; never relax integrity checks.
    run(['curl', '--fail', '--location', '--retry', '5', '--retry-all-errors',
         '--connect-timeout', '20', '--max-time', '300', '--output', destination, url])
    if expected and sha256(destination) != expected:
        raise ValueError('Downloaded source checksum mismatch')


def copy_notices(source, destination, required=True):
    """Read actual source notices, including British spelling and FTL/OFL files."""
    count = 0
    headers = {}
    for file in sorted(source.rglob('*')):
        relative = file.relative_to(source)
        if '.git' in relative.parts or file.is_symlink() or not file.is_file():
            continue
        legal_directory = any(part.lower() in ('license', 'licenses', 'licence', 'licences') for part in relative.parts[:-1])
        font_readme = any('font' in part.lower() for part in relative.parts[:-1]) and file.name.lower().startswith('readme')
        legal_readme = False
        if file.name.lower().startswith('readme'):
            with file.open(errors='replace') as content:
                legal_readme = any(re.search(r'copyright|licen[cs]e|permission|redistribut|public domain', line, re.I) for line in content)
        if LEGAL.match(file.name) or legal_directory or font_readme or legal_readme:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)
            count += 1
        if file.suffix.lower() in ('.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.mm', '.m', '.s', '.rs'):
            with file.open('rb') as content:
                raw = content.read(20000)
            try:
                text = raw.decode('utf8')
            except UnicodeDecodeError:
                text = raw.decode('latin1')
            blocks = re.findall(r'/\*.*?\*/', text, re.S) + re.findall(r'(?:^[ \t]*//[^\n]*(?:\n|$))+', text, re.M)
            for block in blocks:
                if re.search(r'copyright|licen[cs]e|public domain', block, re.I):
                    headers.setdefault(block.strip(), []).append(relative.as_posix())
    if headers:
        destination.mkdir(parents=True, exist_ok=True)
        (destination / 'SOURCE-HEADERS.txt').write_text('\n\n'.join(
            'Files:\n' + '\n'.join(names) + '\n\n' + block for block, names in headers.items()) + '\n')
        count += 1
    if not count and required:
        raise ValueError(f'No source license texts found for {source.name}')


def unpack_notices(archives, destination):
    with tempfile.TemporaryDirectory(prefix='txp-source-notices-') as temporary:
        root = Path(temporary)
        for number, archive in enumerate(archives):
            unpacked = root / str(number)
            unpacked.mkdir()
            if tarfile.is_tarfile(archive):
                with tarfile.open(archive) as tar:
                    tar.extractall(unpacked, filter='data')
            elif zipfile.is_zipfile(archive):
                with zipfile.ZipFile(archive) as zip:
                    for name in zip.namelist():
                        if name.startswith('/') or '..' in Path(name).parts:
                            raise ValueError('Unsafe source ZIP path')
                    zip.extractall(unpacked)
            else:
                continue  # Patches are preserved as sources, not extracted.
            # Some resource archives contain no legal text; the main source
            # and formula supply the component's notices in that case.
            copy_notices(unpacked, destination / archive.name, required=False)
    if not any(p.is_file() for p in destination.rglob('*')):
        raise ValueError('Downloaded sources contain no license texts')


def engine_notices(engine, destination):
    copy_notices(engine, destination)
    # Embedded XeTeX/Tectonic/dvipdfmx copyright grants live in file headers,
    # not the repository's top-level MIT license. Preserve those headers too.
    headers = []
    for file in sorted((engine / 'src').rglob('*')):
        if file.suffix not in ('.c', '.h', '.cpp', '.mm'):
            continue
        text = file.read_text(errors='replace')[:20000]
        match = re.match(r'\s*(/\*.*?\*/)', text, re.S)
        if match and re.search('copyright|licen[cs]e|public domain', match[1], re.I):
            headers.append(str(file.relative_to(engine)) + '\n' + match[1] + '\n')
    (destination / 'EMBEDDED-COPYRIGHTS.txt').write_text('\n'.join(headers))
    grant = (ROOT / 'LICENSE').read_text().split('Permission is hereby granted', 1)[1]
    (destination / 'EMBEDDED-MIT-LICENSE.txt').write_text(
        'MIT terms for embedded files identified as MIT in EMBEDDED-COPYRIGHTS.txt.\n'
        'Copyright holders and dates are preserved there per source file.\n\n'
        'Permission is hereby granted' + grant)


def npm_sources(project, destination):
    lock = json.loads((project / 'package-lock.json').read_text())
    packages = {name.removeprefix('node_modules/'): data for name, data in lock['packages'].items()
                if name and not data.get('dev')}
    if set(packages) != set(RUNTIME):
        raise ValueError('Review notices for changed production JavaScript dependencies')
    destination.mkdir()
    components = []
    for name, version in RUNTIME.items():
        package = packages[name]
        if package['version'] != version:
            raise ValueError('Update the reviewed JavaScript dependency notice version')
        installed = ROOT / 'node_modules' / name / 'LICENSE'
        notice = project / 'licenses' / (name + '-MIT.txt')
        if installed.is_file() and installed.read_bytes() != notice.read_bytes():
            raise ValueError('Bundled JavaScript license differs from the reviewed notice')
        archive = destination / (name + '-' + version + '.tgz')
        download(package['resolved'], archive)
        algorithm, expected = package['integrity'].split('-', 1)
        digest = hashlib.new(algorithm, archive.read_bytes()).digest()
        if base64.b64encode(digest).decode() != expected:
            raise ValueError('npm source tarball differs from package-lock integrity')
        components.append({'name': name, 'version': version, 'license': 'MIT', 'source': 'npm/' + archive.name})
    return components


def brew_sources(package, host, notices, tap):
    name, version = package['package'], package['version']
    prefix = Path(run(['brew', '--cellar', name], capture=True)) / version
    recipes = list((prefix / '.brew').glob('*.rb'))
    if len(recipes) != 1:
        raise ValueError(f'Missing exact installed Homebrew recipe for {name}@{version}')
    directory = host / name
    directory.mkdir()
    shutil.copyfile(recipes[0], directory / recipes[0].name)
    shutil.copyfile(prefix / 'INSTALL_RECEIPT.json', directory / 'INSTALL_RECEIPT.json')
    shutil.copyfile(recipes[0], tap / 'Formula' / recipes[0].name)
    formula = 'texpresso/release-sources/' + recipes[0].stem
    env = {**os.environ, 'HOMEBREW_NO_AUTO_UPDATE': '1', 'HOMEBREW_NO_ANALYTICS': '1',
           'HOMEBREW_CACHE': str(directory / 'cache')}
    # New Homebrew versions require trust even for an exact copy of an
    # installed core recipe. Approve this recipe only, never the whole tap.
    if subprocess.run(['brew', 'help', 'trust'], env=env, stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode == 0:
        subprocess.run(['brew', 'trust', '--formula', formula], env=env, check=True)
    info = json.loads(subprocess.check_output(['brew', 'info', '--json=v2', formula], env=env))['formulae'][0]
    source_version = info['versions']['stable'] + (f'_{info["revision"]}' if info['revision'] else '')
    if source_version != version:
        raise ValueError(f'Homebrew source recipe version mismatch for {name}: {source_version} != {version}')
    subprocess.run(['brew', 'fetch', '--build-from-source', '--retry', formula], env=env, check=True)
    downloads = list((directory / 'cache/downloads').glob('*'))
    archives = [file for file in downloads if file.is_file() and not file.name.endswith('.incomplete')]
    if not archives:
        raise ValueError('Homebrew fetched no corresponding sources for ' + name)
    unpack_notices(archives, notices / name)
    required = {'freetype': 'FTL.TXT', 'pcre2': 'LICENCE'}
    if name in required and not any(p.name.upper().startswith(required[name]) and p.is_file() and p.stat().st_size > 200
                                    for p in (notices / name).rglob('*')):
        raise ValueError('Missing full license text for ' + name)
    # Keep only actual downloads; API caches and lock files are not sources.
    saved = directory / 'downloads'
    saved.mkdir()
    for file in archives:
        shutil.copyfile(file, saved / file.name)
    shutil.rmtree(directory / 'cache')
    return {'name': name, 'version': version, 'licenseMetadata': info.get('license'),
            'recipeSha256': sha256(recipes[0]), 'sourceDirectory': 'host-sources/' + name}


def debian_sources(package, host, notices):
    binary, binary_version, source, version = package.split('\t')
    source = source or binary.split(':')[0]
    version = version or binary_version
    if not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', source) or not re.fullmatch(r'[a-zA-Z0-9.+:~_-]+', version):
        raise ValueError('Invalid Debian source package identity')
    directory = host / (source + '-' + version.replace(':', '_'))
    if directory.exists():
        return None  # Several runtime binaries can share a source package.
    directory.mkdir()
    run(['apt-get', 'source', '--download-only', '--only-source', source + '=' + version], cwd=directory)
    dsc = list(directory.glob('*.dsc'))
    if len(dsc) != 1:
        raise ValueError('Missing exact Debian source control file')
    with tempfile.TemporaryDirectory(prefix='txp-debian-notices-') as temporary:
        unpacked = Path(temporary) / 'source'
        run(['dpkg-source', '-x', dsc[0], unpacked])
        copy_notices(unpacked, notices / source)
    return {'name': source, 'version': version, 'binaryPackage': binary,
            'sourceDirectory': 'host-sources/' + directory.name}


def rpm_sources(package, host, notices):
    binary, binary_version, source, version = package.split('\t')
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9+_.-]*', binary) or
            not re.fullmatch(r'[0-9]+:[A-Za-z0-9+_.~-]+', binary_version) or
            not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9+_.-]*', source) or
            not re.fullmatch(r'[A-Za-z0-9+_.~-]+', version)):
        raise ValueError('Invalid RPM source package identity')
    name, architecture = binary.rsplit('.', 1)
    directory = host / (source + '-' + version)
    if directory.exists():
        return None
    directory.mkdir()
    # --source enables corresponding source repositories. Select the exact
    # installed binary NEVRA, then independently verify its SRPM identity.
    run(['dnf', 'download', '--source', '--downloaddir', directory,
         name + '-' + binary_version + '.' + architecture])
    archives = list(directory.glob('*.src.rpm'))
    if len(archives) != 1:
        raise ValueError('Missing exact source RPM for ' + binary)
    archive = archives[0]
    signature = run(['rpmkeys', '--checksig', '--verbose', archive], capture=True)
    keys = re.findall(r'(?im)\bsignature, key ID ([0-9a-f]+): OK\s*$', signature)
    if not keys:
        raise ValueError('Source RPM has no verified signature: ' + archive.name)
    identity = run(['rpm', '-qp', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\t%{ARCH}', archive], capture=True)
    if identity != '\t'.join([source, version, 'src']):
        raise ValueError('Downloaded source RPM identity mismatch: ' + identity)
    with tempfile.TemporaryDirectory(prefix='txp-rpm-notices-') as temporary:
        top = Path(temporary)
        # Source installation extracts SOURCES/SPECS without executing recipes.
        run(['rpm', '-i', '--nodeps', '--define', '_topdir ' + str(top), archive])
        specs = list((top / 'SPECS').glob('*.spec'))
        if len(specs) != 1:
            raise ValueError('Source RPM has no unique build recipe')
        shutil.copyfile(specs[0], directory / specs[0].name)
        unpack_notices([p for p in (top / 'SOURCES').iterdir() if p.is_file()], notices / source)
    return {'name': source, 'version': version, 'binaryPackage': binary,
            'sourceDirectory': 'host-sources/' + directory.name,
            'sourceRpm': 'host-sources/' + directory.name + '/' + archive.name,
            'sourceRpmSigningKeys': sorted(set(keys))}


def mupdf_submodules(source, native, lock):
    expected = dict(lock['mupdf']['submodules'])
    recorded = native.get('mupdfSubmodules', expected)
    if not expected.items() <= recorded.items():
        raise ValueError('Missing locked MuPDF submodules')
    for path, revision in recorded.items():
        if path not in ('thirdparty/lcms2', 'thirdparty/jbig2dec', 'thirdparty/harfbuzz'):
            raise ValueError('Unreviewed MuPDF submodule: ' + path)
        entry = run(['git', 'ls-tree', 'HEAD', path], cwd=source, capture=True)
        if not entry.startswith('160000 commit ') or entry.split()[2] != revision:
            raise ValueError('MuPDF submodule source identity mismatch: ' + path)
        check_source(source / path, revision)
    return recorded


def create_archive(payload, output, manifest):
    files = [record(p, payload) for p in sorted(payload.rglob('*')) if p.is_file() and not p.is_symlink()]
    manifest['files'] = files
    manifest['links'] = [{'path': p.relative_to(payload).as_posix(), 'target': os.readlink(p)}
                         for p in sorted(payload.rglob('*')) if p.is_symlink()]
    (payload / 'SOURCE-MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
    with output.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|') as archive:
            archive.add(payload, arcname='texpresso-sources')
    if output.stat().st_size >= 2 * 1024 ** 3:
        raise ValueError('Source archive exceeds GitHub release asset limit; split sources before publishing')
    Path(str(output) + '.sha256').write_text(sha256(output) + '  ' + output.name + '\n')
    return {'name': output.name, 'sha256': sha256(output), 'bytes': output.stat().st_size,
            'url': f'{REPOSITORY}/releases/download/v{manifest["version"]}/{output.name}',
            'extensionRevision': manifest['extensionRevision'], 'engineRevision': manifest.get('engineRevision'),
            'target': manifest['target'], 'version': manifest['version']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--mupdf-source', type=Path)
    parser.add_argument('--zlib-ng-source', type=Path)
    parser.add_argument('--fetch', action='store_true', help='allow source downloads on the release runner')
    args = parser.parse_args()
    if not args.fetch:
        parser.error('Source collection downloads archives; pass --fetch on a release runner')
    if args.bundle and not (args.mupdf_source and args.zlib_ng_source):
        parser.error('Native source collection requires both locked Git inputs')
    revision = run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture=True)
    check_source(ROOT, revision)
    version = json.loads((ROOT / 'package.json').read_text())['version']
    native = json.loads((args.bundle / 'build-manifest.json').read_text()) if args.bundle else None
    target = native['platform'] + '-' + ('x64' if native['architecture'] == 'x86_64' else native['architecture']) if native else 'universal'
    output = ROOT / 'artifacts' / f'texpresso-{version}-sources-{target}.tar.gz'
    output.parent.mkdir(exist_ok=True)
    if output.exists():
        raise ValueError('Refusing to replace an existing source archive')
    # Kept only until the completed source archive is written. No extra native
    # build, local source cache or timestamped backup is created.
    with tempfile.TemporaryDirectory(prefix='txp-release-sources-') as temporary:
        payload = Path(temporary) / 'payload'
        payload.mkdir()
        snapshot(ROOT, payload / 'project', revision)
        manifest = {'schema': 1, 'version': version, 'extensionRevision': revision, 'target': target,
                    'components': [{'name': 'texpresso-vscode', 'version': version, 'ownCodeLicense': 'MIT', 'sourceDirectory': 'project'}]}
        manifest['components'] += npm_sources(payload / 'project', payload / 'npm')
        shutil.copyfile(NATIVE / 'SOURCE-BUILDING.txt', payload / 'BUILDING.txt')
        shutil.copyfile(ROOT / 'THIRD-PARTY-NOTICES.txt', payload / 'THIRD-PARTY-NOTICES.txt')
        notices = payload / 'notices'
        notices.mkdir()
        if native:
            shutil.copytree(args.bundle / 'notices', notices, dirs_exist_ok=True)
            engine, engine_revision = pinned_engine()
            if native['engineRevision'] != engine_revision:
                raise ValueError('Bundle/source engine revision mismatch')
            manifest['engineRevision'] = engine_revision
            (notices / 'MODIFICATIONS.txt').write_text(
                f'TeXpresso native distribution {version}\n'
                f'Extension/build configuration revision: {revision}\n'
                f'Engine fork revision: {engine_revision}\n'
                f'Distribution source date: {run(["git", "show", "-s", "--format=%cI", revision], cwd=ROOT, capture=True)}\n\n'
                'The maintained TeXpresso fork adds embedded preview transport, rendering and editor integration.\n'
                'MuPDF is built with the supplied compact renderer profile. ICU data is filtered with the\n'
                'supplied profile. Native binaries/libraries are relocated for this distribution.\n'
                'Dependency packaging patches and recipes are preserved with their sources.\n'
                'Original license grants and copyright notices remain applicable to their components.\n')
            snapshot(engine, payload / 'project/native/texpresso', engine_revision)
            engine_notices(engine, notices / 'engine')
            inputs = payload / 'inputs'
            inputs.mkdir()
            lock = load_lock()
            if (native['mupdfRevision'] != lock['mupdf']['revision'] or
                    native['zlibNg']['revision'] != lock['zlibNg']['revision'] or
                    native['icu']['version'] != lock['icu']['version']):
                raise ValueError('Bundle/dependency source revision mismatch')
            manifest['components'].append({'name': 'texpresso', 'revision': engine_revision,
                'sourceDirectory': 'project/native/texpresso', 'originalCodeLicense': 'MIT (plus embedded third-party grants)',
                'binaryTerms': {'texpresso': 'GNU AGPL v3', 'texpresso-xetex': 'GNU GPL v3 or later'}})
            for name, source, expected in [('mupdf', args.mupdf_source, lock['mupdf']['revision']),
                                            ('zlib-ng', args.zlib_ng_source, lock['zlibNg']['revision'])]:
                check_source(source, expected)
                snapshot(source, inputs / name, expected)
                copy_notices(source, notices / name)
                manifest['components'].append({'name': name, 'revision': expected, 'sourceDirectory': 'inputs/' + name})
            for submodule, expected in mupdf_submodules(args.mupdf_source, native, lock).items():
                source = args.mupdf_source / submodule
                name = Path(submodule).name
                snapshot(source, inputs / 'mupdf' / submodule, expected)
                copy_notices(source, notices / name)
                manifest['components'].append({'name': name, 'revision': expected, 'sourceDirectory': 'inputs/mupdf/' + submodule})
            host = payload / 'host-sources'
            host.mkdir()
            if native['platform'] == 'darwin':
                tap = Path(run(['brew', '--repository'], capture=True)) / 'Library/Taps/texpresso/homebrew-release-sources'
                run(['brew', 'tap-new', '--no-git', 'texpresso/release-sources'])
                icu_version = Path(run(['brew', '--prefix', 'icu4c@78'], capture=True)).resolve().name
                if icu_version.split('_')[0] != lock['icu']['version']:
                    raise ValueError('Installed ICU source version differs from dependency lock')
                packages = [*native['hostLibraries'], {'package': 'icu4c@78', 'version': icu_version}]
                try:
                    for package in packages:
                        manifest['components'].append(brew_sources(package, host, notices, tap))
                finally:
                    shutil.rmtree(tap)
            else:
                collector = rpm_sources if native.get('hostPackageManager') == 'rpm' else debian_sources
                for package in [*native['hostLibraries'], *native.get('buildSourcePackages', [])]:
                    component = collector(package, host, notices)
                    if component:
                        manifest['components'].append(component)
                for package in native.get('buildSourcePackages', []):
                    source = package.split('\t')[2]
                    if not any(p.name == 'COPYING.RUNTIME' for p in (notices / source).rglob('*')):
                        raise ValueError('Missing GCC runtime exception license: ' + source)
                download(lock['icu']['sourceUrl'], inputs / 'icu.tgz', lock['icu']['sourceSha256'])
                unpack_notices([inputs / 'icu.tgz'], notices / 'icu')
                manifest['components'].append({'name': 'icu', 'version': lock['icu']['version'], 'source': 'inputs/icu.tgz'})
            for file in (ROOT / 'licenses').glob('*.txt'):
                shutil.copyfile(file, notices / file.name)
            for component in manifest['components']:
                prefix = notices / component['name']
                if component['name'] == 'texpresso':
                    prefix = notices / 'engine'
                component['noticeFiles'] = [p.relative_to(payload).as_posix() for p in sorted(prefix.rglob('*')) if p.is_file()]
                if component['name'] in RUNTIME:
                    component['noticeFiles'] = ['notices/' + component['name'] + '-MIT.txt']
            (notices / 'COMPONENTS.json').write_text(json.dumps(manifest['components'], indent=2) + '\n')
            shutil.copyfile(payload / 'BUILDING.txt', notices / 'BUILDING.txt')
            shutil.copyfile(payload / 'THIRD-PARTY-NOTICES.txt', notices / 'THIRD-PARTY-NOTICES.txt')
            (payload / 'BINARY-BUILD-MANIFEST.json').write_text(json.dumps(native, indent=2) + '\n')
        source = create_archive(payload, output, manifest)
        Path(str(output) + '.json').write_text(json.dumps(source, indent=2) + '\n')
        if native:
            destination = args.bundle / 'notices'
            shutil.copytree(notices, destination, dirs_exist_ok=True)
            native['licenseFiles'] = [record(p, args.bundle) for p in sorted(destination.rglob('*')) if p.is_file()]
            native['sourceArchive'] = source
            native['installedBytes'] = sum(p.stat().st_size for p in args.bundle.rglob('*') if p.is_file() and p.name != 'build-manifest.json')
            (args.bundle / 'build-manifest.json').write_text(json.dumps(native, indent=2) + '\n')
    print(f'Corresponding source: {output.name} ({output.stat().st_size / 2**20:.1f} MiB)')


if __name__ == '__main__':
    main()
