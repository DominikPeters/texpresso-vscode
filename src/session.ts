import type * as vscode from 'vscode';
import type { DirResult } from 'tmp';
import { buildLaunchCommand, SessionConfiguration } from './configuration';
import { EngineProcess, SpawnEngine } from './engine-process';
import { DocumentSync } from './document-sync';
import { SessionPaths } from './paths';
import { SessionOutput } from './logs';
import type { Command, Message, OutputTarget } from './protocol';
import { EngineFailure, processFailure } from './failures';

export type SessionState = 'starting' | 'running' | 'stopped' | 'failed';
export interface SessionEvents {
  state(state: SessionState): void;
  output(target: OutputTarget, contents: string): void;
  debug(text: string): void;
  synctex(file: string, line: number, column?: number): void;
  error(error: Error): void;
  rendered?(): void;
}

export class TexpressoSession {
  private engine: EngineProcess;
  private output: SessionOutput;
  private ended = false;
  private unknownMessages = new Set<string>();
  readonly sync: DocumentSync;
  state: SessionState = 'starting';

  constructor(
    readonly document: vscode.TextDocument,
    readonly configuration: SessionConfiguration,
    readonly paths: SessionPaths,
    documents: () => readonly vscode.TextDocument[],
    private events: SessionEvents,
    private temporaryDirectory?: DirResult,
    spawnEngine?: SpawnEngine
  ) {
    this.output = new SessionOutput((target, text) => events.output(target, text));
    this.engine = new EngineProcess({
      message: message => this.handleMessage(message),
      debug: text => events.debug(text),
      error: error => this.fail(error),
      exit: (code, signal, intentional) => {
        this.cleanTemporaryDirectory();
        if (!this.ended && !intentional && (code !== 0 || signal)) {
          this.fail(new EngineFailure('exit', 'TeXpresso exited with ' + (signal || 'code ' + code),
            undefined, this.engine.stderrTail));
        } else {
          this.dispose();
        }
      }
    }, spawnEngine);
    this.sync = new DocumentSync(document, paths, configuration.useChangeRangeMode,
      documents, command => this.send(command));
  }

  async start(): Promise<void> {
    let launch;
    try {
      launch = buildLaunchCommand(this.configuration, this.paths);
      const directories: string[] = [];
      for (let i = 0; i < launch.args.length; i++) {
        if (launch.args[i] === '-I') {
          directories.push(launch.args[++i]);
        }
      }
      this.sync.includeDirectories = directories;
    } catch (error) {
      this.fail(new EngineFailure('configuration', error instanceof Error ? error.message : String(error)));
      return;
    }
    try {
      this.events.debug('Starting: ' + JSON.stringify([launch.command, ...launch.args]));
      await this.engine.start(launch);
      if (this.ended) {
        return;
      }
      this.state = 'running';
      this.sync.initialize();
      this.events.state(this.state);
    } catch (error) {
      this.fail(error instanceof EngineFailure ? error :
        processFailure(error instanceof Error ? error : new Error(String(error)), 'launch'));
    }
  }

  private handleMessage(message: Message): void {
    if (this.ended) {
      return;
    }
    if (this.output.handle(message)) {
      if (message[0] === 'flush') {
        this.events.rendered?.();
      }
      return;
    }
    switch (message[0]) {
      case 'input-file': this.sync.announce(message[2]); break;
      case 'reset-sync': this.sync.initialize(); break;
      case 'synctex':
        this.events.synctex(this.sync.editorPath(message[1]), message[2], message[3]);
        break;
      case 'lookup-file': break; // Informational in normal filesystem mode.
      default:
        if (!this.unknownMessages.has(message[0])) {
          this.unknownMessages.add(message[0]);
          this.events.debug('Ignoring unknown notification: ' + message[0]);
        }
    }
  }

  send(command: Command): void {
    if (!this.ended) {
      this.engine.send(command);
    }
  }

  private fail(error: Error): void {
    if (this.ended) {
      return;
    }
    this.state = 'failed';
    this.dispose();
    this.events.error(error);
  }

  dispose(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    const wasActive = this.engine.active;
    this.engine.dispose();
    this.output.flush();
    if (this.state !== 'failed') {
      this.state = 'stopped';
    }
    if (!wasActive) {
      this.cleanTemporaryDirectory();
    }
    this.events.state(this.state);
  }

  private cleanTemporaryDirectory(): void {
    if (this.temporaryDirectory) {
      try {
        this.temporaryDirectory.removeCallback();
      } catch {
        // tmp's graceful cleanup will retry on process exit.
      }
      this.temporaryDirectory = undefined;
    }
  }
}
