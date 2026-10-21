import * as path from 'path';
import { windowsToWslSync, wslToWindowsSync } from 'wsl-path';

export interface PathConversion {
  toEngine(path: string): string;
  toEditor(path: string): string;
}

export class SessionPaths {
  readonly rootEnginePath: string;
  readonly engineDirectory: string;

  constructor(readonly rootEditorPath: string, readonly useWSL: boolean,
    private conversion: PathConversion = { toEngine: windowsToWslSync, toEditor: wslToWindowsSync }) {
    this.rootEnginePath = this.toEngine(rootEditorPath);
    this.engineDirectory = this.enginePath.dirname(this.rootEnginePath);
  }

  private get enginePath(): typeof path.posix {
    return this.useWSL ? path.posix : path;
  }

  toEngine(editorPath: string): string {
    return this.useWSL ? this.conversion.toEngine(editorPath) : editorPath;
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
}
