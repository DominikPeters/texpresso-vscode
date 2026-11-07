#!/usr/bin/env python3
"""Small offline frontend build; reuse locked libraries and an unchanged worker.

No engine/compiler build, dependency download, archive or source-checkout edits.
The output lives in native/.work and is only a profiling runtime.
"""
import argparse
import hashlib
import json
import re
import shlex
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build(args):
    source = args.engine_source.resolve()
    work = args.work.resolve()
    if not work.is_relative_to((ROOT / 'native/.work').resolve()):
        raise ValueError('Profiling intermediates must stay in native/.work')
    if work.exists():
        raise ValueError('Use a fresh work directory')
    manifest = json.loads((args.base_bundle / 'build-manifest.json').read_text())
    config = args.dependency_config.read_text()
    archives = re.findall(r'[^\s=]+/libmupdf(?:-third)?\.a', config)
    expected = manifest['renderer']['reusedArchives']
    for name in ['libmupdf.a', 'libmupdf-third.a']:
        archive = next(Path(a) for a in archives if Path(a).name == name)
        if sha(archive) != expected[name]:
            raise ValueError('Cached MuPDF archive differs from base runtime: ' + name)
    # Refresh relocated Homebrew search directories, not library versions.
    # Package identities/flags are recorded in the resulting manifest.
    packages = ['freetype2', 'libjpeg', 'libopenjp2', 'libbrotlidec', 'libbrotlienc']
    package_flags = subprocess.check_output(['pkg-config', '--cflags', '--libs', *packages], text=True).strip()
    versions = {p: subprocess.check_output(['pkg-config', '--modversion', p], text=True).strip() for p in packages}
    for package, version in versions.items():
        if manifest['hostPackageVersions'][package] != version:
            raise ValueError('Host dependency version changed: ' + package)
    config = re.sub(r'-[IL]/opt/homebrew/Cellar/\S+', '', config)
    config += '\nCFLAGS+= ' + subprocess.check_output(['pkg-config', '--cflags', *packages], text=True).strip()
    config += '\nLIBS+= ' + package_flags + '\n'
    txp = work / 'texpresso'
    for folder in ['frontend', 'dvi', 'common', 'include']:
        shutil.copytree(source / 'src' / folder, txp / 'src' / folder)
    shutil.copy2(source / 'Makefile', txp / 'Makefile')
    (txp / 'test').mkdir()
    shutil.copy2(source / 'test/test_preview_svg.c', txp / 'test/test_preview_svg.c')
    (txp / 'Makefile.config').write_text(config)
    # A config newer than Makefile prevents the default dependency recipe.
    subprocess.run(['make', '-j2', 'common', 'texpresso'], cwd=txp, check=True)
    subprocess.run(['make', '-f', 'Makefile.config', '-f', 'Makefile', 'build/test-preview-svg'], cwd=txp, check=True)
    subprocess.run([str(txp / 'build/test-preview-svg')], check=True)
    (work / 'bin').mkdir()
    shutil.copy2(txp / 'build/texpresso', work / 'bin/texpresso')
    (work / 'bin/texpresso-xetex').symlink_to((args.base_bundle / 'bin/texpresso-xetex').resolve())
    patch = subprocess.check_output(['git', 'diff', '--binary'], cwd=source)
    manifest.update(kind='profiling-frontend', sourceDirty=True,
                    engineRevision=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip(),
                    featureInstrumentation={'patchSha256': hashlib.sha256(patch).hexdigest(),
                                            'buildScriptSha256': sha(__file__), 'packageVersions': versions,
                                            'baseManifestSha256': sha(args.base_bundle / 'build-manifest.json'),
                                            'configSha256': sha(txp / 'Makefile.config'),
                                            'workerReused': True})
    manifest['files'] = [{ 'path': 'bin/' + name, 'sha256': sha(work / 'bin' / name)}
                         for name in ['texpresso', 'texpresso-xetex']]
    (work / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (work / 'native-feature.patch').write_bytes(patch)
    (work / '.keep').write_text('Active offline rendering-feature measurements; remove after summary.\n')
    # Keep the usable profiling runtime, not duplicate binaries/object files.
    # Failed builds return before this point and retain their diagnostics.
    shutil.rmtree(txp)
    print('Profiling runtime: ' + str(work / 'bin/texpresso'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-source', type=Path, required=True,
                        help='Separate checkout of codex/render-cost-features; keep the release submodule pin unchanged')
    parser.add_argument('--dependency-config', type=Path, required=True)
    parser.add_argument('--base-bundle', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    build(parser.parse_args())
