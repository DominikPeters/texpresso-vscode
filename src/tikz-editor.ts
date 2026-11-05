import type * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import type { TexpressoSession } from './session';
import type { PreviewFigure, PreviewImageHeader } from './preview-protocol';
import { findTikzEditor, usableEditor } from './tikz-installation';
import { resolveFigure, sourceFigures, type SourceFigure } from './tikz-source';

export interface TikzActions {
  prepare(session: TexpressoSession, header: PreviewImageHeader): Promise<number[]>;
  open(session: TexpressoSession, header: PreviewImageHeader, index: number, current: () => boolean): Promise<void>;
}
interface Target { index: number; file: string; line: number; endLine: number; body: string }
const MAX_SOURCE = 16 * 1024 * 1024;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const substantialFigure = (f: PreviewFigure) => {
  const w = f.bounds[2] - f.bounds[0], h = f.bounds[3] - f.bounds[1];
  return w >= 24 && h >= 18 && w * h >= 900;
};
const location = (f: PreviewFigure) => JSON.stringify([f.file, f.line, f.endLine]);

export function launchTikzEditor(executable: string, file: string, line: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--source-line=' + line, file], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export class TikzEditor implements TikzActions {
  private detected?: { session: TexpressoSession; setting: string; value: Promise<string | undefined> };
  private targets = new WeakMap<PreviewImageHeader, Promise<Target[]>>();
  private parsed = new Map<string, { text: string; figures: SourceFigure[] }>();
  private parsedBytes = 0;
  private busy = false;
  constructor(private api: typeof vscode,
    private detect = findTikzEditor, private launch = launchTikzEditor) {}

  private local(session: TexpressoSession): boolean {
    return this.api.env.uiKind === 1 && !this.api.env.remoteName && this.api.workspace.isTrusted === true &&
      session.document.uri.scheme === 'file' &&
      (this.api.workspace.workspaceFolders || []).every(f => f.uri.scheme === 'file');
  }
  private executable(session: TexpressoSession): Promise<string | undefined> {
    const setting = this.api.workspace.getConfiguration('texpresso').get<string>('tikzEditorPath', '').trim();
    if (this.detected?.session !== session || this.detected.setting !== setting) {
      this.detected = { session, setting, value: this.detect(setting).catch(() => undefined) };
    }
    return this.detected.value;
  }
  private async disk(file: string): Promise<string | undefined> {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SOURCE) { return; }
      const bytes = Buffer.alloc(stat.size + 1), read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== stat.size) { return; } // A concurrent replace/growth requires a new preview.
      return bytes.subarray(0, read.bytesRead).toString('utf8').replace(/^\uFEFF/, '');
    } finally { await handle.close(); }
  }
  private figures(file: string, text: string): SourceFigure[] {
    const cached = this.parsed.get(file);
    if (cached?.text === text) { return cached.figures; }
    if (cached) { this.parsedBytes -= Buffer.byteLength(cached.text); this.parsed.delete(file); }
    const figures = sourceFigures(text), bytes = Buffer.byteLength(text);
    while (this.parsed.size && (this.parsed.size >= 8 || this.parsedBytes + bytes > MAX_SOURCE)) {
      const [key, value] = this.parsed.entries().next().value!;
      this.parsed.delete(key); this.parsedBytes -= Buffer.byteLength(value.text);
    }
    this.parsed.set(file, { text, figures }); this.parsedBytes += bytes;
    return figures;
  }
  private async source(session: TexpressoSession, logical: string) {
    const registered = session.sync.sourceFile(logical);
    if (!registered || (process.platform === 'win32' && registered.startsWith('\\\\'))) { return; }
    const file = await fs.realpath(registered);
    const overlay = session.sync.overlay(logical);
    if (overlay?.isUntitled || overlay?.isClosed) { return; }
    const text = overlay ? overlay.getText() : await this.disk(file);
    if (text === undefined || Buffer.byteLength(text) > MAX_SOURCE) { return; }
    return { file, text, figures: this.figures(file, text) };
  }
  private async collect(session: TexpressoSession, header: PreviewImageHeader): Promise<Target[]> {
    if (!this.local(session) || !header.annotations?.figures?.length || !(await this.executable(session))) { return []; }
    const figures = header.annotations.figures, counts = new Map<string, number>();
    const sources = new Map<string, ReturnType<TikzEditor['source']>>(), result: Target[] = [];
    for (const f of figures) {
      if (substantialFigure(f)) { counts.set(location(f), (counts.get(location(f)) || 0) + 1); }
    }
    for (let index = 0; index < figures.length; index++) {
      const f = figures[index]; if (!substantialFigure(f)) { continue; }
      if (!sources.has(f.file)) {
        if (sources.size >= 8) { continue; }
        sources.set(f.file, this.source(session, f.file).catch(() => undefined));
      }
      const source = await sources.get(f.file)!; if (!source) { continue; }
      const literal = resolveFigure(source.figures, f.line, f.endLine);
      if (!literal || (f.endLine === f.line + 1 && literal.enclosingEndLines.includes(f.line) && counts.get(location(f)) !== 1)) { continue; }
      result.push({ index, file: source.file, line: literal.line, endLine: literal.endLine,
        body: digest(source.text.slice(literal.offset, literal.endOffset)) });
    }
    return result;
  }
  async prepare(session: TexpressoSession, header: PreviewImageHeader): Promise<number[]> {
    if (!this.local(session)) { return []; }
    let targets = this.targets.get(header);
    if (!targets) { targets = this.collect(session, header).catch(() => []); this.targets.set(header, targets); }
    return (await targets).map(t => t.index);
  }
  async open(session: TexpressoSession, header: PreviewImageHeader, index: number, current: () => boolean): Promise<void> {
    if (this.busy || !this.local(session) || !current()) { return; }
    this.busy = true;
    try {
      const target = (await this.targets.get(header))?.find(t => t.index === index);
      const figure = header.annotations?.figures?.[index];
      if (!target || !figure || !current()) { return; }
      const source = await this.source(session, figure.file);
      const literal = source && resolveFigure(source.figures, figure.line, figure.endLine);
      if (!source || !literal || source.file !== target.file || literal.line !== target.line || literal.endLine !== target.endLine ||
          digest(source.text.slice(literal.offset, literal.endOffset)) !== target.body || !current()) {
        await this.api.window.showWarningMessage('The figure source changed. Wait for the preview to update and try again.'); return;
      }
      const doc = await this.api.workspace.openTextDocument(this.api.Uri.file(target.file));
      const version = doc.version;
      if (doc.getText() !== source.text || !current()) { return; }
      if (doc.isDirty) {
        const save = await this.api.window.showWarningMessage('Save changes to this source file before opening its figure in TikZ Editor?',
          { modal: true }, 'Save and Open');
        if (save !== 'Save and Open' || !current() || doc.version !== version || !(await doc.save())) { return; }
      }
      if (!current() || doc.version !== version || doc.isDirty || await this.disk(target.file) !== source.text) {
        await this.api.window.showWarningMessage('The source or preview changed. Wait for the preview to update and try again.'); return;
      }
      const app = await this.executable(session);
      if (!app || !(await usableEditor(app)) || !current() || !this.local(session)) {
        throw new Error('TikZ Editor is unavailable. Check TeXpresso: Tikz Editor Path in Settings.');
      }
      await this.launch(app, target.file, target.line);
    } catch (error) {
      await this.api.window.showErrorMessage('Could not open TikZ Editor: ' + (error instanceof Error ? error.message : String(error)));
    } finally { this.busy = false; }
  }
}
