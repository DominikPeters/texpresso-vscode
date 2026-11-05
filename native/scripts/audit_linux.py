#!/usr/bin/env python3
"""Audit required ELF symbol versions across an entire relocated Linux bundle."""
import argparse
import json
import os
import re
import struct
import subprocess
from pathlib import Path


def version(value):
    parts = tuple(int(p) for p in value.split('.'))
    return parts + (0,) * max(0, 3 - len(parts))


def required_glibc(output):
    # Definitions exported by a library are not requirements. Inspect only
    # DT_VERNEED; otherwise e.g. libc's own exported versions are misleading.
    needed = output.split('Version needs section', 1)[-1] if 'Version needs section' in output else ''
    names = set(re.findall(r'Name:\s+(GLIBC_[A-Za-z0-9_.]+)', needed))
    for name in names:
        if not re.fullmatch(r'GLIBC_\d+(?:\.\d+)+', name):
            raise ValueError('Unsupported/private glibc ABI requirement: ' + name)
    return sorted({name.removeprefix('GLIBC_') for name in names}, key=version)


def check_isa(notes, architecture):
    if architecture == 'x86_64' and re.search(r'x86 ISA needed:.*x86-64-v[234]', notes):
        raise ValueError('ELF requires an x86-64 ISA newer than the baseline')


def audit(directory, maximum, architecture):
    records = []
    expected = {'x86_64': 62, 'arm64': 183}[architecture]
    env = {**os.environ, 'LC_ALL': 'C'}
    def readelf(*args):
        return subprocess.run(['readelf', *map(str, args)], check=True, env=env,
                              text=True, stdout=subprocess.PIPE).stdout
    for folder in ('bin', 'lib'):
        for file in sorted((directory / folder).rglob('*')):
            if not file.is_file():
                continue
            with file.open('rb') as source:
                header = source.read(20)
            if not header.startswith(b'\x7fELF'):
                raise ValueError(f'Non-ELF payload in {file}')
            if header[4:6] != b'\x02\x01' or struct.unpack('<H', header[18:20])[0] != expected:
                raise ValueError(f'Unexpected ELF architecture: {file}')
            required = required_glibc(readelf('--version-info', '--wide', file))
            if required and version(required[-1]) > version(maximum):
                raise ValueError(f'{file}: requires GLIBC_{required[-1]}, exceeds {maximum}')
            check_isa(readelf('--notes', '--wide', file), architecture)
            records.append({'path': file.relative_to(directory).as_posix(), 'requiredGlibc': required[-1] if required else None})
    if not records or not {'bin/texpresso', 'bin/texpresso-xetex'} <= {r['path'] for r in records}:
        raise ValueError('Incomplete native bundle')
    required = [r['requiredGlibc'] for r in records if r['requiredGlibc']]
    return {'maximumGlibc': maximum, 'requiredGlibc': max(required, key=version) if required else None,
            'cpuBaseline': 'x86-64' if architecture == 'x86_64' else 'armv8-a',
            'isaCheck': 'ELF declared requirements; execution must also be tested on a baseline CPU', 'files': records}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--maximum-glibc', required=True)
    parser.add_argument('--architecture', required=True, choices=['x86_64', 'arm64'])
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = json.dumps(audit(args.directory, args.maximum_glibc, args.architecture), indent=2) + '\n'
    if args.output:
        args.output.write_text(result)
    else:
        print(result, end='')
