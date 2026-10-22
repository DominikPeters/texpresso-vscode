import type * as vscode from 'vscode';
import type { DirResult } from 'tmp';
import { buildLaunchCommand, SessionConfiguration } from './configuration';
import { EngineProcess, SpawnEngine } from './engine-process';
import { DocumentSync } from './document-sync';
import { SessionPaths } from './paths';
import { SessionOutput } from './logs';
import type { Command, Message, OutputTarget } from './protocol';
import { EngineFailure, processFailure } from './failures';
import { Dependencies, WatchFile } from './dependencies';
import { probePreview } from './preview-capabilities';
import { isPreviewMessage, type PreviewImage, type PreviewImageHeader, type PreviewMessage } from './preview-protocol';
import * as path from 'path';

export type SessionState = 'starting' | 'running' | 'stopped' | 'failed';
export interface SessionEvents {
  state(state: SessionState): void;
  output(target: OutputTarget, contents: string): void;
  debug(text: string): void;
  synctex(file: string, line: number, column?: number, word?: string): void;
  error(error: Error): void;
  rendered?(): void;
  restart?(): void;
  warning?(message: string): void;
  preview?(event: PreviewMessage | PreviewImage | { sourceSequence: number }): void;
}

export interface SessionServices {
  watchFile?: WatchFile; roots?: readonly string[]; watchDelay?: number;
  probePreview?: typeof probePreview;
}

export class TexpressoSession {
  previewDecoded(header: PreviewImageHeader, svgDom: boolean): void {
    this.events.debug('[preview-ui] ' + JSON.stringify(['decoded', header.requestId, header.page,
      header.revision, header.sequence, svgDom]) + '\n');
  }

  private engine: EngineProcess;
  private output: SessionOutput;
  private ended = false;
  private shutdown?: Promise<void>;
  private unknownMessages = new Set<string>();
  readonly sync: DocumentSync;
  readonly dependencies: Dependencies;
  readonly unsupported = new Set<string>();
  paused = false;
  autoRerun: boolean;
  state: SessionState = 'starting';
  embedded = false;
  previewRegions = false;
  previewSvg = false;
  previewAuto = false;
  previewLinks = false;
  previewSequence = 0;
  previewState?: Extract<PreviewMessage, ['preview-state', ...unknown[]]>;

