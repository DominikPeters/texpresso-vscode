#!/usr/bin/env python3
"""Estimate warm glyph-definition transfer savings in the generated SVG fixtures.

This diagnostic recognizes MuPDF's simple font_* path definitions in these
fixtures. It is not a general SVG parser or a production resource splitter.
The stripped document has unresolved references and is not a renderable image.
Its compressed size estimates the body cost after a receiver knows all glyphs;
it excludes dictionary protocol overhead and does not measure rendering speed.
"""
import argparse
import gzip
import json
from pathlib import Path
import re


def analyze(path):
    data = path.read_bytes()
    pattern = rb'<path\s+id="font_\d+_\d+"[^>]*?/>\s*'
    glyphs = re.findall(pattern, data)
    body = re.sub(pattern, b'', data)
    return {
        'fixture': path.stem,
        'glyph_definitions': len(glyphs),
        'glyph_uses': len(re.findall(rb'xlink:href="#font_', data)),
        'svg_bytes': len(data),
        'glyph_definition_bytes': sum(map(len, glyphs)),
        'gzip1_bytes': len(gzip.compress(data, compresslevel=1, mtime=0)),
        'gzip1_without_glyph_definitions': len(gzip.compress(body, compresslevel=1, mtime=0)),
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    print(json.dumps({
        'method': 'Remove simple glyph path definitions; gzip remaining bytes at level 1. '
                  'Warm-cache transfer estimate only; no protocol overhead or render measurements.',
        'results': [analyze(args.directory / f'{name}-1600.svg')
                    for name in ('text', 'vector', 'raster')],
    }, indent=2))
