import * as vscode from 'vscode';
import * as path from 'path';
import type { TexpressoSession } from './session';

export class PreviewControls {
  private item = vscode.window.createStatusBarItem('texpresso.preview', vscode.StatusBarAlignment.Left, 20);

  constructor() {
    this.item.name = 'TeXpresso Preview';
    this.item.command = 'texpresso.showControls';
    this.item.accessibilityInformation = { label: 'TeXpresso preview controls' };
  }

  update(session?: TexpressoSession): void {
    const editor = vscode.window.activeTextEditor;
    const available = editor && (['latex', 'tex'].includes(editor.document.languageId) ||
      editor.document.fileName.endsWith('.tex'));
    if (!available && !session) {
      this.item.hide();
      return;
    }
    const name = session?.document.isUntitled ? 'Untitled' : session && path.basename(session.paths.rootEditorPath);
    switch (session?.state) {
      case 'starting': this.item.text = '$(loading~spin) TeXpresso: Starting…'; break;
      case 'running': this.item.text = (session?.paused ? '$(debug-pause)' : '$(preview)') +
        ' TeXpresso: ' + name + (session?.paused ? ' (paused)' : ''); break;
      case 'failed': this.item.text = '$(warning) TeXpresso: Failed'; break;
      default: this.item.text = '$(play) TeXpresso';
    }
    this.item.tooltip = (session ? 'Main document: ' + session.paths.rootEditorPath + '\n' : '') +
      'Open preview controls and troubleshooting';
    this.item.show();
  }

  async show(session?: TexpressoSession): Promise<void> {
    const items: (vscode.QuickPickItem & { command: string })[] = [];
    const active = session && ['starting', 'running'].includes(session.state);
    if (session?.state === 'running') {
      if (!session.paused && !session.unsupported.has('rerun-once')) {
        items.push({ label: '$(run-all) Rerun Once', command: 'texpresso.rerunOnce', description: 'Update references and table of contents' });
      }
      if (!session.unsupported.has('rerun')) {
        items.push({ label: (session.autoRerun ? '$(check)' : '$(circle-large-outline)') + ' Automatic Reruns',
          description: session.autoRerun ? 'On — click to disable' : 'Off — click to enable',
          command: session.autoRerun ? 'texpresso.disableAutoRerun' : 'texpresso.enableAutoRerun' });
      }
      if (!session.unsupported.has('pause') && !session.unsupported.has('resume')) {
        items.push({ label: session.paused ? '$(play) Resume Preview' : '$(debug-pause) Pause Preview',
          command: session.paused ? 'texpresso.resume' : 'texpresso.pause' });
      }
    }
    if (!active) {
      items.push({ label: '$(play) Start Preview', command: 'texpresso.startDocument',
        description: 'Use the active document' });
    }
    if (session) {
      items.push({ label: '$(refresh) Restart Preview', command: 'texpresso.restart',
        description: path.basename(session.paths.rootEditorPath) });
    }
    if (active) {
      items.push({ label: '$(debug-stop) Stop Preview', command: 'texpresso.stop' });
    }
    items.push(
      { label: '$(tools) Check Setup', command: 'texpresso.checkSetup', description: 'Executable, provider, and launch settings' },
      { label: '$(output) Show Compiler Output', command: 'texpresso.showCompilerOutput' },
      { label: '$(terminal) Show Engine Log', command: 'texpresso.showEngineLog' },
      { label: '$(gear) Open Settings', command: 'texpresso.openSettings' }
    );
    const chosen = await vscode.window.showQuickPick(items, {
      title: 'TeXpresso' + (session ? ' — ' + path.basename(session.paths.rootEditorPath) : ''),
      placeHolder: session?.state === 'running' ? (session.paused ? 'Preview paused — edits will appear after resuming' : 'Preview running') :
        session?.state === 'failed' ? 'Preview failed — check the setup or engine log' : 'Preview controls'
    });
    if (chosen) {
      await vscode.commands.executeCommand(chosen.command);
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
