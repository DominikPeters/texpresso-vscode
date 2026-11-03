import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface Trace { type: string; pid?: number; root?: string; command?: unknown[] }
async function trace(): Promise<Trace[]> {
  const text = await fs.readFile(process.env.TEXPRESSO_TEST_TRACE!, 'utf8');
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Trace]; } catch { return []; } });
}
async function until(check: () => Promise<boolean>, description: string): Promise<void> {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) { return; } await new Promise(resolve => setTimeout(resolve, 40)); }
  throw Error('Timed out: ' + description);
}
const settle = () => new Promise(resolve => setTimeout(resolve, 600));

/** Actual extension commands/processes; fixture engines never open native windows. */
export async function runRecoveryChecks(main: vscode.TextDocument, child: vscode.TextDocument): Promise<void> {
  const command = (name: string) => vscode.commands.executeCommand('texpresso.' + name);
  const settings = vscode.workspace.getConfiguration('texpresso', main.uri), previous = settings.get('streamFiles', false);
  const starts = async () => (await trace()).filter(item => item.type === 'start');
  const trigger = path.join(path.dirname(main.fileName), '.texpresso-test-exit');
  async function exitOnNextCommand(value: { code: number; error?: string }): Promise<void> {
    // The fixture may receive unrelated initialization/watch commands while
    // this is written. Publish the complete instruction with an atomic rename.
    await fs.writeFile(trigger + '.tmp', JSON.stringify(value));
    await fs.rename(trigger + '.tmp', trigger);
  }
  async function restart(name = 'restart'): Promise<void> {
    const before = (await starts()).length;
    await command(name);
    await until(async () => (await starts()).length > before, 'manual launch recorded');
  }
  async function edit(document: vscode.TextDocument, text: string): Promise<void> {
    const edits = new vscode.WorkspaceEdit(); edits.insert(document.uri, new vscode.Position(0, 0), text);
    assert.equal(await vscode.workspace.applyEdit(edits), true);
  }
  try {
    await settings.update('streamFiles', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await restart();
    const before = (await starts()).length;
    await edit(main, '% unsaved root survives recovery\n'); await edit(child, '% unsaved include survives recovery\n');
    const firstPid = (await starts()).at(-1)!.pid!;
    await exitOnNextCommand({ code: 1 });
    await edit(main, '% trigger runtime exit\n');
    await until(async () => (await starts()).length === before + 1, 'unexpected runtime exit restarts the engine');
    const secondPid = (await starts()).at(-1)!.pid!;
    await until(async () => {
      const commands = (await trace()).filter(item => item.pid === secondPid).map(item => item.command).filter(Boolean) as unknown[][];
      const resumed = commands.findIndex(item => item[0] === 'resume');
      return resumed >= 0 && [main, child].every(doc => {
        const opened = commands.findIndex(item => item[0] === 'open' && path.relative(String(item[1]), doc.fileName) === '' && item[2] === doc.getText());
        return opened >= 0 && opened < resumed;
      });
    }, 'all dirty buffers replay before recovery resumes compilation');
    assert.notEqual(firstPid, secondPid);
    process.kill(secondPid, 'SIGKILL');
    await until(async () => (await starts()).length === before + 2, 'second runtime failure recovers');
    const thirdPid = (await starts()).at(-1)!.pid!;
    process.kill(thirdPid, 'SIGKILL'); await settle();
    assert.equal((await starts()).length, before + 2, 'third failure exhausts the rolling two-attempt budget');
    console.log('PASS: runtime exit/crash recovery replays unsaved root/includes and stops after two retries');

    await restart();
    const manualPid = (await starts()).at(-1)!.pid!;
    process.kill(manualPid, 'SIGKILL'); await command('stop');
    const stopped = (await starts()).length; await settle();
    assert.equal((await starts()).length, stopped, 'manual Stop cancels a racing recovery');
    await vscode.window.showTextDocument(main); await restart('startDocument');
    const errorsBefore = (await starts()).length;
    await exitOnNextCommand({ code: 1, error: '! Undefined control sequence.\n' });
    await edit(main, '% trigger compiler error\n'); await settle();
    assert.equal((await starts()).length, errorsBefore, 'compiler errors never trigger automatic recovery');
    console.log('PASS: manual Stop wins recovery races and compiler errors are not retried');
  } finally {
    await fs.rm(trigger, { force: true });
    await fs.rm(trigger + '.tmp', { force: true });
    await settings.update('streamFiles', previous, vscode.ConfigurationTarget.WorkspaceFolder);
    await restart();
  }
}
