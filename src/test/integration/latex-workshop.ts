import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

async function logs(directory = process.env.TEXPRESSO_TEST_LOGS!): Promise<string> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? logs(file) : fs.readFile(file, 'utf8').catch(() => '');
  }))).join('\n');
}

async function until(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 90000;
  while (!await check()) {
    if (Date.now() > deadline) { throw new Error(description + '\n' + (await logs()).slice(-18000)); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function run(): Promise<void> {
  const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
  const texpresso = vscode.extensions.getExtension('DominikPeters.texpresso-basic');
  assert.ok(workshop && texpresso, 'both extensions installed in isolated profile');
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const main = path.join(root, 'main.tex');
  const chapter = path.join(root, 'chapter.tex');
  const lw = vscode.workspace.getConfiguration('latex-workshop');
  // A real XeLaTeX recipe matches TeXpresso's engine; keep the normal
  // onFileChange autobuild setting for the save/watch coexistence checks.
  await lw.update('latex.tools', [{ name: 'coexistence-xelatex', command: 'xelatex',
    args: ['-synctex=1', '-interaction=nonstopmode', '-halt-on-error', '-recorder', '-output-directory=%OUTDIR%', '%DOC%'] }], vscode.ConfigurationTarget.Workspace);
  await lw.update('latex.recipes', [{ name: 'coexistence', tools: ['coexistence-xelatex'] }], vscode.ConfigurationTarget.Workspace);
  await fs.writeFile(main, '\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n');
  await fs.writeFile(chapter, '% !TeX root = main.tex\n\\section{Coexistence}\\label{sec:test}\n\\typeout{COEXIST-BEFORE}\nShared source with two independent previews. See \\ref{sec:test}.\n');
  const document = await vscode.workspace.openTextDocument(chapter);
  await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  await workshop.activate();
  await texpresso.activate();
  console.log(`Testing LaTeX Workshop ${workshop.packageJSON.version} and TeXpresso ${texpresso.packageJSON.version} on VS Code ${vscode.version}`);
  const command = (name: string) => vscode.commands.executeCommand(name);
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
  const snapshot = async () => {
    const files = (await fs.readdir(root)).filter(file => /\.(pdf|aux|log|fls|gz)$/.test(file));
    return Object.fromEntries(await Promise.all(files.map(async file => [file,
      createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
  };
  try {
    await command('latex-workshop.build');
    await until(async () => (await logs()).includes('BUILD_DONE'), 'LaTeX Workshop builds magic-comment root');
    assert.ok((await fs.stat(path.join(root, 'main.pdf'))).size > 0);
    await command('latex-workshop.view');
    await until(async () => tabs().some(tab => tab.input instanceof vscode.TabInputCustom), 'LaTeX Workshop PDF viewer opens');
    const disk = await snapshot();
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await command('texpresso.startDocument');
    await until(async () => (await logs()).includes('[preview-ui] ["decoded"'), 'TeXpresso webview decodes alongside LaTeX Workshop');
    assert.ok(tabs().some(tab => tab.input instanceof vscode.TabInputCustom), 'PDF viewer remains open');
    assert.ok(tabs().some(tab => tab.input instanceof vscode.TabInputWebview), 'live preview also open');
    assert.deepEqual(await snapshot(), disk, 'TeXpresso leaves external PDF and auxiliary files unchanged');
    const reference = document.getText().lastIndexOf('sec:test');
    await until(async () => {
      const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',
        document.uri, document.positionAt(reference + 4));
      return !!result?.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label).includes('sec:test'));
    }, 'LaTeX Workshop reference completions work during live preview');
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const offset = document.getText().indexOf('COEXIST-BEFORE');
    assert.ok(await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(offset), document.positionAt(offset + 14)), 'COEXIST-AFTER')));
    await until(async () => (await logs()).includes('COEXIST-AFTER'), 'unsaved edit reaches TeXpresso with LaTeX Workshop active');
    assert.ok(document.isDirty);
    assert.deepEqual(await snapshot(), disk, 'unsaved preview does not trigger an external build or rewrite its outputs');
    editor.selection = new vscode.Selection(3, 15, 3, 15);
    await command('texpresso.syncTeXForward');
    await until(async () => (await logs()).includes('[synctex forward] sync: hit page'), 'TeXpresso forward SyncTeX works');
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await command('latex-workshop.synctex');
    // Workshop redacts the workspace path to %WS1% in its output channel.
    await until(async () => /Forward from .*chapter\.tex to .*main\.pdf on line/.test(await logs()),
      'LaTeX Workshop forward SyncTeX still targets its PDF');
    const oldBuilds = (await logs()).split('BUILD_DONE').length;
    assert.ok(await document.save());
    await until(async () => (await logs()).split('BUILD_DONE').length > oldBuilds, 'LaTeX Workshop default autobuild reacts to save');
    await until(async () => (await fs.readFile(path.join(root, 'main.log'), 'utf8')).includes('COEXIST-AFTER'), 'external build uses same root and saved edit');
    assert.ok(tabs().some(tab => tab.input instanceof vscode.TabInputWebview), 'external build preserves live preview');
    // The other common setup puts all build products in a subdirectory.
    await fs.mkdir(path.join(root, 'build'));
    await lw.update('latex.outDir', '%DIR%/build', vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const builds = (await logs()).split('BUILD_DONE').length;
    await command('latex-workshop.build');
    await until(async () => (await logs()).split('BUILD_DONE').length > builds, 'custom output directory build finishes');
    assert.ok((await fs.stat(path.join(root, 'build/main.pdf'))).size > 0);
    const frames = (await logs()).split('[preview-ui] ["decoded"').length;
    await command('texpresso.refresh');
    await until(async () => (await logs()).split('[preview-ui] ["decoded"').length > frames, 'live preview restarts with custom external output directory');
    await command('latex-workshop.clean');
    await until(async () => !await fs.stat(path.join(root, 'build/main.aux')).catch(() => undefined), 'LaTeX Workshop cleans its output directory');
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const afterClean = document.getText().indexOf('COEXIST-AFTER');
    const source = vscode.window.activeTextEditor!;
    assert.ok(await source.edit(edit => edit.replace(new vscode.Range(document.positionAt(afterClean), document.positionAt(afterClean + 13)), 'COEXIST-CLEAN')));
    await until(async () => (await logs()).includes('COEXIST-CLEAN'), 'live edits continue after LaTeX Workshop cleanup');
    console.log('PASS: coactivation, shared root, both viewers, completions, unsaved edits, output isolation, both forward SyncTeX commands, default autobuild, custom output directory, cleanup');
  } finally {
    await command('texpresso.stop');
    await command('latex-workshop.kill');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
