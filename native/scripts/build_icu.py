#!/usr/bin/env python3
"""Build the locked ICU source archive for Linux. Downloads are a separate step."""
import argparse
import os
import tarfile
import tempfile
import platform
import shlex
import shutil
from pathlib import Path
from common import NATIVE, load_lock, run, sha256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--keep-work', action='store_true')
    args = parser.parse_args()
    lock = load_lock()['icu']
    if sha256(args.archive) != lock['sourceSha256']:
        parser.error('ICU source archive checksum does not match the lock')
    output = args.output.resolve()
    if output.exists():
        parser.error('ICU output already exists')
    work_root = NATIVE / '.work'
    work_root.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='icu-', dir=work_root))
    with tarfile.open(args.archive) as archive:
        archive.extractall(work, filter='data')
    source = work / 'icu/source'
    cpu = ['-march=x86-64', '-mtune=generic'] if platform.machine() == 'x86_64' else ['-march=armv8-a', '-mtune=generic']
    flags = shlex.join(['-O2', '-fPIC', *cpu])
    run([source / 'configure', '--prefix=' + str(output), '--enable-static', '--disable-shared',
         '--with-data-packaging=archive', '--disable-tests', '--disable-samples', 'CFLAGS=' + flags, 'CXXFLAGS=' + flags], cwd=source)
    run(['make', '-j' + str(min(os.cpu_count() or 2, 8))], cwd=source)
    run(['make', 'install'], cwd=source)
    if not args.keep_work:
        shutil.rmtree(work)


if __name__ == '__main__':
    main()
