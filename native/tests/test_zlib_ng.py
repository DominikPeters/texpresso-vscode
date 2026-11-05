"""Packaging must not silently ship the fallback PNG compressor."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from common import load_lock
from zlib_ng import verify_capabilities


class CompressionTests(unittest.TestCase):
    def test_locked_backend(self):
        verify_capabilities({'pngCompression': {'library': 'zlib-ng', 'level': 2,
                                              'version': load_lock()['zlibNg']['version']}})

    def test_rejects_fallback_wrong_level_and_wrong_version(self):
        for compression in ({}, {'library': 'zlib', 'level': 1},
                            {'library': 'zlib-ng', 'level': 1, 'version': '2.3.3'},
                            {'library': 'zlib-ng', 'level': 2, 'version': 'unlocked'}):
            with self.subTest(compression=compression), self.assertRaises(ValueError):
                verify_capabilities({'pngCompression': compression})
