import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PreviewMessage } from '../../preview-protocol';
// Reuse the production session/protocol profiling harness; no VS Code windows.
const { Run } = require('../../../scripts/profile-preview.cjs');
const binary = process.env.TEXPRESSO_BINARY;
const options = { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 45000 };
type Forward = Extract<PreviewMessage, ['preview-forward', ...unknown[]]>;
function source(): string {
  let text = '\\documentclass{article}\n\\begin{document}\n';
  for (let page = 0; page < 30; ++page) {
    text += `\\section*{Page ${page + 1}}\n`;
    for (let line = 0; line < 8; ++line) { text += `Text page ${page + 1} line ${line}. Concrete source synchronization content.\\par\n`; }
    if (page < 29) { text += '\\newpage\n'; }
  }
  return text + '\\end{document}\n';
}
async function setup(): Promise<{ root: string; run: any; forwards: Forward[]; messages: PreviewMessage[] }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-routing-'))), text = source();
  const fixture = { root, id: 'routing', file: path.join(root, 'main.tex'), text, pages: 30, kind: 'routing' };
  await fs.writeFile(fixture.file, text);
  const run = new Run(fixture, binary, 'png', 900, root, 0);
  run.session.autoRerun = false; run.session.configuration.autoRerun = false;
  const forwards: Forward[] = [], messages: PreviewMessage[] = [];
  run.onPreview = (event: unknown) => { if (Array.isArray(event)) { messages.push(event as PreviewMessage); if (event[0] === 'preview-forward') { forwards.push(event as Forward); } } };
  await run.session.start(); await run.render(0); return { root, run, forwards, messages };
}
async function until(run: any, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!condition()) { if (run.failure || Date.now() > deadline) { throw run.failure || new Error(run.trace); } await new Promise(resolve => setTimeout(resolve, 5)); }
}
const lineAt = (text: string, marker: string) => text.slice(0, text.indexOf(marker)).split('\n').length;

test('source barriers cancel old forward-search lines; the next explicit intent resolves once at its actual page', options, async () => {
  const { root, run, forwards } = await setup();
  try {
    const marker = 'Text page 25 line 3', oldLine = lineAt(run.text, marker);
    run.session.send(['synctex-forward', run.main.fileName, oldLine]);
    run.replace(run.text.indexOf('\\begin{document}') + '\\begin{document}'.length, 0, '\n'.repeat(180));
    await until(run, () => run.state?.[2] === run.session.previewSequence && run.state[3] >= 1);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(forwards.length, 0, 'an old source line must never jump under the new source epoch');
    assert.equal(run.state[5], 0); assert.ok(run.state[3] <= 2, 'old intent must not compile a distant prefix');
    run.session.send(['synctex-forward', run.main.fileName, lineAt(run.text, marker)]);
    await until(run, () => forwards.length > 0); assert.deepEqual(forwards.map(m => m[3]), [24]);
    const count = run.state[3]; run.session.send(['synctex-forward', run.main.fileName, lineAt(run.text, marker)]);
    await until(run, () => forwards.length === 2);
    assert.equal(forwards[1][3], 24); assert.equal(run.state[3], count, 'available source records resolve without compiling another page');
  } finally { await run.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('explicit cached navigation cancels pending forward intent', options, async () => {
  const { root, run, forwards } = await setup();
  try {
    run.session.send(['synctex-forward', run.main.fileName, lineAt(run.text, 'Text page 25 line 3')]);
    run.session.send(['preview-cancel', 0, 0]);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(forwards.length, 0); assert.equal(run.state[5], 0); assert.ok(run.state[3] <= 2);
  } finally { await run.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('resolving an available source target releases a superseded render credit', options, async () => {
  const { root, run, forwards, messages } = await setup();
  try {
    await run.render(24); run.session.send(['preview-cancel', 0, 0]);
    await until(run, () => run.state[5] === 0);
    const id = ++run.id, count = forwards.length;
    run.session.send(['preview-render', id, 0, 900, run.state[1], run.state[2]]);
    run.session.send(['synctex-forward', run.main.fileName, lineAt(run.text, 'Text page 25 line 3')]);
    await until(run, () => forwards.length > count);
    assert.equal(forwards.at(-1)![3], 24);
    await until(run, () => run.frames.has(id) || messages.some(m => m[0] === 'preview-retry' && m[1] === id));
    assert.ok(run.frames.has(id) || messages.some(m => m[0] === 'preview-retry' && m[1] === id), 'every old image credit must settle');
  } finally { await run.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
