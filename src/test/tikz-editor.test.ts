import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { TexpressoSession } from '../session';
import type { PreviewImageHeader } from '../preview-protocol';
import { isImageHeader } from '../preview-protocol';
import { sourceFigures, resolveFigure } from '../tikz-source';
import { findTikzEditor, usableEditor } from '../tikz-installation';
import { TikzEditor } from '../tikz-editor';

const picture = '\\begin{tikzpicture}\n\\draw (0,0) rectangle (3,2);\n\\end{tikzpicture}';
const header = (): PreviewImageHeader => ({ requestId: 1, revision: 2, sequence: 3, page: 0,
  bounds: [0, 0, 600, 800], width: 600, height: 800, byteLength: 1, mime: 'image/png',
  annotations: { links: [], destinations: [], figures: [{ file: 'figure.tex', line: 1, endLine: 4, bounds: [70, 80, 170, 160] }] } });

test('literal TikZ roots exclude comments, verbatim, escaped backslashes and nested pictures', () => {
  const text = '% \\begin{tikzpicture}\n\\verb|\\begin{tikzpicture}|\n' +
    '\\begin{verbatim}\n' + picture + '\n\\end{verbatim}\n' +
    '\\\\begin{tikzpicture}\n' + picture.replace('\\draw', '\\node {' + picture + '};\n\\draw');
  const roots = sourceFigures(text);
  assert.equal(roots.length, 1);
  assert.ok(text.slice(roots[0].offset, roots[0].endOffset).startsWith('\\begin{tikzpicture}'));
  assert.equal(resolveFigure(roots, roots[0].line, roots[0].endLine), roots[0]);
  assert.equal(resolveFigure(roots, 1, 2), undefined);
});

test('macro argument execution lines resolve only one unambiguous literal picture', () => {
  const text = '\\scalebox{.5}{\n' + picture + '\n}';
  const roots = sourceFigures(text), closing = text.split('\n').length;
  assert.equal(resolveFigure(roots, closing, closing + 1), roots[0]);
  const two = sourceFigures('\\scalebox{.5}{\n' + picture + '\n' + picture + '\n}');
  const last = two[0].enclosingEndLines[0];
  assert.equal(resolveFigure(two, last, last + 1), undefined);
  assert.equal(resolveFigure(roots, closing + 2, closing + 3), undefined, 'never choose the nearest picture');
});

test('figure protocol validates bounded locations and remains compatible without figures', () => {
  const h = header(); assert.ok(isImageHeader(h));
  for (const bad of [{ line: 0 }, { endLine: 1 }, { file: 'bad\nname.tex' }, { bounds: [0, 0, Infinity, 2] }]) {
    assert.equal(isImageHeader({ ...h, annotations: { ...h.annotations, figures: [{ ...h.annotations!.figures![0], ...bad }] } }), false);
  }
  assert.ok(isImageHeader({ ...h, annotations: { links: [], destinations: [] } }));
});

