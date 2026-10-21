import type * as vscode from 'vscode';
import { ByteBuffer } from './byte-buffer';
import { Command } from './protocol';
import { SessionPaths } from './paths';

interface SyncedFile {
  editorPath: string;
  enginePath: string;
  document?: vscode.TextDocument;
  buffer?: ByteBuffer;
}

export class DocumentSync {
  // Keep editor overlays for every source encountered, even when the engine
  // backtracks past its input-file index. A later pass can read these files again.
  private files = new Map<string, SyncedFile>();
  includeDirectories: readonly string[] = [];
  private engineFiles = new Map<string, SyncedFile>();

  constructor(
    readonly root: vscode.TextDocument,
    readonly paths: SessionPaths,
    private useRanges: boolean,
    private documents: () => readonly vscode.TextDocument[],
    private send: (command: Command) => void
  ) {
    this.files.set(paths.identity(paths.rootEditorPath), {
      editorPath: paths.rootEditorPath, enginePath: paths.rootEnginePath, document: root
    });
  }

  private find(document: vscode.TextDocument): SyncedFile | undefined {
    return document === this.root
      ? this.files.get(this.paths.identity(this.paths.rootEditorPath))
      : this.files.get(this.paths.identity(document.uri.fsPath));
  }

  private open(file: SyncedFile, document: vscode.TextDocument): void {
    file.document = document;
    file.editorPath = document.uri.fsPath;
    const contents = document.getText();
    file.buffer = this.useRanges ? undefined : new ByteBuffer(contents);
    this.send(['open', file.enginePath, contents]);
  }

  initialize(): void {
    for (const file of this.files.values()) {
      if (file.document && !file.document.isClosed) {
        this.open(file, file.document);
      }
    }
  }

  announce(enginePath: string): void {
    const logicalPath = this.paths.toEngine(this.paths.toEditor(enginePath));
    const editorPath = this.paths.sourcePath(enginePath, this.includeDirectories);
    const identity = this.paths.identity(editorPath);
    let file = this.files.get(identity);
    if (!file) {
      file = { editorPath, enginePath: logicalPath };
      this.files.set(identity, file);
    }
    this.engineFiles.set(logicalPath, file);
    const document = this.documents().find(doc => this.paths.identity(doc.uri.fsPath) === identity);
    if (document && file.document !== document) {
      this.open(file, document);
    }
  }

  openDocument(document: vscode.TextDocument): void {
    const file = this.find(document);
    if (file) {
      this.open(file, document);
    }
  }

  closeDocument(document: vscode.TextDocument): void {
    const file = this.find(document);
    if (file) {
      this.send(['close', file.enginePath]);
      file.document = undefined;
      file.buffer = undefined;
    }
  }

  change(document: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
    const file = this.find(document);
    if (!file) {
      return;
    }
    if (file.document !== document || (!this.useRanges && !file.buffer)) {
      // We have no pre-edit snapshot: send the complete current buffer.
      this.open(file, document);
      return;
    }
    // All ranges refer to the document before this event. Apply from the end.
    for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      if (this.useRanges) {
        this.send(['change-range', file.enginePath,
          change.range.start.line, change.range.start.character,
          change.range.end.line, change.range.end.character, change.text]);
      } else {
        const buffer = file.buffer!;
        const start = buffer.byteOffset(change.rangeOffset);
        const end = buffer.byteOffset(change.rangeOffset + change.rangeLength);
        this.send(['change', file.enginePath, start, end - start, change.text]);
        buffer.replace(change.rangeOffset, change.rangeLength, change.text);
      }
    }
  }

  contains(document: vscode.TextDocument): boolean {
    return this.find(document) !== undefined;
  }

  syncForward(document: vscode.TextDocument, line: number): void {
    const file = this.find(document);
    if (file) {
      // VS Code lines are zero based; SyncTeX source lines are one based.
      this.send(['synctex-forward', file.enginePath, line + 1]);
    }
  }

  refresh(): void {
    this.initialize();
    this.send(['rescan']);
  }

  get trackedPaths(): readonly string[] {
    return [...this.files.values()].map(file => file.editorPath);
  }

  editorPath(enginePath: string): string {
    const logicalPath = this.paths.toEngine(this.paths.toEditor(enginePath));
    const known = this.engineFiles.get(logicalPath);
    if (known) {
      return known.document?.uri.fsPath || known.editorPath;
    }
    const editorPath = this.paths.sourcePath(enginePath, this.includeDirectories);
    return this.files.get(this.paths.identity(editorPath))?.document?.uri.fsPath || editorPath;
  }
}
