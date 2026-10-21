import type * as vscode from 'vscode';
import Rope from './rope';
import { Command } from './protocol';
import { SessionPaths } from './paths';

interface SyncedFile {
  editorPath: string;
  enginePath: string;
  document?: vscode.TextDocument;
  rope?: Rope;
}

export class DocumentSync {
  // Keep editor overlays for every source encountered, even when the engine
  // backtracks past its input-file index. A later pass can read these files again.
  private files = new Map<string, SyncedFile>();

  constructor(
    readonly root: vscode.TextDocument,
    readonly paths: SessionPaths,
    private useRanges: boolean,
    private documents: () => readonly vscode.TextDocument[],
    private send: (command: Command) => void
  ) {
    this.files.set(paths.rootEditorPath, {
      editorPath: paths.rootEditorPath, enginePath: paths.rootEnginePath, document: root
    });
  }

  private find(document: vscode.TextDocument): SyncedFile | undefined {
    return document === this.root
      ? this.files.get(this.paths.rootEditorPath)
      : this.files.get(document.uri.fsPath);
  }

  private open(file: SyncedFile, document: vscode.TextDocument): void {
    file.document = document;
    const contents = document.getText();
    file.rope = this.useRanges ? undefined : new Rope(contents);
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
    const editorPath = this.paths.toEditor(enginePath);
    let file = this.files.get(editorPath);
    if (!file) {
      file = { editorPath, enginePath: this.paths.toEngine(editorPath) };
      this.files.set(editorPath, file);
    }
    const document = this.documents().find(doc => doc.uri.fsPath === editorPath);
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
      file.rope = undefined;
    }
  }

  change(document: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
    const file = this.find(document);
    if (!file) {
      return;
    }
    if (file.document !== document || (!this.useRanges && !file.rope)) {
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
        const rope = file.rope!;
        const start = rope.byteOffset(change.rangeOffset);
        const end = rope.byteOffset(change.rangeOffset + change.rangeLength);
        this.send(['change', file.enginePath, start, end - start, change.text]);
        rope.remove(change.rangeOffset, change.rangeOffset + change.rangeLength);
        rope.insert(change.rangeOffset, change.text);
      }
    }
  }

  contains(document: vscode.TextDocument): boolean {
    return this.find(document) !== undefined;
  }

  syncForward(document: vscode.TextDocument, line: number): void {
    const file = this.find(document);
    if (file) {
      this.send(['synctex-forward', file.enginePath, line]);
    }
  }

  refresh(): void {
    this.initialize();
    this.send(['rescan']);
  }
}
