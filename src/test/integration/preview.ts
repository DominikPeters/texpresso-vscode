import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';

async function logs(directory = process.env.TEXPRESSO_TEST_LOGS!): Promise<string> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(async entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? logs(file) : /TeXpresso.*\.log$/.test(entry.name) ? fs.readFile(file, 'utf8') : '';
  }))).join('\n');
}
async function until(check: () => Promise<boolean>, description: string, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) { throw new Error(description + '\n' + (await logs()).slice(-7000)); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function renders(): Promise<{ id: number; page: number }[]> {
  return [...(await logs()).matchAll(/\["preview-render",(\d+),(\d+),/g)]
    .map(match => ({ id: Number(match[1]), page: Number(match[2]) }));
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('DominikPeters.texpresso-basic');
  assert.ok(extension); await extension.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const file = path.join(root, 'embedded-preview.tex');
  await fs.writeFile(file, String.raw`\documentclass{article}
\usepackage[margin=26mm]{geometry}
\usepackage{amsmath}
\title{TeXpresso inside VS Code}
\author{A live preview, beside your source}
\date{}
\begin{document}
\maketitle
\typeout{PREVIEW-BEFORE}
\section{An immediate connection}
Edit the source and this page updates. Your document stays in the editor,
with page navigation, zoom, and source synchronization close at hand.
\[
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi},
  \qquad \sum_{k=1}^{n} k = \frac{n(n+1)}{2}.
\]
\section{From source to page and back}
Forward SyncTeX reveals the corresponding place in the preview.
Control or Command click on the page to return to the source.
\begin{align*}
  f(x+h) &= f(x) + h f'(x) + O(h^2),\\
  e^{i\theta} &= \cos\theta + i\sin\theta.
\end{align*}
\newpage
\typeout{PREVIEW-SECOND}
\section{The next page}
Pages are compiled when requested, and images have a bounded pixel budget.
\end{document}
`);
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  const settings = vscode.workspace.getConfiguration('texpresso', document.uri);
  await settings.update('syncTeXForwardOnSelection', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const command = (name: string) => vscode.commands.executeCommand('texpresso.' + name);
  try {
    await command('startDocument');
    await until(async () => (await renders()).some(r => r.page === 0), 'first webview render request', 90000);
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)));
    await command('nextPage');
    await until(async () => (await renders()).some(r => r.page === 1) && (await logs()).includes('PREVIEW-SECOND'),
      'decoded first frame grants credit for the next page');
    const before = (await renders()).length;
    await command('previousPage');
    await until(async () => (await renders()).length > before && (await renders()).at(-1)!.page === 0, 'return to first page');

    const offset = document.getText().indexOf('PREVIEW-BEFORE');
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: false });
    editor.selection = new vscode.Selection(document.positionAt(offset), document.positionAt(offset + 14));
    const previousId = (await renders()).at(-1)!.id;
    await vscode.commands.executeCommand('type', { text: 'PREVIEW-AFTER' });
    assert.ok(document.getText().includes('PREVIEW-AFTER'), 'source accepts VS Code typing');
    const beforeMove = editor.selection.active;
    await vscode.commands.executeCommand('cursorMove', { to: 'right', by: 'character', value: 1 });
    assert.ok(!editor.selection.active.isEqual(beforeMove), 'source cursor moves after typing');
    await until(async () => (await logs()).includes('PREVIEW-AFTER') && (await renders()).at(-1)!.id > previousId,
      'unsaved editor edit triggers a new preview');
    console.log('PASS: real VS Code webview decodes pages and updates after unsaved edits');

    editor.selection = new vscode.Selection(10, 2, 10, 2);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await command('syncTeXForward');
    await until(async () => (await logs()).includes('[synctex forward] sync: hit page'), 'forward synchronization');

    const previewGroup = vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview))!;
    const scratch = await vscode.workspace.openTextDocument({ content: 'Temporary tab for preview lifecycle test', language: 'plaintext' });
    await vscode.window.showTextDocument(scratch, { viewColumn: previewGroup.viewColumn, preview: false });
    const hiddenId = (await renders()).at(-1)!.id;
    await new Promise(resolve => setTimeout(resolve, 200));
    await vscode.commands.executeCommand('workbench.action.previousEditor');
    await until(async () => (await renders()).at(-1)!.id > hiddenId, 'hidden preview restores its webview and rendering credit');
    console.log('PASS: hidden webview restores without retaining its DOM');

    const capture = process.env.TEXPRESSO_CAPTURE_DIR;
    if (capture) {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('notifications.clearAll');
      await fs.mkdir(capture, { recursive: true });
      await fs.writeFile(path.join(capture, 'request.json'), JSON.stringify({ name: 'editor-preview' }));
      await until(async () => { try { await fs.access(path.join(capture, 'editor-preview.done')); return true; } catch { return false; } },
        'preview browser interaction and screenshot', 180000);
    }
    await command('stop');
    assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)));
    console.log('PASS: Stop closes the preview panel');
  } finally {
    await command('stop'); await document.save();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
