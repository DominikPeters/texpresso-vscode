import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface Trace { type: string; pid?: number; root?: string; command?: unknown[] }
async function trace(): Promise<Trace[]> {
  try {
    const text = await fs.readFile(process.env.TEXPRESSO_TEST_TRACE!, 'utf8');
    return text.trim().split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as Trace]; } catch { return []; }
    });
  } catch { return []; }
}

async function until(check: () => Promise<boolean>, description: string, timeout = 15000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out: ' + description + '\n' + JSON.stringify(await trace()));
}

async function capture(name: string): Promise<void> {
  const directory = process.env.TEXPRESSO_CAPTURE_DIR;
  if (!directory) {
    return;
  }
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({ name }));
  await until(async () => {
    try { await fs.access(path.join(directory, name + '.done')); return true; } catch { return false; }
  }, 'screenshot ' + name, 180000);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('DominikPeters.texpresso-basic');
  assert.ok(extension, 'extension discovered');
  await extension.activate();
  const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const project = path.join(workspace, 'paper');
  await fs.mkdir(project);
  let mainPath = path.join(project, 'main.tex');
  await fs.writeFile(mainPath, '\\documentclass{article}\n\\begin{document}\nHello world.\n\\input{chapter.tex}\nCurrent position.\n\\end{document}\n');
  const childPath = path.join(project, 'chapter.tex');
  await fs.writeFile(childPath, 'Chapter content.\n');
  const main = await vscode.workspace.openTextDocument(mainPath);
  let editor = await vscode.window.showTextDocument(main);
  editor.selection = new vscode.Selection(4, 0, 4, 0);
  const command = (name: string) => vscode.commands.executeCommand('texpresso.' + name);
  const starts = async () => (await trace()).filter(item => item.type === 'start');
  try {
    await command('startDocument');
    await until(async () => (await trace()).some(item => item.command?.[0] === 'synctex-forward' &&
      item.command[1] === mainPath && item.command[2] === 5), 'initial SyncTeX uses current cursor and one-based lines');
    console.log('PASS: initial cursor synchronization through a real engine process');

    const child = await vscode.workspace.openTextDocument(childPath);
    editor = await vscode.window.showTextDocument(child);
    await until(async () => (await trace()).some(item => item.command?.[0] === 'open' && item.command[1] === childPath), 'included buffer opened');
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'é😀'));
    await until(async () => (await trace()).some(item => item.command?.[0] === 'change-range' &&
      item.command[1] === childPath && item.command.at(-1) === 'é😀'), 'Unicode edit reaches the engine');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await until(async () => (await trace()).some(item => item.command?.[0] === 'change-range' &&
      item.command[1] === childPath && item.command[5] === 3 && item.command.at(-1) === ''), 'undo uses UTF-16 positions');
    console.log('PASS: imported-file edits and undo');

    const beforeRestart = (await starts()).length;
    await command('restart');
    await until(async () => (await starts()).length === beforeRestart + 1, 'restart from an included editor');
    assert.equal((await starts()).at(-1)!.root, mainPath);
    console.log('PASS: Restart preserves the main document');

    editor = await vscode.window.showTextDocument(main);
    const renamed = path.join(project, 'renamed.tex');
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(vscode.Uri.file(mainPath), vscode.Uri.file(renamed));
    assert.ok(await vscode.workspace.applyEdit(rename));
    mainPath = renamed;
    await until(async () => (await starts()).at(-1)?.root === mainPath, 'main document rename restarts preview');
    console.log('PASS: main document rename');

    const moved = path.join(workspace, 'moved paper');
    const move = new vscode.WorkspaceEdit();
    move.renameFile(vscode.Uri.file(project), vscode.Uri.file(moved));
    assert.ok(await vscode.workspace.applyEdit(move));
    mainPath = path.join(moved, 'renamed.tex');
    await until(async () => (await starts()).at(-1)?.root === mainPath, 'containing directory rename restarts preview');
    editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainPath));
    editor.selection = new vscode.Selection(4, 0, 4, 0);
    console.log('PASS: containing folder rename');

    const beforeBuild = (await starts()).length;
    await command('externalCompileAndRefresh');
    await until(async () => (await starts()).length === beforeBuild + 1, 'external build restarts the engine');
    assert.equal((await starts()).at(-1)!.root, mainPath);
    assert.ok((await trace()).some(item => item.type === 'build'));
    await fs.access(mainPath.replace(/\.tex$/, '.aux'));
    console.log('PASS: external compile starts a fresh engine with new auxiliary files');

    const beforeRefresh = (await starts()).length;
    await command('refresh');
    await until(async () => (await starts()).length === beforeRefresh + 1, 'Refresh restarts the engine');
    if (process.env.TEXPRESSO_CAPTURE_DIR) {
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    }
    void command('showControls');
    await capture('preview-controls');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

    await command('stop');
    const configuration = vscode.workspace.getConfiguration('texpresso', vscode.Uri.file(mainPath));
    await configuration.update('command', path.join(workspace, 'missing-texpresso'), vscode.ConfigurationTarget.WorkspaceFolder);
    await command('startDocument');
    await capture('launch-failure');
    await command('checkSetup');
    await capture('setup-report');
    console.log('PASS: failed launch and Check Setup complete without a running preview');
    await configuration.update('command', process.env.TEXPRESSO_TEST_NODE, vscode.ConfigurationTarget.WorkspaceFolder);
    await command('startDocument');
    await until(async () => (await starts()).length === beforeRefresh + 2, 'recover after a failed launch');
    console.log('PASS: recovery after a failed launch');
  } finally {
    await command('stop');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
