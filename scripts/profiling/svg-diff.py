#!/usr/bin/env python3
"""Measure exact SVG patches and glyph ID stability; do not infer browser costs."""
import difflib
import gzip
import json
import pathlib
import sys
import xml.etree.ElementTree as ET

root = pathlib.Path(sys.argv[1])
def dom_patch(old, new, path=()):
    """Experimental child splices/attribute updates; no stable SVG IDs assumed."""
    if old.tag != new.tag:
        raise ValueError('Unmatched root element')
    if old.text and old.text.strip() or new.text and new.text.strip():
        raise ValueError('Probe expects path-based SVG without text nodes')
    edits = []
    if old.attrib != new.attrib:
        edits.append({'op': 'attributes', 'path': path, 'attributes': new.attrib})
    old_children, new_children = list(old), list(new)
    key = lambda node: ET.tostring(node, encoding='unicode').strip()
    matcher = difflib.SequenceMatcher(a=list(map(key, old_children)), b=list(map(key, new_children)), autojunk=False)
    for op, a, b, c, d in reversed(matcher.get_opcodes()):
        if op == 'equal':
            continue
        if b-a == d-c and all(old_children[a+i].tag == new_children[c+i].tag for i in range(b-a)):
            for i in reversed(range(b-a)):
                edits.extend(dom_patch(old_children[a+i], new_children[c+i], path + (a+i,)))
        else:
            edits.append({'op': 'splice', 'path': path, 'start': a, 'remove': b-a,
                          'xml': ''.join(key(node) for node in new_children[c:d])})
    return edits

results = json.loads((root / 'native.json').read_text())
for case in results:
    before = (root / f"{case['kind']}-baseline.svg").read_bytes()
    case['diffs'] = []
    for edit in ['inserted', 'font']:
        after = (root / f"{case['kind']}-{edit}.svg").read_bytes()
        prefix = 0
        while prefix < min(len(before), len(after)) and before[prefix] == after[prefix]:
            prefix += 1
        suffix = 0
        while suffix < min(len(before), len(after)) - prefix and before[-suffix-1] == after[-suffix-1]:
            suffix += 1
        end = len(after) - suffix if suffix else len(after)
        span = {'start': prefix, 'remove': len(before) - prefix - suffix, 'insert': after[prefix:end].decode()}
        rebuilt = before[:prefix] + span['insert'].encode() + (before[-suffix:] if suffix else b'')
        assert rebuilt == after
        lines_before, lines_after = before.decode().splitlines(keepends=True), after.decode().splitlines(keepends=True)
        matcher = difflib.SequenceMatcher(a=lines_before, b=lines_after, autojunk=False)
        edits = [[a, b-a, ''.join(lines_after[c:d])] for op, a, b, c, d in matcher.get_opcodes() if op != 'equal']
        rebuilt_lines = list(lines_before)
        for start, count, value in reversed(edits):
            rebuilt_lines[start:start+count] = value.splitlines(keepends=True)
        assert ''.join(rebuilt_lines).encode() == after
        paths = lambda data: {e.attrib['id']: e.attrib['d'] for e in ET.fromstring(data).iter()
                              if e.tag.endswith('}path') and 'id' in e.attrib and 'd' in e.attrib}
        forward_patch = dom_patch(ET.fromstring(before), ET.fromstring(after))
        backward_patch = dom_patch(ET.fromstring(after), ET.fromstring(before))
        (root / f"{case['kind']}-{edit}-dom.json").write_text(json.dumps({'forward': forward_patch, 'backward': backward_patch}))
        old_paths, new_paths = paths(before), paths(after)
        retained = sum(new_paths.get(key) == value for key, value in old_paths.items())
        pack = lambda value: json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()
        case['diffs'].append({
            'edit': edit, 'svgBytes': len(after), 'svgGzipBytes': len(gzip.compress(after, mtime=0)),
            'spanPatchBytes': len(pack(span)), 'spanPatchGzipBytes': len(gzip.compress(pack(span), mtime=0)),
            'linePatchBytes': len(pack(edits)), 'linePatchGzipBytes': len(gzip.compress(pack(edits), mtime=0)),
            'lineEdits': len(edits), 'domOperations': len(forward_patch),
            'domPatchBytes': len(pack(forward_patch)), 'domPatchGzipBytes': len(gzip.compress(pack(forward_patch), mtime=0)), 'oldGlyphPaths': len(old_paths), 'retainedGlyphPathsWithSameId': retained,
            'newGlyphPaths': len(new_paths),
        })
(root / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
for case in results:
    print(case['kind'], 'undo exact:', case['undoExact'])
    for diff in case['diffs']:
        print(' ', json.dumps(diff))
