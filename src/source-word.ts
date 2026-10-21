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
