#!/usr/bin/env python3
"""FNDB parser/resolution fixtures; actual MiKTeX parity runs on GitHub."""
import json
from pathlib import Path
import struct
import tempfile
import unittest
from catalogue import Catalogue,read_fndb


def database(path, entries):
    pool=bytearray(); offsets={}
    def string(value):
        if value not in offsets:
            offsets[value]=40+len(pool); pool.extend(value.encode()+b'\0')
        return offsets[value]
    records=[(string(name),string(directory),string(''),0) for name,directory in entries]
    table=40+len(pool); size=table+16*len(records)
    path.write_bytes(struct.pack('<10I',0x42444e46,5,0,40,table,1,len(records),3,size,0)+pool+
                     b''.join(struct.pack('<4I',*r) for r in records))


class CatalogueTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.folder=Path(self.temp.name)
        self.root=self.folder/'texmf'; (self.root/'tex/latex/base').mkdir(parents=True)
        self.db=self.folder/'root.fndb-5'
        self.entries=[('article.cls','tex/latex/base'),('plain.tex','tex/latex/base')]
        for name,directory in self.entries: (self.root/directory/name).write_text(name)
        database(self.db,self.entries)
        self.metadata={'version':'MiKTeX fixture','drives':{'D:\\':str(self.folder)},
            'roots':[{'windows':'D:\\texmf','linux':str(self.root),'fndb':str(self.db),'managed':True}],
            'types':{'tex':{'extensions':['.tex'],'alternates':['.sty','.cls'],
                            'paths':['D:/texmf/tex//']}},'config_watch':[]}
    def tearDown(self): self.temp.cleanup()
    def query(self,name,*extra):
        return ['D:\\bin','findtexmf.exe','--the-name-of-the-game=xetex',*extra,'--',name]
    def test_hits_misses_extensions_and_recursive_paths(self):
        c=Catalogue(self.metadata)
        self.assertEqual(c.resolve(self.query('article.cls')),(0,'D:\\texmf\\tex\\latex\\base\\article.cls\n'))
        self.assertTrue(c.resolve(self.query('plain'))[1].endswith('plain.tex\n'))
        self.assertEqual(c.resolve(self.query('absent.sty')),(1,''))
        self.assertIsNone(c.resolve(self.query('absent.sty','--must-exist')))
        self.assertIsNone(c.resolve(self.query('../outside.tex')))
        self.assertEqual(c.stats['reloads'],1)
    def test_journal_add_delete_and_incomplete_updates(self):
        c=Catalogue(self.metadata); journal=Path(str(self.db)+'.log')
        (self.root/'tex/latex/base/new.sty').write_text('new')
        journal.write_text('+new.sty;tex/latex/base;\n')
        self.assertTrue(c.resolve(self.query('new.sty'))[1].endswith('new.sty\n'))
        journal.write_text('+new.sty;tex/latex/base;\n-new.sty;tex/latex/base\n')
        self.assertEqual(c.resolve(self.query('new.sty')),(1,''))
        journal.write_text('+new.sty;tex/latex/base;')
        self.assertIsNone(c.resolve(self.query('new.sty')),'torn journal must fall back')
        journal.write_text('+new.sty;tex/latex/base;\n')
        self.assertTrue(c.resolve(self.query('new.sty'))[1].endswith('new.sty\n'))
    def test_database_replacement_and_bad_offsets(self):
        c=Catalogue(self.metadata)
        replacement=self.folder/'replacement'; database(replacement,[]); replacement.replace(self.db)
        self.assertEqual(c.resolve(self.query('article.cls')),(1,''))
        self.db.write_bytes(b'broken')
        self.assertIsNone(c.resolve(self.query('article.cls')))
        database(self.db,self.entries)
        data=bytearray(self.db.read_bytes()); struct.pack_into('<I',data,16,0xffffffff); self.db.write_bytes(data)
        with self.assertRaises(ValueError): read_fndb(self.db)
    def test_duplicate_precedence_and_unmanaged_tree(self):
        (self.root/'tex/latex/other').mkdir(); (self.root/'tex/latex/other/article.cls').write_text('other')
        database(self.db,self.entries+[('article.cls','tex/latex/other')])
        c=Catalogue(self.metadata)
        self.assertIsNone(c.resolve(self.query('article.cls')),'same-pattern duplicate needs reference tie-breaking')
        self.metadata['types']['tex']['paths']=['D:/texmf/tex/latex/base','D:/texmf/tex//']
        c=Catalogue(self.metadata)
        self.assertTrue(c.resolve(self.query('article.cls'))[1].endswith('base\\article.cls\n'))
        self.metadata['roots'][0]['managed']=False
        c=Catalogue(self.metadata)
        self.assertIsNone(c.resolve(self.query('not-indexed.sty')),'unmanaged filesystem fallback is required')
    def test_configuration_change_and_explicit_filetype(self):
        config=self.folder/'miktex.ini'; config.write_text('initial')
        self.metadata['config_watch']=[str(config)]; c=Catalogue(self.metadata)
        self.assertIsNone(c.resolve(self.query('x.unknown','--file-type=unsupported')))
        self.assertEqual(c.resolve(self.query('UnicodeData.txt','--file-type=tex')),(1,''))
        config.write_text('changed config')
        self.assertIsNone(c.resolve(self.query('absent.sty')))
    def test_case_and_requested_subdirectory(self):
        c=Catalogue(self.metadata)
        self.assertTrue(c.resolve(self.query('ARTICLE.CLS'))[1].endswith('article.cls\n'))
        self.assertTrue(c.resolve(self.query('base/article.cls'))[1].endswith('base\\article.cls\n'))
        self.assertEqual(c.resolve(self.query('notbase/article.cls')),(1,''))


if __name__=='__main__': unittest.main()
