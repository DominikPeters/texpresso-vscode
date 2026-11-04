#!/usr/bin/env python3
"""Small cache correctness fixtures; no native builds, Windows or downloads."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('cache_proxy',Path(__file__).with_name('cache_proxy.py'))
proxy = importlib.util.module_from_spec(spec); spec.loader.exec_module(proxy)


class CacheTests(unittest.TestCase):
    def test_replaced_source_invalidates_path_and_mirror(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); source = folder/'café font.otf'; source.write_bytes(b'old font')
            record = {'linux': str(source), 'stamp': proxy.stamp(source)}
            entry = folder/'entry.json'; proxy.write_record(entry,record)
            copied = Path(proxy.mirror(record,folder/'cache'))
            self.assertEqual(copied.read_bytes(),b'old font')
            proxy.write_record(folder/'cache/paths/original',record)
            proxy.write_record(folder/'cache/lookups/original',record)
            proxy.invalidate_lookups(folder/'cache')
            self.assertFalse((folder/'cache/lookups/original').exists())
            self.assertTrue((folder/'cache/paths/original').exists())
            replacement = folder/'new'; replacement.write_bytes(b'new font'); replacement.replace(source)
            self.assertIsNone(proxy.read_record(entry))
            proxy.refresh_mirrors(folder/'cache')
            self.assertEqual(copied.read_bytes(),b'new font')
            record['stamp'] = proxy.stamp(source)
            self.assertEqual(Path(proxy.mirror(record,folder/'cache')).read_bytes(),b'new font')
            source.unlink(); self.assertIsNone(proxy.read_record(entry))
            proxy.refresh_mirrors(folder/'cache')
            self.assertFalse(copied.exists())

    def test_process_restarts_reuse_positives_but_retry_misses(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); source = folder/'package.sty'; source.write_text('first')
            helper = folder/'helper'
            helper.write_text('#!'+sys.executable+'\n'+'''import base64,os,pathlib,sys
folder=pathlib.Path(os.environ['FIXTURE'])
for line in sys.stdin:
    args=base64.b64decode(line.strip().split(':',1)[1]).decode().split('\\0')
    with (folder/'calls').open('a') as log: log.write(args[-1]+'\\n')
    exists=(folder/args[-1]).exists()
    print(('0:'+base64.b64encode(b'C:\\\\fixture\\\\'+args[-1].encode()).decode()) if exists else '1:',flush=True)
'''); helper.chmod(0o755)
            converter=folder/'converter'
            converter.write_text('#!'+sys.executable+'\nimport os,pathlib,sys\nprint(pathlib.Path(os.environ["FIXTURE"])/sys.argv[-1].split("\\\\")[-1])\n');converter.chmod(0o755)
            entry=folder/'powershell.exe'; entry.symlink_to(Path(__file__).with_name('cache_proxy.py').resolve())
            env={**os.environ,'FIXTURE':str(folder),'TXP_BENCH_CACHE_MODE':'paths','TXP_BENCH_CACHE':str(folder/'cache'),
                 'TXP_BENCH_STATS':str(folder/'stats'),'TXP_BENCH_REAL_POWERSHELL':str(helper),'TXP_BENCH_REAL_WSLPATH':str(converter)}
            def lookup(name):
                data='\0'.join(['C:\\fixture','findtexmf.exe','--',name]).encode()
                result=subprocess.run([str(entry)],input='1000:'+base64.b64encode(data).decode()+'\n',text=True,
                                      capture_output=True,env=env,check=True,timeout=10)
                return result.stdout
            self.assertTrue(lookup('package.sty').startswith('0:'))
            self.assertTrue(lookup('package.sty').startswith('0:'))
            self.assertEqual((folder/'calls').read_text().splitlines(),['package.sty'])
            self.assertTrue(lookup('later.sty').startswith('1:'))
            (folder/'later.sty').write_text('newly installed')
            self.assertTrue(lookup('later.sty').startswith('0:'))
            self.assertEqual((folder/'calls').read_text().splitlines(),['package.sty','later.sty','later.sty'])
            source.write_text('modified package content')
            self.assertTrue(lookup('package.sty').startswith('0:'))
            self.assertEqual(len((folder/'calls').read_text().splitlines()),4)


if __name__ == '__main__': unittest.main()
