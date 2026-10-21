"""Shared native build helpers. No command in this directory downloads sources."""
import hashlib
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path

NATIVE = Path(__file__).resolve().parents[1]
ROOT = NATIVE.parent


def run(args, *, cwd=None, capture=False):
    result = subprocess.run([str(a) for a in args], cwd=cwd, check=True,
                            text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def sha256(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def load_lock():
    return json.loads((NATIVE / 'dependencies.lock.json').read_text())


def pinned_engine():
    entry = run(['git', 'ls-files', '--stage', 'native/texpresso'], cwd=ROOT, capture=True)
    if not entry.startswith('160000 '):
        raise ValueError('native/texpresso must be a pinned Git submodule')
    revision = entry.split()[1]
    source = NATIVE / 'texpresso'
    check_source(source, revision)
    return source, revision


def check_source(path, revision):
    actual = run(['git', 'rev-parse', 'HEAD'], cwd=path, capture=True)
    if actual != revision:
        raise ValueError(f'{path}: expected {revision}, found {actual}')
    # Exports contain committed files only. Reject tracked edits rather than
    # silently compiling something different from the developer's source view.
    if run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=path, capture=True):
        raise ValueError(f'{path}: commit/stash source changes before building a pinned bundle')


def export_source(source, destination):
    """Export committed files only; leave the user's checkout and build untouched."""
    destination.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryFile() as archive:
        subprocess.run(['git', '-C', str(source), 'archive', 'HEAD'], stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as files:
            files.extractall(destination, filter='data')
