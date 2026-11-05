/** A conservative literal word hint; control sequences and comments are excluded. */
export function sourceWordAt(line: string, character: number): string | undefined {
  const excluded = [...line.matchAll(/\\(?:[a-zA-Z@]+|.)|%.*/g)];
  for (const match of line.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)) {
    const start = match.index!, end = start + match[0].length;
    if (character >= start && character <= end && Buffer.byteLength(match[0]) <= 256 &&
        !excluded.some(m => start < m.index! + m[0].length && end > m.index!)) { return match[0]; }
  }
}

/** Native columns are one-based UTF-8 bytes; VS Code uses UTF-16 characters. */
export function characterFromByteColumn(line: string, column: number): number | undefined {
  if (!Number.isSafeInteger(column) || column < 1 || column > Buffer.byteLength(line) + 1) { return; }
  let bytes = 0, character = 0;
  for (const char of line) {
    if (bytes + Buffer.byteLength(char) > column - 1) { break; }
    bytes += Buffer.byteLength(char); character += char.length;
  }
  return character;
}

/** Refine line-only SyncTeX with a unique literal word near that source line.
 * Ambiguous words and macro-generated text retain the engine's line location.
 */
export function refineSourceWord(text: string, reportedLine: number, clicked?: string): { line: number; character: number } | undefined {
  const word = clicked?.normalize('NFKC').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!word || word.length < 2 || word.length > 128 || /\s/u.test(word)) { return; }
  const lines = text.split(/\r?\n/);
  if (reportedLine < 0 || reportedLine >= lines.length) { return; }
  let start = reportedLine, end = reportedLine;
  const boundary = (line: string) => !line.trim() || /^\s*\\(?:begin|end|(?:sub)*section|chapter|part|item)\b/.test(line);
  while (start > Math.max(0, reportedLine - 3) && !boundary(lines[start]) && !boundary(lines[start - 1])) { start--; }
  while (end < Math.min(lines.length - 1, reportedLine + 3) && !boundary(lines[end]) && !boundary(lines[end + 1])) { end++; }
  const matches: { line: number; character: number }[] = [];
  for (let line = start; line <= end; line++) {
    // Ignore comments and control sequence names, but retain literal text inside
    // formatting commands. Preserve UTF-16 offsets expected by VS Code.
    const source = lines[line];
    let normalized = '', offset = 0;
    const offsets: number[] = [];
    for (const char of source) {
      const value = char.normalize('NFKC');
      normalized += value; offsets.push(...Array<number>(value.length).fill(offset)); offset += char.length;
    }
    const excluded = [...normalized.matchAll(/\\(?:[a-zA-Z@]+|.)|%.*/g)];
    for (let index = normalized.indexOf(word); index !== -1; index = normalized.indexOf(word, index + 1)) {
      if (/[\p{L}\p{N}\p{M}_]/u.test(normalized[index - 1] || '') ||
          /[\p{L}\p{N}\p{M}_]/u.test(normalized[index + word.length] || '') ||
          excluded.some(match => index < match.index! + match[0].length && index + word.length > match.index!)) { continue; }
      matches.push({ line, character: offsets[index] });
      if (matches.length > 1) { return; }
    }
  }
  return matches[0];
}
