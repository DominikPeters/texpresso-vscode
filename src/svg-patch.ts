import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Index XML spans, without building a second attribute/string tree. The browser
// separately validates every mounted element/attribute. Unsupported SVG stays an image.
interface Node { name: string; start: number; end: number; openEnd: number; children: Node[]; count: number }
export interface SvgDocument { text: string; root: Node }
export interface SvgSplice { path: number[]; start: number; remove: number; xml: string }
export interface SvgPatch { base: string; operations: SvgSplice[] }
const tags = new Set(['svg', 'defs', 'g', 'path', 'use', 'rect', 'clipPath', 'mask']);
export function parseSvg(text: string, maxMs = 12): SvgDocument | undefined {
  if (text.length > 2 * 1024 * 1024 || /<!|<\?/.test(text)) { return; }
  const deadline = performance.now() + maxMs;
  const tokens = /<(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  let match: RegExpExecArray | null, root: Node | undefined, end = 0, count = 0, nodes = 0;
  const stack: Node[] = [];
  while ((match = tokens.exec(text))) {
    if (++count % 256 === 0 && performance.now() > deadline) { return; }
    if (count > 40000 || text.slice(end, match.index).trim()) { return; }
    const raw = match[0]; end = tokens.lastIndex;
    const name = raw.match(/^<\/?([A-Za-z][\w.-]*)\b/)?.[1];
    if (!name || !tags.has(name)) { return; }
    if (raw.startsWith('</')) {
      const node = stack.pop();
      if (!node || node.name !== name || !/^<\/[\w.-]+\s*>$/.test(raw)) { return; }
      node.end = end;
      if (stack.length) { stack[stack.length - 1].count += node.count; }
    } else {
      if (++nodes > 20000) { return; }
      const node: Node = { name, start: match.index, end, openEnd: end, children: [], count: 1 };
      if (stack.length) { stack[stack.length - 1].children.push(node); }
      else if (root) { return; } else { root = node; }
      if (!raw.endsWith('/>')) { stack.push(node); if (stack.length > 32) { return; } }
      else if (stack.length) { stack[stack.length - 1].count++; }
    }
  }
  if (performance.now() > deadline || stack.length || !root || root.name !== 'svg' || text.slice(end).trim()) { return; }
  return { text, root };
}

export function diffSvg(old: SvgDocument, next: SvgDocument, base: string,
  limits: { maxMs?: number; maxNodes?: number; maxBytes?: number; maxOperations?: number } = {}): SvgPatch | undefined {
  const deadline = performance.now() + (limits.maxMs ?? 5);
  const maxNodes = limits.maxNodes ?? 256, maxOperations = limits.maxOperations ?? 64;
  const maxBytes = Math.min(limits.maxBytes ?? 65536, next.text.length * 0.35);
  const operations: SvgSplice[] = [];
  let affected = 0, bytes = 0, stopped = false, checks = 0;
  const raw = (doc: SvgDocument, node: Node) => doc.text.slice(node.start, node.end);
  const same = (a: Node, b: Node) => a.end - a.start === b.end - b.start && raw(old, a) === raw(next, b);
  const compatible = (a: Node, b: Node) => a.children.length && b.children.length &&
    old.text.slice(a.start, a.openEnd) === next.text.slice(b.start, b.openEnd);
  const check = () => {
    if (++checks % 32 === 0 && performance.now() > deadline) { stopped = true; }
    return !stopped;
  };
  const splice = (a: Node[], b: Node[], i: number, n: number, j: number, m: number, path: number[]) => {
    affected += a.slice(i, i + n).reduce((sum, node) => sum + node.count, 0) + b.slice(j, j + m).reduce((sum, node) => sum + node.count, 0);
    if (affected > maxNodes || operations.length >= maxOperations) { stopped = true; return; }
    const xml = b.slice(j, j + m).map(node => raw(next, node)).join('');
    bytes += xml.length + path.length * 8 + 80;
    if (bytes > maxBytes) { stopped = true; return; }
    operations.push({ path, start: i, remove: n, xml });
  };
  const children = (a: Node, b: Node, path: number[]) => {
    const left = a.children, right = b.children;
    let i = 0, j = 0, ae = left.length, be = right.length;
    while (i < ae && j < be && check() && same(left[i], right[j])) { i++; j++; }
    while (ae > i && be > j && check() && same(left[ae - 1], right[be - 1])) { ae--; be--; }
    while ((i < ae || j < be) && check()) {
      if (i < ae && j < be && same(left[i], right[j])) { i++; j++; continue; }
      if (i < ae && j < be && compatible(left[i], right[j])) { children(left[i], right[j], [...path, i]); i++; j++; continue; }
      if (ae - i === be - j) { splice(left, right, i++, 1, j++, 1, path); continue; }
      // A bounded nearby anchor preserves unchanged nodes around insertions.
      let anchor: [number, number] | undefined;
      for (let distance = 1; distance <= 16 && !anchor && check(); distance++) {
        for (let x = 0; x <= distance; x++) {
          const y = distance - x;
          if (i + x < ae && j + y < be && same(left[i + x], right[j + y])) { anchor = [x, y]; break; }
        }
      }
      if (anchor) { splice(left, right, i, anchor[0], j, anchor[1], path); i += anchor[0]; j += anchor[1]; }
      else { splice(left, right, i, ae - i, j, be - j, path); break; }
    }
  };
  if (performance.now() > deadline || old.text.slice(0, old.root.openEnd) !== next.text.slice(0, next.root.openEnd)) { return; }
  children(old.root, next.root, []);
  const patch = { base, operations: operations.reverse() };
  if (stopped || performance.now() > deadline || Buffer.byteLength(JSON.stringify(patch)) > maxBytes) { return; }
  return patch;
}

// Use the exact outline as the identity of a standalone font path. Unlike
// MuPDF's encounter-order font counter, this survives adding an earlier font.
// Matching geometry is reusable under each original <use> transform/paint.
export function canonicalSvg(text: string, maxMs = 20): SvgDocument | undefined {
  const start = performance.now(), doc = parseSvg(text, maxMs);
  if (!doc) { return; }
  const fonts: { node: Node; id: string; shape: string }[] = [];
  const names = new Map<string, string>(), shapes = new Map<string, string>();
  for (const defs of doc.root.children.filter(node => node.name === 'defs')) {
    for (const node of defs.children) {
      const match = text.slice(node.start, node.end).match(/^<path\s+id="(font_\d+_\d+)"\s+d="([^"&]*)"\s*\/>$/);
      if (!match) { continue; }
      const [, oldId, shape] = match;
      const id = 'g_' + createHash('sha256').update(shape).digest().subarray(0, 16).toString('base64url');
      // Verify equality even on a digest collision; never alias unequal paths.
      if ((shapes.has(id) && shapes.get(id) !== shape) || (names.has(oldId) && names.get(oldId) !== id)) { return; }
      names.set(oldId, id); shapes.set(id, shape); fonts.push({ node, id, shape });
    }
  }
  if (!fonts.length) { return doc; }
  const ordered = [...shapes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let result = '', offset = 0;
  for (let i = 0; i < fonts.length; i++) {
    const node = fonts[i].node, entry = ordered[i];
    result += text.slice(offset, node.start) + (entry ? `<path id="${entry[0]}" d="${entry[1]}"/>` : '');
    offset = node.end;
  }
  result += text.slice(offset);
  result = result.replace(/(\s(?:id|(?:xlink:)?href))="(#?)(font_\d+_\d+)"/g,
    (whole, attribute, prefix, name) => names.has(name) ? `${attribute}="${prefix}${names.get(name)}"` : whole);
  const remaining = maxMs - (performance.now() - start);
  return remaining > 0 ? parseSvg(result, remaining) : undefined;
}
