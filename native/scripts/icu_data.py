"""Extract and filter the installed ICU package using ICU's own icupkg tool."""
import json
import re
import struct
from pathlib import Path
from common import NATIVE, run, sha256


def keep_item(name, profile):
    if '/' in name:
        return name.split('/', 1)[0] not in profile['excludeTrees']
    if profile['excludeRootLocaleBundles'] and re.fullmatch(r'[a-z]{2,3}(?:_[A-Za-z0-9]+)*\.res', name):
        return False
    return True


def extract_macho_data(library, symbol, output):
    """Read the ICU data symbol from a thin, little-endian 64-bit Mach-O."""
    data = library.read_bytes()
    if data[:4] != b'\xcf\xfa\xed\xfe':
        raise ValueError('Expected a thin 64-bit Mach-O ICU library for this host')
    matches = [line.split()[0] for line in run(['nm', '-n', library], capture=True).splitlines()
               if line.endswith(' ' + symbol)]
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one ICU data symbol {symbol}')
    address = int(matches[0], 16)
    commands = struct.unpack_from('<I', data, 16)[0]
    offset = 32
    for _ in range(commands):
        command, size = struct.unpack_from('<II', data, offset)
        if command == 0x19:  # LC_SEGMENT_64
            _, vmaddr, _, fileoff, filesize = struct.unpack_from('<16s4Q', data, offset + 8)
            if vmaddr <= address < vmaddr + filesize:
                payload = data[fileoff + address - vmaddr:fileoff + filesize]
                if payload[2:4] != b'\xda\x27':
                    raise ValueError('ICU data header is missing')
                output.write_bytes(payload)
                return
        offset += size
    raise ValueError('ICU data symbol is outside the file-backed Mach-O segments')


def prepare(prefix, output, version):
    output.mkdir(parents=True, exist_ok=True)
    major = version.split('.')[0]
    installed = (prefix / 'include/unicode/uvernum.h').read_text()
    if f'#define U_ICU_VERSION "{version}"' not in installed:
        raise ValueError(f'Expected ICU {version} at {prefix}')
    full = output / f'icudt{major}l.dat'
    extract_macho_data(prefix / 'lib' / f'libicudata.{major}.dylib', f'_icudt{major}_dat', full)
    profile = json.loads((NATIVE / 'profiles/icu-filter.json').read_text())
    icupkg = prefix / 'sbin/icupkg'
    items = run([icupkg, '-l', full], capture=True).splitlines()
    removed = [name for name in items if not keep_item(name, profile)]
    selection = output / 'remove.txt'
    selection.write_text('\n'.join(removed) + '\n')
    filtered = output / 'filtered'
    filtered.mkdir(exist_ok=True)
    package = filtered / full.name
    # Keep dependency checking enabled: missing bundle parents must fail.
    run([icupkg, '-r', selection, full, package])
    run([prefix / 'sbin/genccode', '-e', f'icudt{major}', '-a', 'gcc-darwin', '-d', filtered, package])
    obj = filtered / 'icudata.o'
    run(['xcrun', 'clang', '-c', filtered / f'icudt{major}l_dat.S', '-o', obj])
    return obj, {'version': version, 'fullDataSha256': sha256(full),
                 'filteredDataSha256': sha256(package), 'fullBytes': full.stat().st_size,
                 'filteredBytes': package.stat().st_size, 'retainedItems': len(items) - len(removed)}
