"""Relocate an ELF bundle, retaining the host glibc and graphics drivers."""
import json
import re
import shutil
import zipfile
from pathlib import Path
from common import run, sha256

# glibc and its loader must come from the runtime OS as a matching set.
SYSTEM = re.compile(r'^(?:linux-vdso|ld-linux|lib(?:c|m|pthread|dl|rt|resolv|util)\.so(?:\.|$))')


def libraries(binary):
    result = {}
    for line in run(['ldd', binary], capture=True).splitlines():
        fields = line.strip().split()
        if not fields or SYSTEM.match(fields[0]):
            continue
        if len(fields) >= 3 and fields[1] == '=>':
            if fields[2] == 'not':
                raise ValueError(f'{binary}: unresolved dependency {fields[0]}')
            if not fields[2].startswith('/'):
                raise ValueError(f'{binary}: unexpected dependency {line}')
            result[fields[0]] = Path(fields[2]).resolve()
        elif fields[0].startswith('/') and not SYSTEM.match(Path(fields[0]).name):
            raise ValueError(f'{binary}: absolute ELF dependency {fields[0]}')
    return result


def package_notice(source, destination):
    if not shutil.which('dpkg-query'):
        return rpm_notice(source, destination)
    # These builds run in Debian/Ubuntu containers; include the exact installed
    # package's copyright file and its binary/source version for source retrieval.
    names = [source]
    if str(source).startswith('/lib/'):
        names.append(Path('/usr') / source.relative_to('/'))
    elif str(source).startswith('/usr/lib/'):
        names.append(Path('/') / source.relative_to('/usr'))
    owners = []
    for name in names:
        try:
            owners = run(['dpkg-query', '-S', name], capture=True).splitlines()
            if owners:
                break
        except Exception:
            continue
    if not owners:
        raise ValueError(f'Cannot identify dependency package for {source}')
    package = owners[0].split(': ')[0]
    record = run(['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}', package], capture=True)
    notice = Path('/usr/share/doc') / package.split(':')[0] / 'copyright'
    if not notice.is_file():
        raise ValueError(f'Missing dependency notice: {notice}')
    target = destination / package.replace(':', '_')
    target.mkdir(exist_ok=True)
    shutil.copyfile(notice, target / 'copyright')
    (target / 'package.txt').write_text(record + '\n')
    return record


def rpm_notice(source, destination):
    record = run(['rpm', '-qf', '--qf', '%{NAME}.%{ARCH}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{SOURCERPM}', source], capture=True)
    package, binary_version, source_rpm = record.split('\t')
    if not source_rpm.endswith('.src.rpm'):
        raise ValueError(f'Missing source RPM identity for {source}')
    source_name, source_version, source_release = source_rpm.removesuffix('.src.rpm').rsplit('-', 2)
    identity = '\t'.join([package, binary_version, source_name, source_version + '-' + source_release])
    target = destination / package
    target.mkdir(exist_ok=True)
    def copy_licenses(candidate):
        files = run(['rpm', '-q', '--qf', '[%{FILENAMES}\t%{FILEFLAGS}\n]', candidate], capture=True)
        copied = 0
        for entry in files.splitlines():
            name, flags = entry.rsplit('\t', 1)
            file = Path(name)
            # RPMFILE_LICENSE marks installed, package-maintained license texts.
            if int(flags) & 128 and file.is_file():
                output = target / file.relative_to('/')
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, output)
                copied += 1
        return copied
    owners = [package] if copy_licenses(package) else []
    if not owners:
        # Split runtime packages can keep their shared license payload in a
        # companion (e.g. libstdc++ in libgcc). Require the exact same SRPM.
        installed = run(['rpm', '-qa', '--qf', '%{NAME}.%{ARCH}\t%{SOURCERPM}\n'], capture=True)
        for entry in installed.splitlines():
            candidate, origin = entry.split('\t')
            if candidate != package and origin == source_rpm and copy_licenses(candidate):
                owners.append(candidate)
    if not owners:
        raise ValueError(f'Missing installed RPM license texts: {package} ({source_rpm})')
    (target / 'license-packages.txt').write_text('\n'.join(sorted(owners)) + '\n')
    (target / 'package.txt').write_text(identity + '\n')
    return identity


def bundle(executables, destination, metadata, notices_sources, *, maximum_glibc=None):
    if destination.exists() or destination.with_suffix('.zip').exists():
        raise ValueError(f'Refusing to replace bundle {destination}')
    (destination / 'bin').mkdir(parents=True)
    (destination / 'lib').mkdir()
    notices = destination / 'notices'
    notices.mkdir()
    # Debian copyright files often reference these texts instead of embedding
    # them. Include the texts so notices remain complete outside the build OS.
    if Path('/usr/share/common-licenses').is_dir():
        shutil.copytree('/usr/share/common-licenses', notices / 'common-licenses')
    mapping = {Path('bin') / p.name: p.resolve() for p in executables}
    pending = list(executables)
    seen = set()
    while pending:
        source = pending.pop().resolve()
        if source in seen:
            continue
        seen.add(source)
        for soname, library in libraries(source).items():
            relative = Path('lib') / soname
            if relative in mapping and mapping[relative] != library:
                raise ValueError(f'Conflicting libraries for {soname}')
            mapping[relative] = library
            pending.append(library)
    packages = set()
    for relative, source in mapping.items():
        target = destination / relative
        shutil.copyfile(source, target)
        target.chmod(0o755)
        run(['strip', '--strip-unneeded', target])
        run(['patchelf', '--set-rpath', '$ORIGIN/../lib' if relative.parts[0] == 'bin' else '$ORIGIN', target])
        if relative.parts[0] == 'lib':
            packages.add(package_notice(source, notices))
    # Check the relocated dependency closure before writing the manifest.
    for relative in mapping:
        for soname, resolved in libraries(destination / relative).items():
            if resolved.parent != (destination / 'lib').resolve():
                raise ValueError(f'{relative}: dependency escaped bundle: {soname} -> {resolved}')
    for name, source in notices_sources.items():
        shutil.copyfile(source, notices / name)
    metadata['hostLibraries'] = sorted(packages)
    if maximum_glibc:
        from audit_linux import audit
        metadata['compatibility'] = audit(destination, maximum_glibc, metadata['architecture'])
    metadata['files'] = [{'path': str(p), 'sha256': sha256(destination / p), 'bytes': (destination / p).stat().st_size} for p in mapping]
    metadata['installedBytes'] = sum(p.stat().st_size for p in destination.rglob('*') if p.is_file())
    (destination / 'build-manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
    with zipfile.ZipFile(destination.with_suffix('.zip'), 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(destination.rglob('*')):
            if file.is_file():
                archive.write(file, file.relative_to(destination))
