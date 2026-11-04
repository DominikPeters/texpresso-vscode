#!/usr/bin/env python3
"""Benchmark-only interop proxy: no extension/runtime settings are changed.

Positive lookup records validate original file identity/size/timestamps. Misses
are never retained. Mirroring additionally copies the validated file into Linux.
Installation ranking/database changes require an explicit cache reset; this is
an experiment under a frozen package installation, not a production cache.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def stamp(path):
    s = Path(path).stat()
    return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns]


def read_record(path):
    try:
        value = json.loads(path.read_text())
        return value if stamp(value['linux']) == value['stamp'] else None
    except (OSError, ValueError, KeyError):
        return None


def write_record(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.'+str(os.getpid())+'.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def mirror(record, cache):
    target = cache/'files'/digest(record['linux'])
    metadata = target.with_suffix('.json')
    try:
        current = json.loads(metadata.read_text())
    except (OSError, ValueError):
        current = None
    if not target.exists() or current != record['stamp']:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix('.'+str(os.getpid())+'.tmp')
        shutil.copyfile(record['linux'], temporary)
        temporary.replace(target)
        write_record(metadata, record['stamp'])
    return str(target)


def refresh_mirrors(cache):
    # Refresh original dependencies before the frontend can start its worker's
    # format validation. Otherwise a stale local copy could hide a changed input.
    for path in (cache/'paths').glob('*'):
        record = None
        try:
            record = json.loads(path.read_text())
            current = stamp(record['linux'])
            if current != record['stamp']:
                record['stamp'] = current
                mirror(record, cache)
                write_record(path, record)
        except FileNotFoundError:
            if record is None: continue
            target = cache/'files'/digest(record['linux'])
            target.unlink(missing_ok=True)
            target.with_suffix('.json').unlink(missing_ok=True)
            path.unlink(missing_ok=True)


def invalidate_lookups(cache):
    # Absolute path records also track mirrored format dependencies. Keep them
    # when ranking changes, so the next startup still validates their originals.
    for item in (cache/'lookups').glob('*'):
        item.unlink(missing_ok=True)


def main():
    mode = os.environ['TXP_BENCH_CACHE_MODE']
    cache = Path(os.environ['TXP_BENCH_CACHE'])
    stats = Path(os.environ['TXP_BENCH_STATS'])
    stats.mkdir(parents=True, exist_ok=True)
    tool = Path(sys.argv[0]).name
    real_path = os.environ['TXP_BENCH_REAL_WSLPATH']
    if tool == 'wslpath':
        # Match the actual provider call; delegate every other invocation.
        if mode == 'mirror' and len(sys.argv) == 3 and sys.argv[1] == '-u':
            record = read_record(cache/'paths'/digest(sys.argv[2]))
            if record:
                print(mirror(record, cache))
                return
        os.execv(real_path, [real_path, *sys.argv[1:]])
    if mode == 'mirror': refresh_mirrors(cache)
    child = None
    counts = {'requests': 0, 'hits': 0, 'remote_ms': 0, 'lookup_ms': 0, 'positive': 0, 'misses': 0}
    try:
        for line in sys.stdin:
            started = time.monotonic()
            _, encoded = line.strip().split(':', 1)
            args = base64.b64decode(encoded).decode('utf8').split('\0')
            counts['requests'] += 1
            lookup = args[1] == 'findtexmf.exe' and '--version' not in args
            key = cache/'lookups'/digest(encoded)
            record = read_record(key) if lookup and mode != 'none' else None
            if record:
                response = record['response']
                counts['hits'] += 1
            else:
                if child is None:
                    child = subprocess.Popen([os.environ['TXP_BENCH_REAL_POWERSHELL'], *sys.argv[1:]],
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
                remote = time.monotonic()
                child.stdin.write(line); child.stdin.flush()
                response = child.stdout.readline()
                counts['remote_ms'] += (time.monotonic()-remote)*1000
                if not response:
                    raise RuntimeError('Windows helper exited')
                status, body = response.strip().split(':', 1)
                if lookup and status == '0' and mode == 'none':
                    counts['positive'] += 1
                elif lookup and status == '0':
                    windows = base64.b64decode(body).decode('utf8').strip().strip('"')
                    try:
                        linux = subprocess.check_output([real_path, '-u', windows], text=True).strip()
                        record = {'response': response, 'windows': windows, 'linux': linux, 'stamp': stamp(linux)}
                    except (OSError, subprocess.CalledProcessError):
                        record = None
                    if record:
                        counts['positive'] += 1
                        if mode != 'none':
                            write_record(key, record)
                            write_record(cache/'paths'/digest(windows), record)
                elif lookup:
                    counts['misses'] += 1
                # A regenerated user map may outrank an unchanged system map.
                if args[1] == 'miktex.exe' and status == '0' and mode != 'none':
                    invalidate_lookups(cache)
            counts['lookup_ms'] += (time.monotonic()-started)*1000
            sys.stdout.write(response); sys.stdout.flush()
    finally:
        write_record(stats/('proxy-'+str(os.getpid())+'.json'), counts)
        if child:
            child.stdin.close()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()


if __name__ == '__main__':
    main()
