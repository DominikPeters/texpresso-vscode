import * as path from 'path';

export interface RootDocument { fileName: string; isUntitled: boolean; getText(): string }
export interface RootServices<D extends RootDocument> {
  open(file: string): Promise<D>;
  choose(source: D, reason?: string): Promise<D | undefined>;
  recalled(source: D): string | undefined;
  remember(source: D, root: D | undefined): void;
}

export function magicRoot(text: string): string | undefined {
  const match = text.match(/^[\t ]*%[\t ]*![\t ]*TeX[\t ]+root[\t ]*=[\t ]*(.*)$/im);
  const value = match?.[1].trim();
  return value?.replace(/^(["'])(.*)\1$/, '$2');
}

export function isMainDocument(text: string): boolean {
  // Ignore escaped percent signs and comments, so commented examples do not
  // turn a chapter into a standalone document.
  const examplesRemoved = text.replace(/\\verb\*?([^a-zA-Z\s]).*?\1/g, '')
    .replace(/\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted)\}[\s\S]*?\\end\s*\{\1\}/g, '');
  const uncommented = examplesRemoved.split(/\r?\n/).map(line => line.replace(/(^|[^\\])(?:\\\\)*%.*/, '$1')).join('\n');
  return /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{|\\begin\s*\{document\}/.test(uncommented);
}

export class MainDocuments<D extends RootDocument> {
  constructor(private services: RootServices<D>) {}

  async select(source: D, reason?: string): Promise<D | undefined> {
    const root = await this.services.choose(source, reason);
    if (root) { this.services.remember(source, root); }
    return root;
  }

  async resolve(source: D, known?: { root: D; contains(document: D): boolean }): Promise<D | undefined> {
    let document = source;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      const key = process.platform === 'win32' ? path.resolve(document.fileName).toLowerCase() : path.resolve(document.fileName);
      if (visited.has(key)) { throw new Error('TeXpresso: Circular % !TeX root comments at ' + document.fileName); }
      visited.add(key);
      const target = magicRoot(document.getText());
      if (target === undefined) { break; }
      if (!target) { throw new Error('TeXpresso: Empty % !TeX root comment in ' + document.fileName); }
      if (document.isUntitled && !path.isAbsolute(target)) {
        throw new Error('TeXpresso: Save this file before using a relative % !TeX root path.');
      }
      const file = path.resolve(path.dirname(document.fileName), target);
      try { document = await this.services.open(file); }
      catch { throw new Error('TeXpresso: Cannot open main document ' + file + ' referenced by ' + document.fileName); }
      if (depth === 31) { throw new Error('TeXpresso: Too many chained % !TeX root comments.'); }
    }
    if (document !== source) { return document; }
    if (known?.contains(source)) { return known.root; }
    if (isMainDocument(source.getText())) { return source; }
    const remembered = this.services.recalled(source);
    if (remembered) {
      try { return await this.services.open(remembered); }
      catch {
        this.services.remember(source, undefined);
        return this.select(source, 'The previously selected main document is unavailable. Choose another file.');
      }
    }
    return this.select(source);
  }
}
