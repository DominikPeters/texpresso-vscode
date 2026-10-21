import type * as vscode from 'vscode';
import { ByteBuffer } from './byte-buffer';
import { Command } from './protocol';
import { SessionPaths } from './paths';
import * as fs from 'fs';

interface SyncedFile {
  editorPath: string;
  enginePaths: Set<string>;
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
    const rootFile = {
      editorPath: paths.rootEditorPath, enginePaths: new Set([paths.rootEnginePath]), document: root
    };
    this.files.set(paths.identity(paths.rootEditorPath), rootFile);
    this.engineFiles.set(paths.rootEnginePath, rootFile);
  }

  private find(document: vscode.TextDocument): SyncedFile | undefined {
    return document === this.root
      ? this.files.get(this.paths.identity(this.paths.rootEditorPath))
      : this.files.get(this.paths.identity(document.uri.fsPath));
  }

  private open(file: SyncedFile, document: vscode.TextDocument): void {
    file.document = document;
    if (document !== this.root || !document.isUntitled) {
      file.editorPath = document.uri.fsPath;
    }
    const contents = document.getText();
    file.buffer = this.useRanges ? undefined : new ByteBuffer(contents);
    for (const enginePath of file.enginePaths) {
      this.send(['open', enginePath, contents]);
    }
  }

  initialize(): void {
    for (const file of this.files.values()) {
      if (file.document && !file.document.isClosed) {
        this.open(file, file.document);
      }
    }
  }

  announce(enginePath: string): void {
    const logicalPath = this.paths.logicalPath(this.paths.toEditor(enginePath));
    const candidates = this.paths.sourceCandidates(enginePath, this.includeDirectories);
    const resolved = this.paths.sourcePath(enginePath, this.includeDirectories);
    const document = this.engineFiles.get(logicalPath)?.document || this.documents().find(doc =>
      this.paths.identity(doc.uri.fsPath) === this.paths.identity(resolved)) ||
      (!fs.existsSync(resolved) ? this.documents().find(doc => candidates.some(candidate =>
        this.paths.identity(doc.uri.fsPath) === this.paths.identity(candidate))) : undefined);
    const editorPath = document === this.root && document.isUntitled ? this.paths.rootEditorPath :
      document?.uri.fsPath || resolved;
    const identity = this.paths.identity(editorPath);
    let file = this.files.get(identity);
    if (!file) {
      file = { editorPath, enginePaths: new Set() };
      this.files.set(identity, file);
    }
    const newAlias = !file.enginePaths.has(logicalPath);
    file.enginePaths.add(logicalPath);
    this.engineFiles.set(logicalPath, file);
    if (document && file.document !== document) {
      this.open(file, document);
    } else if (document && newAlias) {
      this.send(['open', logicalPath, document.getText()]);
    }
  }

  prime(): void {
    for (const document of this.documents()) {
      if (document === this.root || document.isUntitled) {
        continue;
      }
      for (const alias of this.paths.aliases(document.uri.fsPath, this.includeDirectories)) {
        const identity = this.paths.identity(document.uri.fsPath);
        let file = this.files.get(identity);
        if (!file) {
          file = { editorPath: document.uri.fsPath, enginePaths: new Set(), document };
          this.files.set(identity, file);
        }
        file.enginePaths.add(alias);
        this.engineFiles.set(alias, file);
      }
    }
    for (const file of this.files.values()) {
      for (const enginePath of file.enginePaths) {
        this.send(['register', enginePath]);
      }
    }
  }

  overlay(enginePath: string): vscode.TextDocument | undefined {
    const known = this.engineFiles.get(this.paths.logicalPath(this.paths.toEditor(enginePath)))?.document;
    if (known && !known.isClosed) {
      return known;
    }
    const candidates = this.paths.sourceCandidates(enginePath, this.includeDirectories);
    const resolved = this.paths.sourcePath(enginePath, this.includeDirectories);
    return this.documents().find(doc => !doc.isClosed && this.paths.identity(resolved) === this.paths.identity(doc.uri.fsPath)) ||
      (!fs.existsSync(resolved) ? this.documents().find(doc => !doc.isClosed && candidates.some(file =>
        this.paths.identity(file) === this.paths.identity(doc.uri.fsPath))) : undefined);
  }

  hasOverlay(editorPath: string): boolean {
    return [...this.files.values()].some(file => file.document && !file.document.isClosed &&
      this.paths.identity(file.editorPath) === this.paths.identity(editorPath));
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
      for (const enginePath of file.enginePaths) {
        this.send(['close', enginePath]);
      }
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
        for (const enginePath of file.enginePaths) {
          this.send(['change-range', enginePath,
            change.range.start.line, change.range.start.character,
            change.range.end.line, change.range.end.character, change.text]);
        }
      } else {
        const buffer = file.buffer!;
        const start = buffer.byteOffset(change.rangeOffset);
        const end = buffer.byteOffset(change.rangeOffset + change.rangeLength);
        for (const enginePath of file.enginePaths) {
          this.send(['change', enginePath, start, end - start, change.text]);
        }
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
      this.send(['synctex-forward', [...file.enginePaths][0], line + 1]);
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
    const logicalPath = this.paths.logicalPath(this.paths.toEditor(enginePath));
    const known = this.engineFiles.get(logicalPath);
    if (known) {
      if (known.document === this.root && this.root.isUntitled) {
        return this.paths.rootEditorPath;
      }
      return known.document?.uri.fsPath || known.editorPath;
    }
    const editorPath = this.paths.sourcePath(enginePath, this.includeDirectories);
    return this.files.get(this.paths.identity(editorPath))?.document?.uri.fsPath || editorPath;
  }
}
