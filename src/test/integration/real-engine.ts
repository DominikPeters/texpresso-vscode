import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const useWSL = process.platform === 'win32';

async function logFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? logFiles(path.join(directory, entry.name)) : Promise.resolve([path.join(directory, entry.name)])))).flat();
}

async function logs(): Promise<{ compiler: string; engine: string }> {
  const files = await logFiles(process.env.TEXPRESSO_TEST_LOGS!);
  const read = async (pattern: RegExp) => (await Promise.all(files.filter(file => pattern.test(path.basename(file)))
    .map(file => fs.readFile(file, 'utf8').catch(() => '')))).join('\n');
  return { compiler: await read(/^\d+-TeXpresso\.log$/), engine: await read(/^TeXpresso Engine\.log$/) };
}

async function until(check: () => Promise<boolean>, description: string, timeout = 30000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) { return; }
    await delay(100);
  }
  const output = await logs();
  throw new Error('Timed out: ' + description + '\nCompiler:\n' + output.compiler.slice(-6000) + '\nEngine:\n' + output.engine.slice(-6000));
}

interface Process { pid: number; parent: number; state: string; args: string }
async function processes(): Promise<Process[]> {
  const args = ['-eo', 'pid=,ppid=,stat=,args='];
  const result = useWSL ? await exec('wsl', ['-e', 'ps', ...args], { timeout: 10000 })
    : await exec('ps', args, { timeout: 10000 });
  return result.stdout.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), state: match[3], args: match[4] }] : [];
  });
}

export async function run(): Promise<void> {
  assert.ok(process.env.TEXPRESSO_BINARY, 'real engine binary supplied');
  assert.equal(vscode.env.remoteName, undefined, 'VS Code runs on the host, including Windows in the WSL job');
  const extension = vscode.extensions.getExtension('DominikPeters.texpresso-basic');
  assert.ok(extension);
  await extension.activate();
  const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const project = path.join(workspace, 'paper é with spaces');
  const support = path.join(project, 'support files');
  await fs.mkdir(support, { recursive: true });
  const mainPath = path.join(project, 'main.tex');
  const childPath = path.join(support, 'chapter.tex');
  const diskPath = path.join(project, 'disk.tex');
  await fs.writeFile(mainPath, '\\documentclass{article}\n\\begin{document}\n\\input{chapter.tex}\n\\input{disk.tex}\n\\end{document}\n');
  const before = '% !TeX root = ../main.tex\n%' + 'é😀'.repeat(350) + '\n\\typeout{TXP-BEFORE}\nSome text.\n';
  await fs.writeFile(childPath, before);
  await fs.writeFile(diskPath, '\\typeout{TXP-DISK-BEFORE}\n');
  const child = await vscode.workspace.openTextDocument(childPath);
  await vscode.window.showTextDocument(child);
  const settings = vscode.workspace.getConfiguration('texpresso', vscode.Uri.file(mainPath));
  assert.equal(settings.get('useWSL'), useWSL);
  assert.equal(settings.get('packageProvider'), 'texlive');
  // Exercise conversion of an absolute Windows include directory as well as
  // the root and child paths; both directory names contain spaces.
  await settings.update('includeDirectories', [support], vscode.ConfigurationTarget.WorkspaceFolder);
  const command = (name: string) => vscode.commands.executeCommand('texpresso.' + name);
  const compiled = (marker: string) => until(async () => (await logs()).compiler.includes(marker), 'real compiler emits ' + marker, 90000);
  const rootEnginePath = useWSL ? (await exec('wsl', ['-e', 'wslpath', '-a', '-u', mainPath], { timeout: 10000 })).stdout.trim() : mainPath;
  const owned = new Set<number>();
  const family = async (): Promise<number[]> => {
    const all = await processes();
    const found = new Set(all.filter(item => item.args.includes(process.env.TEXPRESSO_BINARY!) && item.args.includes(rootEnginePath)).map(item => item.pid));
    for (let size = -1; size !== found.size;) {
      size = found.size;
      all.filter(item => found.has(item.parent)).forEach(item => found.add(item.pid));
    }
    found.forEach(pid => owned.add(pid));
    return [...found];
  };
  const reaped = (pids: readonly number[]) => until(async () => !(await processes()).some(item => pids.includes(item.pid) && !item.state.startsWith('Z')),
    'Linux engine and worker processes exit', 15000);
  const replace = async (from: string, to: string) => {
    const offset = child.getText().indexOf(from);
    assert.ok(offset >= 0, 'current editor buffer contains ' + from);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(child.uri, new vscode.Range(child.positionAt(offset), child.positionAt(offset + from.length)), to);
    assert.ok(await vscode.workspace.applyEdit(edit), 'editor edit applied');
    await compiled(to);
    assert.ok((await fs.readFile(childPath, 'utf8')).includes('TXP-BEFORE'), 'edit reached the compiler without saving to disk');
  };
  try {
    await command('startDocument');
    await compiled('TXP-BEFORE');
    // Compilation output precedes the first usable rollback checkpoint.
    await until(async () => {
      const debug = (await logs()).engine;
      return debug.lastIndexOf('[info] output 1 pages long') > Math.max(debug.lastIndexOf('texpresso: handshake success'), debug.lastIndexOf('[change] rewinded trace'));
    }, 'initial real compilation completes');
    await delay(500);
    assert.ok((await family()).length >= 2, 'real TeXpresso and XeTeX worker are running');
    console.log('PASS: host VS Code launches real ' + (useWSL ? 'WSL ' : '') + 'TeXpresso and resolves magic root / include paths');

    await replace('TXP-BEFORE', 'TXP-RANGES');
    // VS Code installs file watchers asynchronously without a ready event.
    // Wait for a real rescan before testing a separate, single disk edit.
    await until(async () => {
      if ((await logs()).engine.includes('stdin: ["rescan"]')) { return true; }
      await fs.writeFile(diskPath, '\\typeout{TXP-DISK-BEFORE}\n');
      await delay(500);
      return false;
    }, 'real dependency watcher becomes ready');
    await fs.writeFile(diskPath, '\\typeout{TXP-DISK-AFTER}\n');
    await compiled('TXP-DISK-AFTER');
    console.log('PASS: unsaved Unicode-buffer edits and on-disk dependencies recompile in the real engine');

    const old = await family();
    await settings.update('useChangeRangeMode', false, vscode.ConfigurationTarget.WorkspaceFolder);
    await command('restart');
    await reaped(old);
    await until(async () => (await family()).some(pid => !old.includes(pid)), 'Restart launches a new real engine');
    await delay(1000);
    await replace('TXP-RANGES', 'TXP-BYTES');
    console.log('PASS: restart from an included editor retains the root and legacy UTF-8 edits work');

    await command('pause');
    await until(async () => (await logs()).engine.includes('engine stepping suspended'), 'real engine pauses');
    await command('resume');
    const beforeStream = await family();
    await settings.update('useChangeRangeMode', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('streamFiles', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await command('restart');
    await reaped(beforeStream);
    await until(async () => (await family()).some(pid => !beforeStream.includes(pid)), 'streaming engine starts');
    await delay(1000);
    await replace('TXP-BYTES', 'TXP-STREAM');
    console.log('PASS: real streaming startup and subsequent editor edits compile');

    await family();
    await command('stop');
    await reaped([...owned]);
    console.log('PASS: Stop leaves no owned engine or XeTeX worker running');
  } finally {
    await command('stop');
    await child.save(); // This is the suite's temporary file; avoid a Save dialog.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
