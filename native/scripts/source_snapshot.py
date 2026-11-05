"""Create credential-free, single-commit Git snapshots for source releases."""
import subprocess
from pathlib import Path
from common import run


def snapshot(source, destination, revision):
    source, destination = Path(source), Path(destination)
    if run(['git', 'rev-parse', 'HEAD'], cwd=source, capture=True) != revision:
        raise ValueError('Source snapshot revision mismatch')
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Source snapshot destination is not empty')
    destination.mkdir(parents=True, exist_ok=True)
    run(['git', 'init', '-q', '--template=', destination])
    # Explicitly enumerate the commit's complete tree, including unchanged
    # blobs. A commit range would omit objects shared with excluded parents.
    objects = {revision, run(['git', 'rev-parse', 'HEAD^{tree}'], cwd=source, capture=True)}
    listing = run(['git', 'ls-tree', '-r', '-t', 'HEAD'], cwd=source, capture=True)
    for line in listing.splitlines():
        header = line.split('\t', 1)[0].split()
        if header[1] != 'commit':  # Submodules get their own sanitized snapshot.
            objects.add(header[2])
    with subprocess.Popen(['git', '-C', str(source), 'pack-objects', '--stdout',
                           '--no-reuse-delta', '--no-reuse-object', '--window=0'],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE) as pack:
        with subprocess.Popen(['git', '-C', str(destination), 'index-pack', '--stdin'],
                              stdin=pack.stdout, stdout=subprocess.DEVNULL) as unpack:
            pack.stdout.close()
            pack.stdin.write(('\n'.join(sorted(objects)) + '\n').encode())
            pack.stdin.close()
            if pack.wait() or unpack.wait():
                raise ValueError('Cannot create source snapshot object pack')
    (destination / '.git/shallow').write_text(revision + '\n')
    run(['git', '-c', 'core.logAllRefUpdates=false', 'update-ref', 'refs/heads/source', revision], cwd=destination)
    run(['git', 'symbolic-ref', 'HEAD', 'refs/heads/source'], cwd=destination)
    run(['git', 'reset', '--hard', '-q', 'HEAD'], cwd=destination)