  constructor(
    readonly document: vscode.TextDocument,
    readonly configuration: SessionConfiguration,
    readonly paths: SessionPaths,
    documents: () => readonly vscode.TextDocument[],
    private events: SessionEvents,
    private temporaryDirectory?: DirResult,
    spawnEngine?: SpawnEngine,
    private services: SessionServices = {}
  ) {
    this.autoRerun = configuration.autoRerun;
    this.output = new SessionOutput((target, text) => events.output(target, text));
    this.engine = new EngineProcess({
      message: message => this.handleMessage(message),
      image: image => { if (!this.ended) { this.events.preview?.(image); } },
      debug: text => events.debug(text),
      error: error => this.fail(error),
      unsupported: verb => {
        if (this.unsupported.has(verb)) {
          return;
        }
        this.unsupported.add(verb);
        if (verb === 'pause' || verb === 'resume') {
          this.paused = false;
        } else if (verb === 'rerun') {
          this.autoRerun = false;
        }
        this.events.warning?.('This TeXpresso build does not support “' + verb + '”. Update TeXpresso to use this feature.');
        this.events.state(this.state);
      },
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
    this.dependencies = new Dependencies(paths, this.sync, {
      watch: configuration.watchDependencies, stream: configuration.streamFiles,
      roots: [...(services.roots || []), path.dirname(paths.rootEditorPath),
        ...configuration.includeDirectories.map(dir => paths.toEditor(paths.includeDirectory(dir)))],
      watchFile: services.watchFile, delay: services.watchDelay
    }, {
      send: command => this.send(command), restart: () => this.events.restart?.(),
      debug: text => events.debug(text), error: error => this.fail(error)
    });
  }

  async start(): Promise<void> {
    let launch;
    try {
      launch = buildLaunchCommand(this.configuration, this.paths);
      const location = this.configuration.previewLocation;
      if (location && location !== 'window') {
        this.embedded = await (this.services.probePreview || probePreview)(this.configuration, launch.cwd, features => { this.previewRegions = features.regions; this.previewSvg = features.svg; this.previewAuto = features.auto; this.previewLinks = features.links; });
        if (this.ended) { return; }
        if (!this.embedded && location === 'editor') {
          throw new EngineFailure('configuration', 'This TeXpresso build does not support the editor preview. Choose a build with headless preview support, or set Preview Location to Window.', 'PREVIEW_UNSUPPORTED');
        }
        if (this.embedded) { launch.args.splice(launch.args.length - 1, 0, '-headless'); }
      }
      const directories: string[] = [];
      for (let i = 0; i < launch.args.length; i++) {
        if (launch.args[i] === '-I') {
          directories.push(launch.args[++i]);
        }
      }
      this.sync.includeDirectories = directories;
    } catch (error) {
      this.fail(error instanceof EngineFailure ? error : new EngineFailure('configuration', error instanceof Error ? error.message : String(error)));
      return;
    }
    try {
      this.events.debug('Starting: ' + JSON.stringify([launch.command, ...launch.args]));
      await this.engine.start(launch, this.embedded);
      if (this.ended) {
        return;
      }
      this.state = 'running';
      if (this.configuration.streamFiles) {
        this.sync.prime();
      }
      this.sync.initialize();
      if (this.autoRerun) {
        this.send(['rerun', true]);
      }
      if (this.configuration.streamFiles) {
        this.send(['resume']);
      }
      this.events.state(this.state);
    } catch (error) {
      this.fail(error instanceof EngineFailure ? error :
        processFailure(error instanceof Error ? error : new Error(String(error)), 'launch'));
    }
  }

  private handleMessage(message: Message | PreviewMessage): void {
    if (this.ended) {
      return;
    }
    if (isPreviewMessage(message)) {
      if (message[0] === 'preview-state') { this.previewState = message; }
      this.events.preview?.(message);
      return;
    }
    if (this.output.handle(message as Message)) {
      if (message[0] === 'flush') {
        this.events.rendered?.();
      }
      return;
    }
    switch (message[0]) {
      case 'input-file':
        this.sync.announce(message[2]);
        this.dependencies.input(message[2]);
        break;
      case 'reset-sync': this.sync.initialize(); break;
      case 'synctex':
        this.events.synctex(this.sync.editorPath(message[1]), message[2], message[3] === -1 ? undefined : message[3], message[4]);
        break;
      case 'lookup-file': this.dependencies.lookup(message[1], message[2], message[3]); break;
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
      if (this.embedded && ['open', 'open-base64', 'close', 'change', 'change-range', 'rescan', 'rerun-once'].includes(command[0])) {
        this.previewSequence++;
        this.events.preview?.({ sourceSequence: this.previewSequence });
        this.engine.send(['preview-barrier', this.previewSequence]);
      }
    }
  }

  setAutoRerun(enabled: boolean): void {
    this.configuration.autoRerun = enabled;
    this.autoRerun = enabled && !this.unsupported.has('rerun');
    if (!this.unsupported.has('rerun')) {
      this.send(['rerun', enabled]);
    }
    this.events.state(this.state);
  }

  setPaused(paused: boolean): void {
    if (this.unsupported.has(paused ? 'pause' : 'resume')) {
      return;
    }
    this.paused = paused;
    this.send([paused ? 'pause' : 'resume']);
    this.events.state(this.state);
  }

  rerunOnce(): void {
    if (!this.paused && !this.unsupported.has('rerun-once')) {
      this.send(['rerun-once']);
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

  dispose(): Promise<void> {
    if (this.ended) {
      return this.shutdown || Promise.resolve();
    }
    this.ended = true;
    this.dependencies.dispose();
    const wasActive = this.engine.active;
    this.shutdown = this.engine.dispose().then(() => this.cleanTemporaryDirectory());
    this.output.flush();
    if (this.state !== 'failed') {
      this.state = 'stopped';
    }
    if (!wasActive) {
      this.cleanTemporaryDirectory();
    }
    this.events.state(this.state);
    return this.shutdown;
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
