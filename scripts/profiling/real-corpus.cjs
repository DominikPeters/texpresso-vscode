// Copy user-selected LaTeX projects into disposable output. Source never leaves
// the machine; the compact report records hashes, not manuscript text.
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const allowed = /\.(tex|sty|cls|bib|bst|bbl|png|jpe?g|pdf|eps|csv|dat|txt|ttf|otf)$/i;
const excluded = /^(\.git|node_modules|artifacts|build|dist|\.venv|__pycache__|venv)$/;
function fingerprint(root) {
  const hash = crypto.createHash('sha256'); let files=0, bytes=0;
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)) {
      if (excluded.test(entry.name) || entry.isSymbolicLink()) continue;
      const name = path.join(relative, entry.name), file = path.join(root, name);
      if (entry.isDirectory()) visit(name);
      else if (allowed.test(entry.name)) {
        const content=fs.readFileSync(file); files++;bytes+=content.length;
        hash.update(name.split(path.sep).join('/')+'\0'+crypto.createHash('sha256').update(content).digest('hex')+'\n');
      }
    }
  };
  visit('');return {sha256:hash.digest('hex'),files,bytes};
}
function prepare(configFile, output) {
  const inputs = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return inputs.map(input => {
    if (!/^[a-z0-9-]+$/.test(input.id) || !Number.isSafeInteger(input.focusPage) || input.focusPage < 0 ||
        typeof input.editAfter !== 'string' || !input.editAfter) throw Error('Invalid corpus case');
    const root = path.resolve(output, 'corpus', input.id), file = path.resolve(root, input.entry);
    if (path.isAbsolute(input.entry) || !file.startsWith(root + path.sep)) throw Error('Entry must stay within the copied project');
    if (fs.existsSync(root)) throw Error('Use a fresh corpus output directory: ' + root);
    fs.mkdirSync(root, {recursive:true});
    let copiedBytes = 0;
    const copy = (from, to) => {
      for (const entry of fs.readdirSync(from, {withFileTypes:true})) {
        if (excluded.test(entry.name) || entry.isSymbolicLink()) continue;
        const source = path.join(from, entry.name), target = path.join(to, entry.name);
        if (entry.isDirectory()) { fs.mkdirSync(target, {recursive:true}); copy(source, target); }
        else if (allowed.test(entry.name)) {
          copiedBytes += fs.statSync(source).size;
          if (copiedBytes > 256 * 1024 * 1024) throw Error('Corpus project exceeds 256 MiB budget');
          fs.copyFileSync(source, target);
        }
      }
    };
    copy(input.project, root);
    const original = fs.readFileSync(file, 'utf8');
    // Metadata-only pdfTeX primitives in some conference templates. Record every
    // compatibility adjustment; never silently replace fonts or document layout.
    const shim = input.pdftexMetadataShim ? String.raw`\ifdefined\pdfpagewidth\else\newdimen\pdfpagewidth\fi
\ifdefined\pdfpageheight\else\newdimen\pdfpageheight\fi
\ifdefined\pdfinfo\else\def\pdfinfo#1{}\fi
` : '';
    const compatible = input.removePdfOutput ? original.replace(/^\\pdfoutput\s*=\s*1\s*$/m, '% pdfTeX output selection omitted for XeTeX') : original;
    const text = shim + (input.t1Legacy ? compatible.replace(/(\\documentclass(?:\[[^\]]*\])?\{[^}]+\})/, '$1\n\\usepackage[T1]{fontenc}') : input.t1Times ? compatible.replace('\\usepackage{times}', '\\usepackage[T1]{fontenc}\n\\usepackage{times}') : compatible);
    const start = input.startAfter ? text.indexOf(input.startAfter) : 0;
    const offset = text.indexOf(input.editAfter, start);
    if (start < 0 || offset < 0) throw Error('Missing edit anchor in ' + input.id);
    fs.writeFileSync(file, text);
    return {id:input.id, root:path.dirname(file), projectRoot:root, file, text, kind:'real',
      pages:input.focusPage + 2, focusPage:input.focusPage, editOffset:offset + input.editAfter.length,
      includeDirectories:[root], copiedBytes, normalizePreviewNumbers:input.normalizePreviewNumbers===true,
      compatibility:[...(shim ? ['pdfTeX metadata register shim'] : []), ...(input.t1Times ? ['T1 encoding for XeTeX Times fonts'] : []), ...(input.t1Legacy ? ['T1 encoding for XeTeX legacy text fonts'] : []), ...(input.removePdfOutput ? ['pdfTeX output selection omitted for XeTeX'] : [])],
      originalSha256:crypto.createHash('sha256').update(original).digest('hex'),
      sourceSha256:crypto.createHash('sha256').update(text).digest('hex'),projectFingerprint:fingerprint(root)};
  });
}
module.exports = {prepare,fingerprint};
