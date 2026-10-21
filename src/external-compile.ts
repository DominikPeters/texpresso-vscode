import { ChildProcess, exec, spawn } from 'child_process';
import * as path from 'path';
import type { SessionPaths } from './paths';

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export class ExternalCompiler {
  private process?: ChildProcess;
  constructor(private log: (text: string) => void) {}

  async run(command: string, paths: SessionPaths): Promise<void> {
    if (this.process) {
      throw new Error('An external compilation is already running.');
    }
    this.log('External compilation: ' + command + '\n');
    // externalCompileCommand is intentionally a shell command, for compatibility
    // with existing user recipes. Document paths are separate from that recipe.
    const child = paths.useWSL
      ? spawn('wsl', ['-e', 'sh', '-c',
        'cd ' + shellQuote(paths.engineDirectory) + ' && ' + command + ' ' + shellQuote(paths.rootEnginePath)])
      : exec(command + ' ' + (process.platform === 'win32'
        ? '"' + paths.rootEditorPath + '"' : shellQuote(paths.rootEditorPath)),
        { cwd: path.dirname(paths.rootEditorPath) });
    this.process = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => this.log(text));
    child.stderr?.on('data', (text: string) => this.log(text));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error('External compilation exited with ' + (signal || 'code ' + code)));
          }
        });
      });
    } finally {
      if (this.process === child) {
        this.process = undefined;
      }
    }
  }

  dispose(): void {
    this.process?.kill();
  }
}
