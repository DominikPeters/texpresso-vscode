/* Retained, scoped SVG pages. Only the static path-based MuPDF subset is mounted;
 * unsupported SVG continues through the isolated image decoder. No innerHTML. */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg', XLINK = 'http://www.w3.org/1999/xlink';
  const tags = new Set(['svg', 'defs', 'g', 'path', 'use', 'rect', 'clipPath', 'mask']);
  const attributes = new Set(['id', 'd', 'data-text', 'transform', 'fill', 'stroke', 'fill-rule', 'clip-rule',
    'fill-opacity', 'stroke-opacity', 'opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'x', 'y', 'width', 'height', 'viewBox',
    'version', 'clip-path', 'mask', 'maskUnits', 'maskContentUnits', 'clipPathUnits', 'href']);
  const id = /^[A-Za-z_][\w.-]{0,127}$/;
  let serial = 0;
  function prepare(xml, scope, fragment = false) {
    if (typeof xml !== 'string' || xml.length > 2 * 1024 * 1024 || /<!|<\?/.test(xml)) { throw Error('Unsupported SVG'); }
    const doc = new DOMParser().parseFromString(fragment ? `<svg xmlns="${NS}" xmlns:xlink="${XLINK}" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">${xml}</svg>` : xml, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.localName !== 'svg' || doc.querySelector('parsererror')) { throw Error('Invalid SVG'); }
    const ids = new Set(), refs = new Map(); let count = 0;
    function visit(node, depth) {
      if (++count > 20000 || depth > 32 || node.namespaceURI !== NS || !tags.has(node.localName)) { throw Error('Unsupported SVG node'); }
      for (const child of node.childNodes) { if (child.nodeType !== 1 && (child.nodeType !== 3 || child.textContent.trim())) { throw Error('Unsupported SVG content'); } }
      for (const attr of [...node.attributes]) {
        const name = attr.localName, value = attr.value;
        if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') { continue; }
        if (attr.namespaceURI === 'http://www.inkscape.org/namespaces/inkscape' && ['label', 'groupmode'].includes(name)) { node.removeAttributeNode(attr); continue; }
        if ((attr.namespaceURI && !(attr.namespaceURI === XLINK && name === 'href')) || !attributes.has(name)) { throw Error('Unsupported SVG attribute'); }
        let reference;
        if (name === 'id') {
          if (!id.test(value) || ids.has(value)) { throw Error('Invalid SVG ID'); }
          ids.add(value); attr.value = scope + value;
        } else if (name === 'href') {
          if (node.localName !== 'use' || !value.startsWith('#') || !id.test(value.slice(1))) { throw Error('Unsupported SVG reference'); }
          reference = value.slice(1); attr.value = '#' + scope + reference;
        } else if (['clip-path', 'mask'].includes(name) || (['fill', 'stroke'].includes(name) && value.startsWith('url('))) {
          const match = value.match(/^url\(#([A-Za-z_][\w.-]{0,127})\)$/);
          if (!match) { throw Error('Unsupported SVG URL'); }
          reference = match[1]; attr.value = `url(#${scope}${reference})`;
        } else if (name === 'data-text') {
          // Inert source metadata, never used as HTML/CSS or a selector.
        } else if (name === 'd') {
          if (!/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]*$/.test(value)) { throw Error('Invalid SVG path'); }
        } else if (name === 'transform') {
          if (!/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([-+0-9.eE,\s]+\)\s*)+$/.test(value)) { throw Error('Invalid SVG transform'); }
        } else if (['fill', 'stroke'].includes(name)) {
          if (!/^(?:none|black|white|#[0-9a-fA-F]{3,8})$/.test(value)) { throw Error('Unsupported SVG paint'); }
        } else if (['fill-rule', 'clip-rule'].includes(name)) {
          if (!['evenodd', 'nonzero'].includes(value)) { throw Error('Invalid SVG rule'); }
        } else if (['stroke-linecap', 'stroke-linejoin'].includes(name)) {
          if (!['butt', 'round', 'square', 'miter', 'bevel', 'miter-clip', 'arcs'].includes(value)) { throw Error('Invalid SVG stroke'); }
        } else if (name.endsWith('Units')) {
          if (!['userSpaceOnUse', 'objectBoundingBox'].includes(value)) { throw Error('Invalid SVG units'); }
        } else if (!/^[-+0-9.eE,%\s]+$/.test(value) && !(name === 'stroke-dasharray' && value === 'none')) { throw Error('Unsupported SVG value'); }
        if (reference) { refs.set(reference, (refs.get(reference) || 0) + 1); }
      }
      for (const child of node.children) { visit(child, depth + 1); }
    }
    visit(root, 0);
    return { root, ids, refs, count };
  }
  const referencesValid = (ids, refs) => { for (const [name, n] of refs) { if (n < 0 || (n > 0 && !ids.has(name))) { return false; } } return true; };
  class SvgPage {
    static create(xml, contentId) {
      try {
        const scope = `txpsvg${++serial}-`, page = prepare(xml, scope);
        if (!referencesValid(page.ids, page.refs)) { return; }
        return new SvgPage(page, contentId, scope);
      } catch { return; }
    }
    constructor(page, contentId, scope) { Object.assign(this, page); this.contentId = contentId; this.scope = scope; }
    patch(patch, contentId) {
      if (patch.base !== this.contentId || !Array.isArray(patch.operations) || patch.operations.length > 64) { throw Error('SVG patch base unavailable'); }
      const plans = [], ids = new Set(this.ids), refs = new Map(this.refs), removedNodes = new Set(), positions = new Map(), snapshots = new Map();
      let affected = 0, bytes = 0, count = this.count;
      for (const op of patch.operations) {
        if (!Array.isArray(op.path) || op.path.length > 32) { throw Error('Invalid SVG patch path'); }
        let parent = this.root;
        for (const i of op.path) { if (!Number.isInteger(i) || i < 0 || !parent.children[i]) { throw Error('Invalid SVG patch path'); } parent = parent.children[i]; }
        if (!Number.isInteger(op.start) || !Number.isInteger(op.remove) || op.start < 0 || op.remove < 0 || op.start + op.remove > parent.children.length || typeof op.xml !== 'string') { throw Error('Invalid SVG patch range'); }
        if (positions.has(parent) && op.start + op.remove > positions.get(parent)) { throw Error('Overlapping SVG patch'); }
        positions.set(parent, op.start);
        bytes += op.xml.length;
        if (bytes > 65536) { throw Error('SVG patch byte budget'); }
        if (!snapshots.has(parent)) { snapshots.set(parent, [...parent.children]); }
        const siblings = snapshots.get(parent);
        const addition = prepare(op.xml, this.scope, true), remove = siblings.slice(op.start, op.start + op.remove);
        affected += addition.count - 1; count += addition.count - 1;
        // Parse removed static subtrees only for their IDs/references. They are
        // already scoped; strip that scope via attribute reads, never text replacement.
        for (const node of remove) {
          if (removedNodes.has(node)) { throw Error('Overlapping SVG patch'); } removedNodes.add(node);
          for (const item of [node, ...node.querySelectorAll('*')]) {
            affected++; count--;
            if (item.hasAttribute('id')) { ids.delete(item.id.slice(this.scope.length)); }
            for (const attr of item.attributes) {
              let reference;
              if (attr.localName === 'href') { reference = attr.value.slice(1 + this.scope.length); }
              else if (['clip-path', 'mask', 'fill', 'stroke'].includes(attr.localName)) { const match = attr.value.match(/^url\(#(.+)\)$/); if (match) { reference = match[1].slice(this.scope.length); } }
              if (reference) { refs.set(reference, (refs.get(reference) || 0) - 1); }
            }
          }
        }
        plans.push({ parent, remove, addition, anchor: siblings[op.start + op.remove] || null });
      }
      if (affected > 256 || count > 20000) { throw Error('SVG patch node budget'); }
      for (const plan of plans) {
        for (let ancestor = plan.parent; ancestor; ancestor = ancestor.parentNode) { if (removedNodes.has(ancestor)) { throw Error('Overlapping SVG patch'); } }
        for (const name of plan.addition.ids) { if (ids.has(name)) { throw Error('Duplicate SVG ID'); } ids.add(name); }
        for (const [name, n] of plan.addition.refs) { refs.set(name, (refs.get(name) || 0) + n); }
      }
      if (!referencesValid(ids, refs)) { throw Error('Dangling SVG reference'); }
      // Validate every fragment and path before changing the visible page.
      const replacements = new Map();
      for (const plan of plans) {
        let anchor = plan.anchor;
        while (anchor && replacements.has(anchor)) { anchor = replacements.get(anchor); }
        const additions = [...plan.addition.root.children].map(node => document.importNode(node, true));
        for (const node of plan.remove) { node.remove(); replacements.set(node, additions[0] || anchor); }
        for (const node of additions) { plan.parent.insertBefore(node, anchor); }
      }
      for (const [name, n] of refs) { if (n === 0) { refs.delete(name); } }
      this.count = count; this.ids = ids; this.refs = refs; this.contentId = contentId;
    }
    clone() {
      const clone = this.root.cloneNode(true), scope = `txpsvg${++serial}-`;
      for (const node of [clone, ...clone.querySelectorAll('*')]) {
        for (const attr of node.attributes) {
          if (attr.localName === 'id') { attr.value = scope + attr.value.slice(this.scope.length); }
          else if (attr.localName === 'href') { attr.value = '#' + scope + attr.value.slice(1 + this.scope.length); }
          else if (['clip-path', 'mask', 'fill', 'stroke'].includes(attr.localName) && attr.value.startsWith('url(#' + this.scope)) { attr.value = 'url(#' + scope + attr.value.slice(5 + this.scope.length); }
        }
      }
      return clone;
    }
  }
  global.TexpressoSvgPage = SvgPage;
})(globalThis);
