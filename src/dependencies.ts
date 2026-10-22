import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import type { DocumentSync } from './document-sync';
import type { SessionPaths } from './paths';
import type { Command } from './protocol';

export type FileChange = 'change' | 'create' | 'delete';
export type WatchFile = (file: string, changed: (kind: FileChange) => void) => { dispose(): void };
interface Dependency {
  logical: string;
  enginePath: string;
  candidates: string[];
  failed: boolean;
  watchers: { dispose(): void }[];
}

export class Dependencies {
  private files = new Map<string, Dependency>();
  private writes = new Set<string>();
  private pending = new Map<string, FileChange>();
  private loading = new Map<string, Promise<void>>();
  private supplied = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  suspended = false;

  constructor(private paths: SessionPaths, private sync: DocumentSync,
    private options: { watch: boolean; stream: boolean; roots: readonly string[]; watchFile?: WatchFile; delay?: number },
    private events: { send(command: Command): void; restart(): void; debug(text: string): void; error(error: Error): void }) {}

  private key(enginePath: string): string {
    return this.paths.absoluteEnginePath(enginePath);
  }

  private local(file: string): boolean {
    return [...this.options.roots, ...this.sync.includeDirectories.map(directory => this.paths.toEditor(directory))].some(root => {
      const relative = path.relative(this.paths.identity(root), this.paths.identity(file));
      return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    });
  }

  private written(file: Dependency): boolean {
    return this.writes.has(file.logical) || file.candidates.some(candidate => this.writes.has(this.paths.identity(candidate)));
  }

  lookup(kind: string, status: string, enginePath: string): void {
    if (this.disposed) {
      return;
    }
    const logical = this.key(enginePath);
    const candidates = this.paths.sourceCandidates(enginePath, this.sync.includeDirectories);
    if (kind === 'write') {
      this.writes.add(logical);
      for (const candidate of candidates) {
        this.writes.add(this.paths.identity(candidate));
      }
      for (const file of this.files.values()) {
        if (this.written(file)) {
          file.watchers.splice(0).forEach(watcher => watcher.dispose());
        }
      }
      return;
    }
    if (kind !== 'read') {
      return;
    }
    // Successful disk lookup takes precedence over a similarly named buffer
    // in another include directory. Missing files may still have unsaved text.
    let file = this.files.get(logical);
    if (!file) {
      file = { logical, enginePath, candidates, failed: status === 'failed', watchers: [] };
      this.files.set(logical, file);
    }
    file.failed = status === 'failed';
    if (!this.written(file) && this.sync.overlay(enginePath)) {
      this.sync.announce(enginePath);
    }
    if (!this.written(file) && this.options.watch && this.options.watchFile && !file.watchers.length) {
      // Watch missing candidates too: creating a previously absent input must
      // recover compilation without requiring a manual restart.
      for (const candidate of candidates.filter(candidate => this.local(candidate))) {
        file.watchers.push(this.options.watchFile(candidate, change => this.changed(logical, change)));
      }
    }
    if (!this.written(file) && (this.options.stream || status === 'promised') && !this.supplied.has(logical)) {
      void this.supply(file, status === 'promised');
    }
  }

  input(enginePath: string): void {
    this.lookup('read', 'successful', enginePath);
  }

  closed(editorPath: string): void {
    if (!this.disposed && (this.options.watch || this.options.stream) && !existsSync(editorPath) && [...this.files.values()].some(file =>
      !this.written(file) && file.candidates.some(candidate => this.paths.identity(candidate) === this.paths.identity(editorPath)))) {
      // Discarding an unsaved, registered input must also clear its promise;
      // otherwise the engine can wait forever for a buffer that was closed.
      this.events.restart();
    }
  }

  private changed(logical: string, kind: FileChange): void {
    if (this.disposed) {
      return;
    }
    const previous = this.pending.get(logical);
    this.pending.set(logical, previous === 'delete' || kind === 'delete' ? 'delete' :
      previous === 'create' || kind === 'create' ? 'create' : kind);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.options.delay ?? 200);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || this.suspended) {
      return;
    }
    const pending = [...this.pending];
    this.pending.clear();
    let rescan = false;
    for (const [logical, kind] of pending) {
      const file = this.files.get(logical);
      if (!file || this.written(file) || file.candidates.some(candidate => this.sync.hasOverlay(candidate))) {
        continue;
      }
      if (kind === 'delete') {
        const exists = await Promise.all(file.candidates.map(candidate => fs.stat(candidate).then(stat => stat.isFile(), () => false)));
        if (!exists.some(Boolean) && !this.disposed) {
          this.events.restart(); // rescan ignores deleted files in current upstream.
          return;
        }
      }
      if (this.options.stream) {
        await this.loading.get(logical);
        if (this.disposed) {
          return;
        }
        // interpret_open currently leaves upstream's pic_cache bounds intact.
        // A fresh process is needed when a streamed image changes dimensions.
        if (this.supplied.has(logical) && /\.(png|jpe?g|pdf|eps|ps|mps|svg|gif|bmp|tiff?|webp)$/i.test(file.enginePath)) {
          if (!this.disposed) {
            this.events.restart();
          }
          return;
        }
        this.supplied.delete(logical);
        await this.supply(file, false);
      } else if (file.failed && (kind === 'create' || kind === 'delete')) {
        this.events.restart(); // rescan also misses files absent during the first pass.
        return;
      } else {
        rescan = true;
      }
    }
    if (rescan && !this.disposed) {
      this.events.send(['rescan']);
    }
  }

  private supply(file: Dependency, promised: boolean): Promise<void> {
    const existing = this.loading.get(file.logical);
    if (existing) {
      return existing;
    }
    const work = this.read(file, promised).finally(() => this.loading.delete(file.logical));
    this.loading.set(file.logical, work);
    return work;
  }

  private async read(file: Dependency, promised: boolean): Promise<void> {
    if (this.disposed || this.written(file)) {
      return;
    }
    if (this.sync.overlay(file.enginePath)) {
      this.sync.announce(file.enginePath);
      this.supplied.add(file.logical);
      return;
    }
    for (const candidate of file.candidates) {
      if (!this.local(candidate)) {
        continue;
      }
      try {
        const bytes = await fs.readFile(candidate);
        if (!this.disposed && !this.written(file) && !this.sync.hasOverlay(candidate)) {
          this.events.send(['open-base64', file.logical, bytes.toString('base64')]);
          this.supplied.add(file.logical);
          file.failed = false;
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.events.debug('Could not read dependency ' + candidate + ': ' + String(error));
        }
      }
    }
    if (promised && !this.disposed) {
      this.events.error(new Error('Could not supply the file TeXpresso is waiting for: ' + file.enginePath));
    }
  }

  resumeWatching(): void {
    this.suspended = false;
    void this.flush();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.timer);
    for (const file of this.files.values()) {
      file.watchers.forEach(watcher => watcher.dispose());
    }
    this.pending.clear();
  }
}
