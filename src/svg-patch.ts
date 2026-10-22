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

// Outline identities recur across almost every text edit. Retain only this small,
// deterministic computation, never documents or validation decisions.
const glyphIds = new Map<string, string>();
const glyphCacheLimit = 256 * 1024;
let glyphCacheBytes = 0;
function glyphId(shape: string): string {
  const cached = glyphIds.get(shape);
  if (cached) { glyphIds.delete(shape); glyphIds.set(shape, cached); return cached; }
  const id = 'g_' + createHash('sha256').update(shape).digest().subarray(0, 16).toString('base64url');
  const cost = (shape.length + id.length) * 2 + 64;
  if (cost <= glyphCacheLimit) {
    // RegExp captures may share the original multi-megabyte SVG backing store.
    // Own the cached outline's UTF-16 storage so this bound covers retained text.
    const owned = Buffer.from(shape, 'utf16le').toString('utf16le');
    glyphIds.set(owned, id); glyphCacheBytes += cost;
    while (glyphCacheBytes > glyphCacheLimit) {
      const oldest = glyphIds.keys().next().value as string;
      glyphCacheBytes -= (oldest.length + glyphIds.get(oldest)!.length) * 2 + 64;
      glyphIds.delete(oldest);
    }
  }
  return id;
}

interface Rewrite { start: number; end: number; text: string; node?: Node }
// Rewrites only replace standalone paths or attribute values with generated ASCII
// identifiers. Reuse the validated tree and remap its spans in document order,
// instead of tokenizing and allocating a second complete node tree.
function rewriteSvg(doc: SvgDocument, edits: Rewrite[], deadline: number): SvgDocument | undefined {
  const parts: string[] = [];
  let offset = 0;
  for (const edit of edits) { parts.push(doc.text.slice(offset, edit.start), edit.text); offset = edit.end; }
  parts.push(doc.text.slice(offset));
  const text = parts.join('');
  if (text.length > 2 * 1024 * 1024) { return; }
  let cursor = 0, delta = 0, count = 0;
  const position = (value: number) => {
    while (cursor < edits.length && edits[cursor].end <= value) {
      const edit = edits[cursor++]; delta += edit.text.length - (edit.end - edit.start);
    }
    return value + delta;
  };
  const visit = (node: Node): Node | undefined => {
    if (++count % 256 === 0 && performance.now() > deadline) { throw new Error('SVG rewrite budget'); }
    const start = position(node.start), end = node.end;
    const edit = edits[cursor];
    if (edit?.node === node) {
      const mappedEnd = position(end);
      if (!edit.text) { return; }
      node.start = start; node.end = mappedEnd; node.openEnd = mappedEnd;
      return node;
    }
    node.start = start; node.openEnd = position(node.openEnd);
    let length = 0, descendants = 1;
    for (const child of node.children) {
      const mapped = visit(child);
      if (mapped) { node.children[length++] = mapped; descendants += mapped.count; }
    }
    node.children.length = length;
    node.end = position(end); node.count = descendants;
    return node;
  };
  try {
    const root = visit(doc.root)!;
    return performance.now() <= deadline ? { text, root } : undefined;
  } catch { return; }
}

// Use the exact outline as the identity of a standalone font path. Unlike
// MuPDF's encounter-order font counter, this survives adding an earlier font.
// Matching geometry is reusable under each original <use> transform/paint.
export function canonicalSvg(text: string, maxMs = 20): SvgDocument | undefined {
  const start = performance.now(), doc = parseSvg(text, maxMs);
  if (!doc) { return; }
  const fonts: { node: Node }[] = [];
  const names = new Map<string, string>(), shapes = new Map<string, string>();
  for (const defs of doc.root.children.filter(node => node.name === 'defs')) {
    for (const node of defs.children) {
      const match = text.slice(node.start, node.end).match(/^<path\s+id="(font_\d+_\d+)"\s+d="([^"&]*)"\s*\/>$/);
      if (!match) { continue; }
      const [, oldId, shape] = match;
      const id = glyphId(shape);
      // Verify equality even on a digest collision; never alias unequal paths.
      if ((shapes.has(id) && shapes.get(id) !== shape) || (names.has(oldId) && names.get(oldId) !== id)) { return; }
      names.set(oldId, id); shapes.set(id, shape); fonts.push({ node });
      if (fonts.length % 256 === 0 && performance.now() - start > maxMs) { return; }
    }
  }
  if (!fonts.length) { return doc; }
  const ordered = [...shapes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const edits: Rewrite[] = [];
  for (let i = 0; i < fonts.length; i++) {
    if (i % 256 === 0 && performance.now() - start > maxMs) { return; }
    const node = fonts[i].node, entry = ordered[i];
    edits.push({ start: node.start, end: node.end, node,
      text: entry ? `<path id="${entry[0]}" d="${entry[1]}"/>` : '' });
  }
  let font = 0, references = 0;
  for (const match of text.matchAll(/(\s(?:id|(?:xlink:)?href))="(#?)(font_\d+_\d+)"/g)) {
    if (++references % 256 === 0 && performance.now() - start > maxMs) { return; }
    const at = match.index!;
    while (font < fonts.length && fonts[font].node.end <= at) { font++; }
    if (font < fonts.length && fonts[font].node.start <= at) { continue; }
    const id = names.get(match[3]);
    if (id) { edits.push({ start: at, end: at + match[0].length, text: `${match[1]}="${match[2]}${id}"` }); }
  }
  edits.sort((a, b) => a.start - b.start);
  return rewriteSvg(doc, edits, start + maxMs);
}
