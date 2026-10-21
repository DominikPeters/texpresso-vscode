import * as path from 'path';

// Explorer renames can move a file or an entire containing directory.
export function renamedPath(file: string,
  renames: readonly { oldUri: { fsPath: string }; newUri: { fsPath: string } }[]): string | undefined {
  for (const { oldUri, newUri } of renames) {
    const relative = path.relative(oldUri.fsPath, file);
    if (relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
      return path.join(newUri.fsPath, relative);
    }
  }
  return undefined;
}
