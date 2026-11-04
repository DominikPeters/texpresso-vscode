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
        self.metadata['types']['tex']['paths']=['D:/texmf/tex//']
        c=Catalogue(self.metadata)
        self.assertEqual(c.resolve(self.query('not-indexed.sty')),(1,''))
        (self.root/'tex/latex/base/not-indexed.sty').write_text('unindexed')
        self.assertIsNone(c.resolve(self.query('not-indexed.sty')),'unindexed filesystem hit needs reference ordering')
    def test_configuration_change_and_explicit_filetype(self):
        config=self.folder/'miktex.ini'; config.write_text('initial')
        self.metadata['config_watch']=[str(config)]; c=Catalogue(self.metadata)
        self.assertIsNone(c.resolve(self.query('x.unknown','--file-type=unsupported')))
        self.assertEqual(c.resolve(self.query('UnicodeData.txt','--file-type=tex')),(1,''))
        config.write_text('changed config')
        self.assertIsNone(c.resolve(self.query('absent.sty')))
    def test_unexported_filetype_falls_back(self):
        self.metadata['other_extensions']=['.txt','.fmt']
        c=Catalogue(self.metadata)
        self.assertIsNone(c.resolve(self.query('document.txt')))
        self.assertIsNone(c.resolve(self.query('xetex.fmt')))
        self.assertEqual(c.resolve(self.query('UnicodeData.txt','--file-type=tex')),(1,''))
        self.assertEqual(c.resolve(self.query('unknown.extension')),(1,''))
    def test_windows_working_directory(self):
        temp=self.folder/'temp'; temp.mkdir(); (temp/'local.tex').write_text('local')
        self.metadata['working_directory']='D:\\temp'
        self.metadata['types']['tex']['paths'].insert(0,'.')
        c=Catalogue(self.metadata)
        self.assertEqual(c.resolve(self.query('local.tex')),(0,'D:\\temp\\local.tex\n'))
        self.assertTrue(c.resolve(self.query('article.cls'))[1].endswith('article.cls\n'))
        self.assertEqual(c.resolve(self.query('absent.sty')),(1,''))
    def test_explicit_frozen_snapshot(self):
        c=Catalogue(self.metadata,snapshot=True)
        self.assertTrue(c.resolve(self.query('article.cls'))[1].endswith('article.cls\n'))
        database(self.db,[])
        self.assertTrue(c.resolve(self.query('article.cls'))[1].endswith('article.cls\n'))
        self.assertEqual(c.stats['reloads'],1)
        (self.root/'tex/latex/base/article.cls').unlink()
        self.assertEqual(c.resolve(self.query('article.cls')),(1,''),'existing indexed paths still validate the file')
    def test_frozen_misses_are_retained_but_installer_requests_are_not(self):
        temp=self.folder/'temp'; temp.mkdir()
        self.metadata['working_directory']='D:\\temp'
        self.metadata['types']['tex']['paths'].insert(0,'.')
        c=Catalogue(self.metadata,snapshot=True)
        query=self.query('absent.sty')
        self.assertEqual(c.resolve(query),(1,''))
        self.assertIsNone(c.resolve(self.query('absent.sty','--must-exist')))
        (temp/'absent.sty').write_text('new input after snapshot')
        self.assertEqual(c.resolve(query),(1,''),'frozen snapshot retains proven misses until restart')
        self.assertEqual(c.resolve(self.query('absent.sty','--must-exist')),(0,'D:\\temp\\absent.sty\n'))
        self.assertEqual(Catalogue(self.metadata).resolve(query),(0,'D:\\temp\\absent.sty\n'))
    def test_case_and_requested_subdirectory(self):
        c=Catalogue(self.metadata)
        self.assertTrue(c.resolve(self.query('ARTICLE.CLS'))[1].endswith('article.cls\n'))
        self.assertTrue(c.resolve(self.query('base/article.cls'))[1].endswith('base\\article.cls\n'))
        self.assertEqual(c.resolve(self.query('notbase/article.cls')),(1,''))


if __name__=='__main__': unittest.main()
