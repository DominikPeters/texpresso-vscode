export interface SourceFigure {
  line: number; endLine: number; offset: number; endOffset: number; enclosingEndLines: number[];
}

// Resolve literal outer pictures, rather than guessing from inverse SyncTeX or
// treating macro-generated badges as editable source environments.
export function sourceFigures(text: string): SourceFigure[] {
  const result: SourceFigure[] = [], braces: number[] = [];
  let line = 1, begin = 0, beginLine = 0, depth = 0;
  for (let i = 0; i < text.length;) {
    if (text[i] === '\n') { line++; i++; continue; }
    if (text[i] === '%') { while (i < text.length && text[i] !== '\n') { i++; } continue; }
    if (text[i] === '{') { braces.push(i); }
    if (text[i] === '}' && braces.length) {
      const opening = braces.pop()!;
      for (const figure of result) {
        if (figure.offset > opening && figure.endOffset <= i) { figure.enclosingEndLines.push(line); }
      }
    }
    if (text[i++] !== '\\' || i === text.length) { continue; }
    const start = i - 1, commandLine = line;
    let command = '';
    if (/[a-zA-Z@]/.test(text[i])) {
      while (i < text.length && /[a-zA-Z@]/.test(text[i])) { command += text[i++]; }
    } else { i++; continue; }
    if (command === 'verb' || command === 'lstinline') {
      if (text[i] === '*') { i++; }
      if (i < text.length && !/\s/.test(text[i])) {
        const delimiter = text[i++];
        while (i < text.length && text[i] !== delimiter && text[i] !== '\n') { i++; }
        if (text[i] === delimiter) { i++; }
      }
      continue;
    }
    if (command !== 'begin' && command !== 'end') { continue; }
    while (i < text.length && /\s/.test(text[i])) { if (text[i++] === '\n') { line++; } }
    if (text[i++] !== '{') { continue; }
    let environment = '';
    while (i < text.length && text[i] !== '}' && text[i] !== '\n') { environment += text[i++]; }
    if (text[i++] !== '}') { continue; }
    if (command === 'begin' && ['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment'].includes(environment)) {
      const closing = '\\end{' + environment + '}', end = text.indexOf(closing, i);
      const next = end < 0 ? text.length : end + closing.length;
      line += (text.slice(i, next).match(/\n/g) || []).length; i = next; continue;
    }
    if (environment !== 'tikzpicture' && environment !== 'tikzpicture*') { continue; }
    if (command === 'begin') {
      if (depth++ === 0) { begin = start; beginLine = commandLine; }
    } else if (depth && --depth === 0) {
      result.push({ line: beginLine, endLine: line + 1, offset: begin, endOffset: i, enclosingEndLines: [] });
    }
  }
  return result;
}

export function resolveFigure(figures: SourceFigure[], line: number, endLine: number): SourceFigure | undefined {
  const matches = figures.filter(f => (f.line === line && f.endLine === endLine) ||
    (endLine === line + 1 && f.enclosingEndLines.includes(line)));
  return matches.length === 1 ? matches[0] : undefined;
}
