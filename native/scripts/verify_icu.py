#!/usr/bin/env python3
"""Compare stock ICU with our filtered/static ICU using local tools only."""
import argparse
import tempfile
from pathlib import Path
from common import NATIVE, load_lock, run
from icu_data import prepare

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--icu-prefix', type=Path, required=True)
args = parser.parse_args()
prefix = args.icu_prefix.resolve()
with tempfile.TemporaryDirectory(prefix='texpresso-icu-verify-') as directory:
    work = Path(directory)
    obj, _ = prepare(prefix, work / 'data', load_lock()['icu']['version'])
    source = NATIVE / 'tests/icu.c'
    baseline = work / 'baseline'
    filtered = work / 'filtered'
    run(['xcrun', 'clang', source, '-I' + str(prefix / 'include'),
         '-L' + str(prefix / 'lib'), '-licuuc', '-o', baseline])
    run(['xcrun', 'clang++', '-x', 'c', source, '-I' + str(prefix / 'include'),
         '-DU_STATIC_IMPLEMENTATION', '-x', 'none', prefix / 'lib/libicuuc.a', obj, '-o', filtered])
    expected = run([baseline], capture=True)
    actual = run([filtered], capture=True)
    if actual != expected:
        (NATIVE / '.work').mkdir(exist_ok=True)
        (NATIVE / '.work/icu-baseline.txt').write_text(expected)
        (NATIVE / '.work/icu-filtered.txt').write_text(actual)
        raise SystemExit('ICU behavior differs; comparison outputs saved under native/.work/')
    print('PASS: stock/filtered ICU agree on 12 line-breaking locales, bidi, encodings, normalization and script properties')
