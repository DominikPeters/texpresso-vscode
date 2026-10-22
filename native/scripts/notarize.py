#!/usr/bin/env python3
"""Sign and notarize a copy of an existing macOS native bundle on a CI runner."""
import argparse
import base64
import json
import os
import platform
import re
import shutil
import shlex
import subprocess
import tempfile
import zipfile
from pathlib import Path
from common import sha256

SECRETS = ('APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY',
           'KEYCHAIN_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_PRIVATE_KEY')
MACHO = {bytes.fromhex(m) for m in ('feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca')}


def command(args, *, sensitive=False, check=True):
    # Never echo credential-bearing argv, and do not pass secrets to children
    # which do not need them. Capture errors instead of raising with the argv.
    env = {k: v for k, v in os.environ.items() if k not in SECRETS}
    result = subprocess.run([str(a) for a in args], text=True, capture_output=True, env=env)
    if check and result.returncode:
        detail = '' if sensitive else ': ' + result.stderr.strip()[-2000:]
        raise RuntimeError(f'{args[0]} {args[1]} failed{detail}')
    return result


def binary_secret(value):
    try:
        return base64.b64decode(''.join(value.split()), validate=True)
    except ValueError:
        raise ValueError('APPLE_CERTIFICATE must contain a base64-encoded PKCS#12 certificate') from None


def private_key(value):
    if '-----BEGIN PRIVATE KEY-----' not in value:
        try:
            value = base64.b64decode(''.join(value.split()), validate=True).decode('ascii')
        except (ValueError, UnicodeError):
            raise ValueError('APPLE_API_PRIVATE_KEY must contain a PEM .p8 key or its base64 encoding') from None
    if not value.strip().startswith('-----BEGIN PRIVATE KEY-----') or not value.strip().endswith('-----END PRIVATE KEY-----'):
        raise ValueError('APPLE_API_PRIVATE_KEY must contain a PEM .p8 private key')
    return value.strip() + '\n'


def bundle_inputs(source):
    if any(p.is_symlink() for p in source.rglob('*')):
        raise ValueError('Bundle must contain regular files, not symlinks')
    manifest = json.loads((source / 'build-manifest.json').read_text())
    paths = []
    for entry in manifest['files']:
        relative = Path(entry['path'])
        if len(relative.parts) != 2 or relative.parts[0] not in ('bin', 'lib') or '..' in relative.parts:
            raise ValueError('Invalid binary path in bundle manifest')
        file = source / relative
        with file.open('rb') as content:
            if content.read(4) not in MACHO:
                raise ValueError(f'Not a Mach-O binary: {relative}')
        if sha256(file) != entry['sha256'] or file.stat().st_size != entry['bytes']:
            raise ValueError(f'Bundle manifest mismatch: {relative}')
        paths.append(relative)
    actual = {p.relative_to(source) for directory in ('bin', 'lib') for p in (source / directory).rglob('*') if p.is_file()}
    if set(paths) != actual or len(paths) != len(actual) or not {Path('bin/texpresso'), Path('bin/texpresso-xetex')} <= actual:
        raise ValueError('Manifest must cover both executables and every bundled library exactly once')
    return manifest, sorted(paths, key=lambda p: (p.parts[0] == 'bin', str(p)))


def imported_identity(requested, keychain):
    result = command(['security', 'find-identity', '-v', '-p', 'codesigning', keychain], sensitive=True)
    identities = re.findall(r'^\s*\d+\) ([A-Fa-f0-9]{40}) "(Developer ID Application:[^"\n]+)"', result.stdout, re.M)
    normalized = requested.replace(' ', '').upper()
    matches = [(fingerprint, name) for fingerprint, name in identities if
               fingerprint.upper() == normalized or requested.strip() == name]
    if len(matches) == 1:
        return matches[0][0]
    if len(identities) == 1:
        # The uploaded PKCS#12 is the source of the signing key. Its certificate
        # name can differ from a stale/misspelled Actions identity setting.
        print('Using the sole imported Developer ID Application certificate; its name differs from APPLE_SIGNING_IDENTITY', flush=True)
        return identities[0][0]
    if not identities:
        raise ValueError('No valid Developer ID Application signing identity in the imported PKCS#12. Export the certificate together with its private key and certificate chain; an Apple Development/Distribution certificate cannot notarize this bundle.')
    raise ValueError('Multiple imported Developer ID Application identities; APPLE_SIGNING_IDENTITY must match one certificate name or SHA-1')


