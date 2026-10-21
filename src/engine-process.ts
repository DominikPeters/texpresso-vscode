import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import type { Interface } from 'readline';
import { readProtocol, Command, Message } from './protocol';
import type { LaunchCommand } from './configuration';
import { processFailure } from './failures';

export interface EngineEvents {
  message(message: Message): void;
  debug(text: string): void;
  error(error: Error): void;
  exit(code: number | null, signal: NodeJS.Signals | null, intentional: boolean): void;
}

export type SpawnEngine = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export class EngineProcess {
  private child?: ChildProcess;
  private reader?: Interface;
  private stopping = false;
  stderrTail = '';

  constructor(private events: EngineEvents, private spawnEngine: SpawnEngine = spawn) {}

  get active(): boolean {
    return this.child !== undefined;
  }

  start(launch: LaunchCommand): Promise<void> {
    return new Promise((resolve, reject) => {
      let spawned = false;
      const child = this.spawnEngine(launch.command, launch.args, {
        cwd: launch.cwd, stdio: ['pipe', 'pipe', 'pipe']
      });
      this.child = child;
      child.once('spawn', () => {
        spawned = true;
        resolve();
      });
      child.on('error', error => {
        if (!spawned) {
          const failure = processFailure(error, 'launch');
          reject(failure);
          this.events.error(failure);
        } else if (!this.stopping) {
          this.events.error(processFailure(error, 'connection'));
        }
      });
      child.once('close', (code, signal) => {
        this.reader?.close();
        this.child = undefined;
        if (!spawned) {
          reject(new Error('TeXpresso exited before starting.'));
        }
        this.events.exit(code, signal, this.stopping);
      });
      if (child.stdout) {
        this.reader = readProtocol(child.stdout, message => {
          if (!this.stopping) {
            try {
              this.events.message(message);
            } catch (error) {
              this.events.error(error instanceof Error ? error : new Error(String(error)));
            }
          }
        }, (line, error) => {
          this.events.debug('Invalid protocol message: ' + line.slice(0, 250) + ' (' + String(error) + ')');
        });
      }
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (text: string) => {
        if (!this.stopping) {
          this.stderrTail = (this.stderrTail + text).slice(-8000);
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

  dispose(): void {
    this.stopping = true;
    this.reader?.close();
    this.child?.kill();
  }
}
