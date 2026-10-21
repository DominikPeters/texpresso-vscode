"""Collect, relocate, and ad-hoc sign a macOS development bundle."""
import json
import os
import shutil
import zipfile
from pathlib import Path
from common import NATIVE, run, sha256


def system_library(name):
    return name.startswith(('/usr/lib/', '/System/Library/'))


def linked_libraries(source):
    return [line.strip().split(' (compatibility')[0]
            for line in run(['otool', '-L', source], capture=True).splitlines()[1:]]


def resolve_library(name, source, executables):
    if name.startswith('@loader_path/'):
        candidates = [source.parent / name.removeprefix('@loader_path/')]
    elif name.startswith('@executable_path/'):
        candidates = [p.parent / name.removeprefix('@executable_path/') for p in executables]
    elif name.startswith('@rpath/'):
        suffix = name.removeprefix('@rpath/')
        candidates = [source.parent / suffix]
        lines = run(['otool', '-l', source], capture=True).splitlines()
        for i, line in enumerate(lines):
            if line.strip() == 'cmd LC_RPATH':
                rpath = lines[i + 2].strip().removeprefix('path ').split(' (offset')[0]
                rpath = rpath.replace('@loader_path', str(source.parent))
                candidates.append(Path(rpath) / suffix)
    else:
        candidates = [Path(name)]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise ValueError(f'{source}: cannot resolve {name}')


def copy_notices(source, notices):
    """Collect installed package notices; record packages missing local notices."""
    for prefix in source.parents:
        receipt = prefix / 'INSTALL_RECEIPT.json'
        if not receipt.is_file():
            continue
        destination = notices / prefix.parent.name
        destination.mkdir(exist_ok=True)
        count = 0
        for pattern in ('LICENSE*', 'COPYING*', 'NOTICE*', 'share/licenses/**/*',
                        'share/doc/*/LICENSE*', 'share/doc/*/COPYING*', 'share/doc/*/NOTICE*'):
            for file in prefix.glob(pattern):
                if file.is_file():
                    relative = file.relative_to(prefix)
                    target = destination / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(file, target)
                    count += 1
        fallback = NATIVE / 'notices' / (prefix.parent.name + '-COPYING')
        if not count and fallback.is_file():
            shutil.copyfile(fallback, destination / 'COPYING')
            count += 1
        return {'package': prefix.parent.name, 'version': prefix.name, 'noticesFound': count > 0}
    return None


def bundle(executables, destination, metadata, notices_sources):
    if destination.exists():
        raise ValueError(f'Refusing to overwrite bundle {destination}')
    (destination / 'bin').mkdir(parents=True)
    (destination / 'lib').mkdir()
    notices = destination / 'notices'
    notices.mkdir()
    mapping = {p.resolve(): Path('bin') / p.name for p in executables}
    # SDL2-compat loads SDL3 with dlopen, so otool cannot discover it. It first
    # tries @loader_path/libSDL3.dylib, alongside libSDL2 in our lib directory.
    sdl = next(p for p in linked_libraries(executables[0]) if 'libSDL2' in p)
    sdl_source = resolve_library(sdl, executables[0], executables)
    sdl3 = sdl_source.parent / 'libSDL3.dylib'
    if not sdl3.exists():
        # A genuine SDL2 installation has no SDL3 dependency.
        strings = run(['strings', sdl_source], capture=True)
        if '@loader_path/libSDL3.dylib' in strings:
            directory = run(['pkg-config', '--variable=libdir', 'sdl3'], capture=True)
            sdl3 = Path(directory) / 'libSDL3.dylib'
            if not sdl3.is_file():
                raise ValueError('SDL2-compat requires a local SDL3 library')
    if sdl3.is_file():
        mapping[sdl3.resolve()] = Path('lib/libSDL3.dylib')
    edges = {}
    pending = list(mapping)
    while pending:
        source = pending.pop()
        if source in edges:
            continue
        edges[source] = {}
        for name in linked_libraries(source):
            if system_library(name):
                continue
            resolved = resolve_library(name, source, executables)
            if resolved == source:  # A dylib's install name, not a dependency.
                continue
            edges[source][name] = resolved
            if resolved not in mapping:
                target = Path('lib') / resolved.name
                if target in mapping.values():
                    raise ValueError(f'Two different libraries would overwrite {target}')
                mapping[resolved] = target
            pending.append(resolved)
    packages = {}
    for source, relative in mapping.items():
        target = destination / relative
        shutil.copyfile(source, target)
        target.chmod(0o755)
        run(['strip', '-S', '-x', target])
        if relative.parts[0] == 'lib':
            run(['install_name_tool', '-id', '@loader_path/' + relative.name, target])
        for name, resolved in edges[source].items():
            replacement = os.path.relpath(mapping[resolved], relative.parent)
            run(['install_name_tool', '-change', name, '@loader_path/' + replacement, target])
        run(['codesign', '--force', '--sign', '-', target])
        for name in linked_libraries(target):
            if not system_library(name) and not name.startswith('@loader_path/'):
                raise ValueError(f'Unrelocated dependency in {relative}: {name}')
        package = copy_notices(source, notices)
        if package:
            packages[package['package']] = package
    for name, source in notices_sources.items():
        shutil.copyfile(source, notices / name)
    metadata['hostLibraries'] = sorted(packages.values(), key=lambda p: p['package'])
    metadata['files'] = [{'path': str(relative), 'sha256': sha256(destination / relative),
                          'bytes': (destination / relative).stat().st_size}
                         for relative in mapping.values()]
    metadata['installedBytes'] = sum(p.stat().st_size for p in destination.rglob('*') if p.is_file())
    (destination / 'build-manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
    archive = destination.with_suffix('.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for file in sorted(destination.rglob('*')):
            if file.is_file():
                output.write(file, file.relative_to(destination))
    print(f'Bundle: {destination}\nZIP: {archive} ({archive.stat().st_size / 2**20:.2f} MiB)')
