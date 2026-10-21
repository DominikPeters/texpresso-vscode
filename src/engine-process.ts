import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { readProtocol, Command, Message } from './protocol';
import { readPreviewProtocol, type PreviewMessage, type PreviewImage } from './preview-protocol';
import type { LaunchCommand } from './configuration';
import { processFailure } from './failures';
import { terminate } from './process-lifecycle';

export interface EngineEvents {
  message(message: Message | PreviewMessage): void;
  image?(image: PreviewImage): void;
  debug(text: string): void;
  error(error: Error): void;
  exit(code: number | null, signal: NodeJS.Signals | null, intentional: boolean): void;
  unsupported?(verb: string): void;
}

export type SpawnEngine = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export class EngineProcess {
  private child?: ChildProcess;
  private reader?: { close(): void };
  private stopping = false;
  private shutdown?: Promise<void>;
  private cancelStart?: () => void;
  stderrTail = '';
  private stderrPending = '';

  constructor(private events: EngineEvents, private spawnEngine: SpawnEngine = spawn) {}

  get active(): boolean {
    return this.child !== undefined;
  }

  start(launch: LaunchCommand, preview = false): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopping) { resolve(); return; }
      let spawned = false;
      this.cancelStart = resolve;
      const child = this.spawnEngine(launch.command, launch.args, {
        cwd: launch.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true
      });
      this.child = child;
      child.once('spawn', () => {
        spawned = true;
        this.cancelStart = undefined;
        if (this.stopping) { void terminate(child); }
        resolve();
      });
      child.on('error', error => {
        if (!spawned && !this.stopping) {
          const failure = processFailure(error, 'launch');
          reject(failure);
          this.events.error(failure);
        } else if (!this.stopping) {
          this.events.error(processFailure(error, 'connection'));
        }
      });
      child.once('exit', () => {
        if (!this.stopping) { void terminate(child).catch(error => this.events.debug(String(error))); }
      });
      child.once('close', (code, signal) => {
        this.reader?.close();
        this.child = undefined;
        this.cancelStart = undefined;
        if (!spawned) {
          reject(new Error('TeXpresso exited before starting.'));
        }
        this.events.exit(code, signal, this.stopping);
      });
      if (child.stdout) {
        const message = (message: Message | PreviewMessage) => {
          if (!this.stopping) {
            try {
              this.events.message(message);
            } catch (error) {
              this.events.error(error instanceof Error ? error : new Error(String(error)));
            }
          }
        };
        this.reader = preview ? readPreviewProtocol(child.stdout, message,
          image => { if (!this.stopping) { this.events.image?.(image); } },
          error => { if (!this.stopping) { this.events.error(error); } }) : readProtocol(child.stdout, message, (line, error) => {
          if (this.stopping) { return; }
          this.events.debug('Invalid protocol message: ' + line.slice(0, 250) + ' (' + String(error) + ')');
        });
      }
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (text: string) => {
        if (!this.stopping) {
          this.stderrTail = (this.stderrTail + text).slice(-8000);
          this.stderrPending += text;
          const lines = this.stderrPending.split('\n');
          this.stderrPending = lines.pop()!.slice(-8000);
          for (const line of lines) {
            const unsupported = line.match(/^\[command\] unknown verb: (\S+)/);
            if (unsupported) {
              this.events.unsupported?.(unsupported[1]);
            }
          }
          this.events.debug(text);
        }
      });
      child.stdin?.on('error', error => {
        if (!this.stopping) {
          this.events.error(processFailure(error, 'connection'));
        }
      });
      child.stdout?.on('error', error => {
        if (!this.stopping) {
          this.events.error(processFailure(error, 'connection'));
        }
      });
      child.stderr?.on('error', error => {
        if (!this.stopping) {
          this.events.error(processFailure(error, 'connection'));
        }
      });
    });
  }

  send(command: Command): void {
    if (!this.stopping && this.child?.stdin?.writable) {
      this.child.stdin.write(JSON.stringify(command) + '\n');
    }
  }

  dispose(): Promise<void> {
    if (this.shutdown) { return this.shutdown; }
    this.stopping = true;
    this.cancelStart?.();
    this.cancelStart = undefined;
    this.reader?.close();
    this.shutdown = this.child ? terminate(this.child) : Promise.resolve();
    return this.shutdown;
  }
}