test('app detection handles declared macOS executables, explicit missing overrides and desktop registration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tikz-app-'));
  try {
    const bundle = path.join(root, 'Renamed Editor.app'), executable = path.join(bundle, 'Contents/MacOS/app');
    await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'fixture'); await fs.chmod(executable, 0o755);
    const queries: string[][] = [];
    const run = async (_tool: string, args: string[]) => { queries.push(args); return 'app'; };
    assert.equal(await usableEditor(bundle, 'darwin', run), executable);
    assert.ok(queries[0].includes('CFBundleExecutable'));
    assert.equal(await usableEditor(bundle, 'darwin', async () => '../outside'), undefined);
    let scanned = false;
    assert.equal(await findTikzEditor(path.join(root, 'missing'), { run: async () => { scanned = true; return executable; } }), undefined);
    assert.equal(scanned, false, 'a configured missing path never silently launches another installation');
    const data = path.join(root, 'data'); await fs.mkdir(path.join(data, 'applications'), { recursive: true });
    const desktop = path.join(data, 'applications/tikz-editor.desktop');
    await fs.writeFile(desktop, '[Desktop Entry]\nExec="' + executable + '" %U\n');
    const env = { XDG_DATA_HOME: data, XDG_DATA_DIRS: data, PATH: '' };
    assert.equal(await findTikzEditor('', { platform: 'linux', home: root, env }), executable);
    await fs.writeFile(desktop, '[Desktop Entry]\nExec=sh -c "some command"\n');
    assert.equal(await findTikzEditor('', { platform: 'linux', home: root, env }), undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function fixture(check: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tikz-route-'));
  try { await check(await setup(root)); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function setup(root: string) {
  const file = path.join(root, 'figure café \u0027 quoted.tex'), app = path.join(root, 'editor executable');
  await fs.writeFile(file, picture); await fs.writeFile(app, 'fixture'); await fs.chmod(app, 0o755);
  let text = picture, dirty = false, version = 1, choice: string | undefined = 'Save and Open', detects = 0, saves = 0;
  const launches: unknown[][] = [], warnings: string[] = [], errors: string[] = [];
  const env = { uiKind: 1, remoteName: undefined as string | undefined };
  const workspace = { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file' } }],
    getConfiguration: () => ({ get: () => '' }), openTextDocument: async () => doc };
  const doc = { uri: { scheme: 'file', fsPath: file }, fileName: file, isUntitled: false, isClosed: false,
    get isDirty() { return dirty; }, get version() { return version; }, getText: () => text,
    save: async () => { saves++; await fs.writeFile(file, text); dirty = false; return true; } };
  const api = { env, workspace, Uri: { file: (s: string) => s }, window: {
    showWarningMessage: async (message: string) => { warnings.push(message); return choice; },
    showErrorMessage: async (message: string) => { errors.push(message); } } };
  const session = { document: doc, sync: { sourceFile: (logical: string) => logical === 'figure.tex' ? file : undefined,
    overlay: () => doc } } as unknown as TexpressoSession;
  const service = new TikzEditor(api as unknown as typeof vscode, async () => { detects++; return app; },
    async (...args) => { launches.push(args); });
  return { service, session, api, doc, file, app, launches, warnings, errors, detects: () => detects, saves: () => saves,
    edit: (value: string) => { text = value; dirty = true; version++; }, cancel: () => { choice = undefined; } };
}

test('a local figure opens its exact Unicode source/line, with explicit save approval for dirty source', async () => fixture(async f => {
  f.edit(picture.replace('(3,2)', '(4,2)'));
  const h = header(); assert.deepEqual(await f.service.prepare(f.session, h), [0]);
  await f.service.open(f.session, h, 0, () => true);
  assert.equal(f.saves(), 1); assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.launches, [[f.app, await fs.realpath(f.file), 1]]);
  assert.equal(f.errors.length, 0);
}));

test('remote, browser, untrusted and non-file workspaces do not even probe local apps', async () => fixture(async f => {
  const h = header();
  for (const remote of ['wsl', 'ssh-remote', 'dev-container', 'codespaces']) {
    f.api.env.remoteName = remote; assert.deepEqual(await f.service.prepare(f.session, h), []);
  }
  f.api.env.remoteName = undefined; f.api.env.uiKind = 2;
  assert.deepEqual(await f.service.prepare(f.session, h), []);
  f.api.env.uiKind = 1; f.api.workspace.isTrusted = false;
  assert.deepEqual(await f.service.prepare(f.session, h), []);
  f.api.workspace.isTrusted = true; f.api.workspace.workspaceFolders[0].uri.scheme = 'vscode-remote';
  assert.deepEqual(await f.service.prepare(f.session, h), []);
  assert.equal(f.detects(), 0); assert.equal(f.launches.length, 0);
}));

test('cancelled save, stale preview, unknown source and tiny badges never launch', async () => fixture(async f => {
  const h = header(); f.edit(picture + '\n');
  await f.service.prepare(f.session, h); f.cancel();
  await f.service.open(f.session, h, 0, () => true);
  assert.equal(f.saves(), 0); assert.equal(f.launches.length, 0);
  await f.service.open(f.session, h, 0, () => false);
  const other = header(); other.annotations!.figures![0].file = '/unregistered.tex';
  assert.deepEqual(await f.service.prepare(f.session, other), []);
  const tiny = header(); tiny.annotations!.figures![0].bounds = [0, 0, 5, 5];
  assert.deepEqual(await f.service.prepare(f.session, tiny), []);
  assert.equal(f.launches.length, 0);
}));

test('source changes after preparation are refused', async () => fixture(async f => {
  const h = header(); await f.service.prepare(f.session, h);
  f.edit(picture.replace('(3,2)', '(6,2)'));
  await f.service.open(f.session, h, 0, () => true);
  assert.equal(f.launches.length, 0);

}));


test('disk changes behind a clean buffer are refused', async () => fixture(async f => {
  const h = header(); await f.service.prepare(f.session, h);
  await fs.writeFile(f.file, picture.replace('(3,2)', '(7,2)'));
  await f.service.open(f.session, h, 0, () => true);
  assert.equal(f.launches.length, 0);
  assert.equal(f.warnings.length, 1);
}));

test('a preview invalidated while the save prompt is open never saves or launches', async () => fixture(async f => {
  f.edit(picture + '\n');
  const h = header(); await f.service.prepare(f.session, h);
  let current = true;
  f.api.window.showWarningMessage = async message => { f.warnings.push(message); current = false; return 'Save and Open'; };
  await f.service.open(f.session, h, 0, () => current);
  assert.equal(f.saves(), 0); assert.equal(f.launches.length, 0);
}));
