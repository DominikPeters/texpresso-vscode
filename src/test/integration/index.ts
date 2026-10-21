import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface Trace { type: string; pid?: number; root?: string; args?: string[]; command?: unknown[] }
// VS Code normalizes Windows drive letters; the native engine resolves them
// through realpath, which can restore their original case.
function samePath(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && path.relative(actual, expected) === '';
}
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
  if (process.env.TEXPRESSO_TEST_PACKAGED) {
    assert.match(extension.extensionPath, /extensions/);
    assert.ok(!extension.extensionPath.includes('texpresso-test-harness'), 'actual installed VSIX is under test');
  }
  await extension.activate();
  const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const project = path.join(workspace, 'paper');
  await fs.mkdir(project);
  let mainPath = path.join(project, 'main.tex');
  await fs.writeFile(mainPath, '\\documentclass{article}\n\\begin{document}\nHello world.\n\\input{chapter.tex}\nCurrent position.\n\\end{document}\n');
  const childPath = path.join(project, 'chapter.tex');
  await fs.writeFile(childPath, 'Chapter content.\n');
  await fs.writeFile(path.join(project, 'plot.bin'), Buffer.from([0, 1, 2, 255]));
  const main = await vscode.workspace.openTextDocument(mainPath);
  let editor = await vscode.window.showTextDocument(main);
  editor.selection = new vscode.Selection(4, 0, 4, 0);
  const command = (name: string) => vscode.commands.executeCommand('texpresso.' + name);
  const starts = async () => (await trace()).filter(item => item.type === 'start');
  try {
    const hinted = path.join(project, 'hinted.tex');
    const bridge = path.join(project, 'bridge.tex');
    await fs.writeFile(hinted, '% !TeX root = bridge.tex\nChapter content.\n');
    await fs.writeFile(bridge, '% !TeX root = main.tex\n');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(hinted));
    await command('startDocument');
    await until(async () => samePath((await starts()).at(-1)?.root, mainPath), 'magic root chain selects the main document');
    await command('stop');
    const retired = (await starts()).at(-1)!.pid!;
    assert.throws(() => process.kill(retired, 0), 'Stop waits for the engine to exit');
    await fs.writeFile(process.env.TEXPRESSO_TEST_TRACE!, '');
    await vscode.window.showTextDocument(main);
    console.log('PASS: chained magic root comments and awaited process shutdown');
    await command('startDocument');
    await until(async () => (await trace()).some(item => item.command?.[0] === 'synctex-forward' &&
      samePath(item.command[1], mainPath) && item.command[2] === 5), 'initial SyncTeX uses current cursor and one-based lines');
    console.log('PASS: initial cursor synchronization through a real engine process');

    // Watcher registration is asynchronous in VS Code and has no ready event.
    // Warm it up before checking individual disk changes below.
    await until(async () => {
      if ((await trace()).some(item => item.command?.[0] === 'rescan')) { return true; }
      await fs.writeFile(path.join(project, 'plot.bin'), Buffer.from([0, 1, 2, 255]));
      await new Promise(resolve => setTimeout(resolve, 500));
      return false;
    }, 'dependency watcher becomes ready');
    const initialRescans = (await trace()).filter(item => item.command?.[0] === 'rescan').length;
    await fs.writeFile(path.join(project, 'plot.bin'), Buffer.from([1, 2, 3, 255]));
    await until(async () => (await trace()).filter(item => item.command?.[0] === 'rescan').length > initialRescans, 'binary lookup dependency refreshes after a disk change');
    assert.equal((await starts()).length, 1);
    const rescans = (await trace()).filter(item => item.command?.[0] === 'rescan').length;
    await fs.writeFile(path.join(project, 'replacement.bin'), Buffer.from([5, 6, 7, 255]));
    await fs.rename(path.join(project, 'replacement.bin'), path.join(project, 'plot.bin'));
    await until(async () => (await trace()).filter(item => item.command?.[0] === 'rescan').length > rescans, 'atomic resource replacement refreshes the preview');
    assert.equal((await starts()).length, 1, 'atomic replacement retains the preview');
    await command('enableAutoRerun');
    await until(async () => (await trace()).some(item => item.command?.[0] === 'rerun' && item.command[1] === true), 'automatic reruns enabled live');
    await command('rerunOnce');
    await until(async () => (await trace()).some(item => item.command?.[0] === 'rerun-once'), 'one-shot rerun');
    await command('pause'); await command('resume');
    await until(async () => (await trace()).some(item => item.command?.[0] === 'pause') &&
      (await trace()).some(item => item.command?.[0] === 'resume'), 'pause/resume controls');
    await command('disableAutoRerun');
    await until(async () => (await trace()).some(item => item.command?.[0] === 'rerun' && item.command[1] === false), 'automatic reruns disabled live');
    assert.equal((await starts()).length, 1, 'live controls retain the process');
    console.log('PASS: dependency watcher, automatic/one-shot reruns, and pause/resume');

    await fs.writeFile(path.join(project, 'future.tex'), 'New dependency.\n');
    await until(async () => (await starts()).length === 2, 'creating a previously missing dependency recovers the preview');

    const child = await vscode.workspace.openTextDocument(childPath);
    editor = await vscode.window.showTextDocument(child);
    await until(async () => (await trace()).some(item => item.command?.[0] === 'open' && samePath(item.command[1], childPath)), 'included buffer opened');
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'é😀'));
    await until(async () => (await trace()).some(item => item.command?.[0] === 'change-range' &&
      samePath(item.command[1], childPath) && item.command.at(-1) === 'é😀'), 'Unicode edit reaches the engine');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await until(async () => (await trace()).some(item => item.command?.[0] === 'change-range' &&
      samePath(item.command[1], childPath) && item.command[5] === 3 && item.command.at(-1) === ''), 'undo uses UTF-16 positions');
    console.log('PASS: imported-file edits and undo');

    const beforeRestart = (await starts()).length;
    await command('restart');
    await until(async () => (await starts()).length === beforeRestart + 1, 'restart from an included editor');
    assert.ok(samePath((await starts()).at(-1)!.root, mainPath));
    console.log('PASS: Restart preserves the main document');

    editor = await vscode.window.showTextDocument(main);
    const renamed = path.join(project, 'renamed.tex');
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(vscode.Uri.file(mainPath), vscode.Uri.file(renamed));
    assert.ok(await vscode.workspace.applyEdit(rename));
    mainPath = renamed;
    await until(async () => samePath((await starts()).at(-1)?.root, mainPath), 'main document rename restarts preview');
    console.log('PASS: main document rename');

    const moved = path.join(workspace, 'moved paper');
    const move = new vscode.WorkspaceEdit();
    move.renameFile(vscode.Uri.file(project), vscode.Uri.file(moved));
    assert.ok(await vscode.workspace.applyEdit(move));
    mainPath = path.join(moved, 'renamed.tex');
    await until(async () => samePath((await starts()).at(-1)?.root, mainPath), 'containing directory rename restarts preview');
    editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainPath));
    editor.selection = new vscode.Selection(4, 0, 4, 0);
    console.log('PASS: containing folder rename');

    const beforeBuild = (await starts()).length;
    await command('externalCompileAndRefresh');
    await until(async () => (await starts()).length === beforeBuild + 1, 'external build restarts the engine');
    assert.ok(samePath((await starts()).at(-1)!.root, mainPath));
    assert.ok((await trace()).some(item => item.type === 'build'));
    await fs.access(mainPath.replace(/\.tex$/, '.aux'));
    console.log('PASS: external compile starts a fresh engine with new auxiliary files');

    const streamSettings = vscode.workspace.getConfiguration('texpresso', vscode.Uri.file(mainPath));
    await streamSettings.update('streamFiles', true, vscode.ConfigurationTarget.WorkspaceFolder);
    const beforeStream = (await starts()).length;
    await command('restart');
    await until(async () => (await starts()).length === beforeStream + 1, 'streaming startup');
    const streamPid = (await starts()).at(-1)!.pid;
    await until(async () => (await trace()).some(item => item.pid === streamPid && item.command?.[0] === 'register') &&
      (await trace()).some(item => item.pid === streamPid && item.command?.[0] === 'resume'), 'streaming primes files and resumes');
    console.log('PASS: streaming startup through the actual extension controller');

    const beforeRefresh = (await starts()).length;
    await command('refresh');
    await until(async () => (await starts()).length === beforeRefresh + 1, 'Refresh restarts the engine');
    if (process.env.TEXPRESSO_CAPTURE_DIR) {
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      // Without a capture, closing immediately can cancel the request before
      // the quick pick has even opened (notably on VS Code 1.88).
      const controls = command('showControls');
      await capture('preview-controls');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await controls;
    }

    await command('stop');
    const secondFolder = path.join(workspace, 'second project');
    await fs.mkdir(secondFolder);
    const secondRoot = path.join(secondFolder, 'main.tex');
    const secondChild = path.join(secondFolder, 'child.tex');
    await fs.writeFile(secondRoot, '\\documentclass{article}\n\\begin{document}Second project.\\end{document}');
    await fs.writeFile(secondChild, '% !TeX root = main.tex\nSecond chapter.');
    assert.ok(vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(secondFolder), name: 'Second project' }));
    await until(async () => vscode.workspace.workspaceFolders?.length === 2, 'second workspace folder added');
    const secondSettings = vscode.workspace.getConfiguration('texpresso', vscode.Uri.file(secondRoot));
    await secondSettings.update('command', process.env.TEXPRESSO_TEST_NODE, vscode.ConfigurationTarget.WorkspaceFolder);
    await secondSettings.update('arguments', [process.env.TEXPRESSO_TEST_ENGINE!, '--second-project'], vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(secondChild));
    await command('startDocument');
    await until(async () => samePath((await starts()).at(-1)?.root, secondRoot), 'magic root in second workspace folder');
    assert.ok((await trace()).filter(item => item.type === 'start').at(-1)?.args?.includes('--second-project'), 'selected root supplies its own folder settings');
    await command('stop');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainPath));
    console.log('PASS: multi-root workspace settings follow the discovered root');
    const beforeFailure = (await starts()).length;
    const configuration = vscode.workspace.getConfiguration('texpresso', vscode.Uri.file(mainPath));
    await configuration.update('command', path.join(workspace, 'missing-texpresso'), vscode.ConfigurationTarget.WorkspaceFolder);
    await command('startDocument');
    await capture('launch-failure');
    await command('checkSetup');
    await capture('setup-report');
    console.log('PASS: failed launch and Check Setup complete without a running preview');
    await configuration.update('command', process.env.TEXPRESSO_TEST_NODE, vscode.ConfigurationTarget.WorkspaceFolder);
    await command('startDocument');
    await until(async () => (await starts()).length === beforeFailure + 1, 'recover after a failed launch');
    console.log('PASS: recovery after a failed launch');
  } finally {
    await command('stop');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
