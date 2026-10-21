import * as path from 'path';
import * as fs from 'fs';
import { windowsToWslSync, wslToWindowsSync } from 'wsl-path';

export interface PathConversion {
  toEngine(path: string): string;
  toEditor(path: string): string;
}

export class SessionPaths {
  readonly rootEnginePath: string;
  readonly engineDirectory: string;
  private identities = new Map<string, string>();

  constructor(readonly rootEditorPath: string, readonly useWSL: boolean,
    private conversion: PathConversion = { toEngine: windowsToWslSync, toEditor: wslToWindowsSync }) {
    this.rootEnginePath = this.toEngine(rootEditorPath);
    this.engineDirectory = this.enginePath.dirname(this.rootEnginePath);
  }

  private get enginePath(): typeof path.posix {
    return this.useWSL ? path.posix : path;
  }

  toEngine(editorPath: string): string {
    return this.useWSL ? this.conversion.toEngine(editorPath) : this.identity(editorPath);
  }

  toEditor(enginePath: string): string {
    const absolute = this.enginePath.resolve(this.engineDirectory, enginePath);
    return this.useWSL ? this.conversion.toEditor(absolute) : absolute;
  }

  includeDirectory(directory: string): string {
    if (this.useWSL) {
      // Allow Windows paths in this setting while retaining Linux and relative paths.
      const converted = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith('\\\\')
        ? this.toEngine(directory) : directory;
      return path.posix.resolve(this.engineDirectory, converted);
    }
    return path.resolve(path.dirname(this.rootEditorPath), directory);
  }

  identity(editorPath: string): string {
    let canonical = this.identities.get(editorPath);
    if (!canonical) {
      try {
        canonical = fs.realpathSync.native(editorPath);
      } catch {
        canonical = editorPath;
      }
      this.identities.set(editorPath, canonical);
    }
    return canonical;
  }

  sourcePath(enginePath: string, includeDirectories: readonly string[]): string {
    const candidates = this.sourceCandidates(enginePath, includeDirectories);
    return candidates.find(file => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    }) || candidates[0];
  }

  sourceCandidates(enginePath: string, includeDirectories: readonly string[]): string[] {
    const direct = this.toEditor(enginePath);
    if (this.enginePath.isAbsolute(enginePath)) {
      return [direct];
    }
    // SyncTeX announces logical input names even when -I found the source in a
    // different directory. Keep the logical name for protocol writes, but match
    // the actual editor document on disk.
    return [direct, ...includeDirectories.map(directory =>
      this.toEditor(this.enginePath.resolve(this.engineDirectory, directory, enginePath)))];
  }

  logicalPath(editorPath: string): string {
    // Do not resolve symlinks here: these are keys in TeXpresso's VFS, and
    // changing a logical key can select a different cached file.
    return this.useWSL ? this.conversion.toEngine(editorPath) : editorPath;
  }

  aliases(editorPath: string, includeDirectories: readonly string[]): string[] {
    const aliases: string[] = [];
    for (const directory of [this.toEditor('.'), ...includeDirectories.map(dir => this.toEditor(dir))]) {
      const relative = path.relative(this.identity(directory), this.identity(editorPath));
      if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
        aliases.push(this.logicalPath(path.join(this.toEditor('.'), relative)));
      }
    }
    return [...new Set(aliases)];
  }
}
