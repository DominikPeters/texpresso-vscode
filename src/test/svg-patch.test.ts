import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseSvg, canonicalSvg, diffSvg, type SvgPatch } from '../svg-patch';

const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="a" d="M0 0L1 1"/></defs>${body}</svg>`;
function apply(text: string, patch: SvgPatch): string {
  for (const op of patch.operations) {
    const doc = parseSvg(text, 1000)!;
    let parent = doc.root;
    for (const i of op.path) { parent = parent.children[i]; }
    const start = parent.children[op.start]?.start ?? text.lastIndexOf('</', parent.end);
    const end = op.remove ? parent.children[op.start + op.remove - 1].end : start;
    text = text.slice(0, start) + op.xml + text.slice(end);
  }
  return text;
}
const path = (n: number) => `<path d="M${n} 0L${n + 1} 1"/>`;

test('SVG splices preserve order, definitions and nested paths across insertions, edits, deletion and undo', () => {
  const old = wrap(Array.from({ length: 80 }, (_, i) => path(i)).join(''));
  const cases = [old.replace(path(20), path(500) + path(20)), old.replace(path(20), path(500)), old.replace(path(20), ''),
    old.replace('</defs>', '<path id="b" d="M2 2L3 3"/></defs>').replace(path(30), '<use href="#b"/>'),
    old.replace(path(20), `<g>${path(500)}</g>`).replace(path(40), path(600))];
  for (const next of cases) {
    const patch = diffSvg(parseSvg(old, 1000)!, parseSvg(next, 1000)!, 'base', { maxMs: 1000 })!;
    assert.ok(patch); assert.equal(apply(old, patch), next);
    const undo = diffSvg(parseSvg(next, 1000)!, parseSvg(old, 1000)!, 'next', { maxMs: 1000 })!;
    assert.ok(undo); assert.equal(apply(next, undo), old);
  }
});

test('SVG diff rejects broad changes, changed root geometry, unsupported XML and explicit work budgets', () => {
  const old = wrap(Array.from({ length: 400 }, (_, i) => path(i)).join(''));
  const next = wrap(Array.from({ length: 400 }, (_, i) => path(i + 1000)).join(''));
  assert.equal(diffSvg(parseSvg(old, 1000)!, parseSvg(next, 1000)!, 'base', { maxMs: 1000 }), undefined);
  assert.equal(diffSvg(parseSvg(old, 1000)!, parseSvg(old.replace('<svg ', '<svg width="20" '), 1000)!, 'base'), undefined);
  assert.equal(diffSvg(parseSvg(old, 1000)!, parseSvg(old.replace(path(20), path(500)), 1000)!, 'base', { maxNodes: 1 }), undefined);
  for (const xml of ['<!DOCTYPE svg><svg/>', '<svg><script/></svg>', '<svg><image/></svg>', '<svg><path></g></svg>', '<svg>text</svg>', '<svg/><svg/>']) {
    assert.equal(parseSvg(xml), undefined);
  }
  const escaped = '<svg><path data-text="&quot; > &lt;" d="M0 0L1 1"/></svg>';
  assert.ok(parseSvg(escaped));
});

test('canonical font definitions stabilize first-use order while leaving other SVG content in place', () => {
  const a = '<path id="font_1_20" d="M1 1"/>', b = '<path id="font_1_10" d="M2 2"/>';
  const clip = '<clipPath id="clip"><path d="M3 3"/></clipPath>';
  const before = `<svg><defs>${a}${clip}${b}</defs><use href="#font_1_20"/></svg>`;
  const after = `<svg><defs>${b}${clip}${a}</defs><use href="#font_1_20"/></svg>`;
  const normalized = canonicalSvg(before, 1000)!.text;
  assert.equal(normalized, canonicalSvg(after, 1000)!.text);
  assert.ok(normalized.includes(clip));
  assert.ok(!normalized.includes('font_'));
  assert.equal(normalized, canonicalSvg(before.replaceAll('font_1_', 'font_99_'), 1000)!.text);
});

test('equal glyph outlines are deduplicated with stable references', () => {
  const source = '<svg><defs><path id="font_1_10" d="M1 1"/><path id="font_2_20" d="M1 1"/></defs><use href="#font_1_10"/><use href="#font_2_20"/></svg>';
  const result = canonicalSvg(source, 1000)!;
  assert.equal(result.root.children[0].children.length, 1);
  const references = [...result.text.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  assert.equal(references.length, 2); assert.equal(references[0], references[1]);
});

test('SVG indexing enforces the same element budget as the webview', () => {
  assert.equal(parseSvg('<svg>' + '<path d="M0 0"/>'.repeat(20000) + '</svg>', 1000), undefined);
});

test('canonical span remapping matches an independent parse across nested references and removed duplicate outlines', () => {
  for (let variation = 0; variation < 40; variation++) {
    const font = (n: number, shape = n) => `<path id="font_${variation}_${n}" d="M${shape} 0L${shape + 1} 2"/>`;
    const use = (n: number) => `<use xlink:href="#font_${variation}_${n}" transform="translate(${n} 2)"/>`;
    const first = Array.from({ length: 8 }, (_, i) => font((i + variation) % 8)).join('');
    const duplicate = font(8, 2);
    const source = `<svg width="200"><defs>${first}<clipPath id="clip"><g>${path(50)}</g></clipPath>${duplicate}</defs>` +
      `<g id="font_${variation}_2"><g>${use(2)}${use(8)}</g>${use(7)}</g>` +
      `<defs>${font(9)}</defs><g>${use(9)}<rect x="1"/></g></svg>`;
    const result = canonicalSvg(source, 1000)!;
    assert.ok(result);
    assert.deepEqual(result.root, parseSvg(result.text, 1000)!.root);
    assert.ok(!result.text.includes('font_'));
    const next = canonicalSvg(source.replace('translate(2 2)', 'translate(8 3)'), 1000)!;
    const patch = diffSvg(result, next, 'base', { maxMs: 1000, maxBytes: 65536 })!;
    assert.ok(patch); assert.equal(apply(result.text, patch), next.text);
  }
});

test('cached glyph identities never bypass structural validation or conflicting definition checks', () => {
  const good = '<svg><defs><path id="font_1_1" d="M1 1"/></defs><use href="#font_1_1"/></svg>';
  assert.ok(canonicalSvg(good, 1000));
  assert.equal(canonicalSvg(good.replace('</svg>', '<script/></svg>'), 1000), undefined);
  assert.equal(canonicalSvg(good.replace('</defs>', '<path id="font_1_1" d="M9 9"/></defs>'), 1000), undefined);
  assert.equal(canonicalSvg(good, -1), undefined);
});
