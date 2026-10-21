import json
import sys
import unittest
from pathlib import Path

NATIVE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(NATIVE / 'scripts'))
from icu_data import keep_item


class UnicodeCoverage(unittest.TestCase):
    def setUp(self):
        self.profile = json.loads((NATIVE / 'profiles/icu-filter.json').read_text())

    def test_all_scripts_keep_line_breaking_data(self):
        for item in ['brkitr/root.res', 'brkitr/ja.res', 'brkitr/zh_Hant.res',
                     'brkitr/thaidict.dict', 'brkitr/khmerdict.dict',
                     'brkitr/laodict.dict', 'brkitr/burmesedict.dict',
                     'brkitr/cjdict.dict', 'brkitr/line_normal_cj.brk']:
            with self.subTest(item=item):
                self.assertTrue(keep_item(item, self.profile))

    def test_encodings_and_core_unicode_are_preserved(self):
        for item in ['ibm-943_P15A-2003.cnv', 'windows-1252.cnv', 'cnvalias.icu',
                     'nfkc.nrm', 'uemoji.icu', 'ulayout.icu', 'root.res',
                     'pool.res', 'supplementalData.res', 'likelySubtags.res']:
            with self.subTest(item=item):
                self.assertTrue(keep_item(item, self.profile))

    def test_only_unused_locale_features_are_removed(self):
        for item in ['en.res', 'en_GB.res', 'zh_Hant_TW.res', 'fil.res',
                     'coll/root.res', 'zone/en.res', 'curr/en.res',
                     'unit/en.res', 'translit/root.res', 'lang/en.res']:
            with self.subTest(item=item):
                self.assertFalse(keep_item(item, self.profile))


if __name__ == '__main__':
    unittest.main()