def sign_bundle(source, destination, identity, keychain):
    if destination.exists() or destination.with_suffix('.zip').exists():
        raise ValueError('Signed output already exists; choose a new destination')
    manifest, paths = bundle_inputs(source)
    identity = imported_identity(identity, keychain)
    shutil.copytree(source, destination)
    team = None
    for relative in paths:
        target = destination / relative
        command(['codesign', '--force', '--options', 'runtime', '--timestamp',
                 '--sign', identity, '--keychain', keychain, target])
        command(['codesign', '--verify', '--strict', '--verbose=2', target])
        details = command(['codesign', '--display', '--verbose=4', target]).stderr
        match = re.search(r'^TeamIdentifier=(\S+)$', details, re.M)
        if not match or 'Authority=Developer ID Application:' not in details or 'Timestamp=' not in details or not re.search(r'^CodeDirectory .*flags=.*\bruntime\b', details, re.M):
            raise ValueError(f'{relative}: expected timestamped Developer ID Application signature with hardened runtime')
        if team is not None and team != match[1]:
            raise ValueError('Bundled libraries and executables must share a signing team')
        team = match[1]
    manifest['signing'] = {'kind': 'developer-id', 'teamId': team, 'hardenedRuntime': True, 'secureTimestamp': True}
    for entry in manifest['files']:
        file = destination / entry['path']
        entry.update(sha256=sha256(file), bytes=file.stat().st_size)
    # Match the builder's accounting: installedBytes excludes the manifest.
    manifest['installedBytes'] = sum(p.stat().st_size for p in destination.rglob('*') if p.is_file() and p.name != 'build-manifest.json')
    (destination / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    archive = destination.with_suffix('.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for file in sorted(destination.rglob('*')):
            if file.is_file():
                output.write(file, file.relative_to(destination))
    return archive


def notarize(archive, reports, keychain, timeout):
    reports.mkdir(parents=True, exist_ok=True)
    auth = ['--keychain-profile', 'texpresso-notary', '--keychain', keychain]
    submitted = command(['xcrun', 'notarytool', 'submit', archive, *auth, '--no-wait', '--output-format', 'json'])
    (reports / 'submission.json').write_text(submitted.stdout)
    submission_id = json.loads(submitted.stdout)['id']
    print(f'Notarization submission: {submission_id}', flush=True)
    waited = command(['xcrun', 'notarytool', 'wait', submission_id, *auth, '--timeout', timeout,
                      '--output-format', 'json'], check=False)
    (reports / 'result.json').write_text(waited.stdout)
    # Fetch diagnostics on success, rejection, and timeout; never mask the result
    # if Apple has not made a log available yet.
    log = command(['xcrun', 'notarytool', 'log', submission_id, *auth, reports / 'apple-log.json'], check=False)
    if log.returncode:
        (reports / 'log-unavailable.txt').write_text(log.stderr)
    try:
        status = json.loads(waited.stdout).get('status')
    except ValueError:
        status = None
    if waited.returncode or status != 'Accepted':
        raise RuntimeError(f'Apple has not accepted submission {submission_id} (status: {status or "unknown/timeout"}); see notarization diagnostics')
    archive.with_suffix('.zip.sha256').write_text(f'{sha256(archive)}  {archive.name}\n')
    print(f'Apple accepted {archive.name}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    parser.add_argument('--timeout', default='20m')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('Signing and notarization require macOS')
    missing = [name for name in SECRETS if not os.environ.get(name)]
    if missing:
        parser.error('Missing required secrets: ' + ', '.join(missing))
    if os.environ['APPLE_SIGNING_IDENTITY'].strip() == '-':
        parser.error('A Developer ID Application identity is required, not ad-hoc signing')
    # Validate inputs before importing any credentials.
    bundle_inputs(args.bundle)
    certificate = binary_secret(os.environ['APPLE_CERTIFICATE'])
    key = private_key(os.environ['APPLE_API_PRIVATE_KEY'])
    with tempfile.TemporaryDirectory(prefix='texpresso-sign-', dir=os.environ.get('RUNNER_TEMP')) as folder:
        folder = Path(folder)
        folder.chmod(0o700)
        keychain = folder / 'signing.keychain-db'
        p12, p8 = folder / 'certificate.p12', folder / 'AuthKey.p8'
        p12.write_bytes(certificate); p8.write_text(key)
        p12.chmod(0o600); p8.chmod(0o600)
        original_keychains = shlex.split(command(['security', 'list-keychains', '-d', 'user'], sensitive=True).stdout)
        try:
            password = os.environ['KEYCHAIN_PASSWORD']
            command(['security', 'create-keychain', '-p', password, keychain], sensitive=True)
            command(['security', 'list-keychains', '-d', 'user', '-s', keychain, *original_keychains], sensitive=True)
            command(['security', 'set-keychain-settings', '-lut', '21600', keychain], sensitive=True)
            command(['security', 'unlock-keychain', '-p', password, keychain], sensitive=True)
            command(['security', 'import', p12, '-k', keychain, '-P', os.environ['APPLE_CERTIFICATE_PASSWORD'], '-t', 'cert', '-f', 'pkcs12', '-T', '/usr/bin/codesign'], sensitive=True)
            command(['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain], sensitive=True)
            command(['xcrun', 'notarytool', 'store-credentials', 'texpresso-notary', '--key', p8,
                     '--key-id', os.environ['APPLE_API_KEY'], '--issuer', os.environ['APPLE_API_ISSUER'],
                     '--keychain', keychain], sensitive=True)
            p12.unlink(); p8.unlink()
            archive = sign_bundle(args.bundle, args.output, os.environ['APPLE_SIGNING_IDENTITY'], keychain)
            notarize(archive, args.reports, keychain, args.timeout)
        finally:
            command(['security', 'list-keychains', '-d', 'user', '-s', *original_keychains], sensitive=True, check=False)
            command(['security', 'delete-keychain', keychain], sensitive=True, check=False)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from None
