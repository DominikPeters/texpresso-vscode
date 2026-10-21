import * as vscode from 'vscode';
import * as path from 'path';
import { MainDocuments, isMainDocument } from './main-document';
import { renamedPath } from './renames';

export function mainDocuments(context: vscode.ExtensionContext): MainDocuments<vscode.TextDocument> {
  const project = (document: vscode.TextDocument) => vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath ||
    (document.isUntitled ? 'untitled' : path.dirname(document.fileName));
  let values = context.workspaceState?.get<Record<string, string>>('texpresso.mainDocuments', {}) || {};
  const persist = () => { void context.workspaceState?.update('texpresso.mainDocuments', values); };
  context.subscriptions.push(vscode.workspace.onDidRenameFiles(event => {
    values = Object.fromEntries(Object.entries(values).map(([project, root]) =>
      [renamedPath(project, event.files) || project, renamedPath(root, event.files) || root]));
    persist();
  }));
  return new MainDocuments({
    open: file => Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.file(file))),
    recalled: document => values[project(document)],
    remember(document, root) {
      values = { ...values };
      if (root && !root.isUntitled) { values[project(document)] = root.fileName; }
      else { delete values[project(document)]; }
      persist();
    },
    async choose(source, reason) {
      const folder = vscode.workspace.getWorkspaceFolder(source.uri);
      const directory = folder?.uri || (source.isUntitled ? undefined : vscode.Uri.file(path.dirname(source.fileName)));
      const uris = directory ? await vscode.workspace.findFiles(
        new vscode.RelativePattern(directory, folder ? '**/*.tex' : '*.tex'),
        '**/{.git,node_modules,texmf,texmf-dist,build,out,dist}/**', 200) : [];
      const candidates = new Map(uris.map(uri => [uri.fsPath, uri]));
      for (const document of vscode.workspace.textDocuments) {
        if (!document.isUntitled && project(document) === project(source) && /\.tex$/i.test(document.fileName)) {
          candidates.set(document.fileName, document.uri);
        }
      }
      const items: (vscode.QuickPickItem & { uri?: vscode.Uri; current?: boolean })[] = [];
      for (const uri of candidates.values()) {
        try {
          const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
          const text = open ? open.getText() : ((await vscode.workspace.fs.stat(uri)).size <= 1024 * 1024
            ? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') : '');
          if (isMainDocument(text)) {
            items.push({ label: path.basename(uri.fsPath), description: directory ? path.relative(directory.fsPath, uri.fsPath) : uri.fsPath,
              detail: folder?.name, uri });
          }
        } catch { /* A candidate may be deleted or inaccessible during the search. */ }
      }
      items.sort((a, b) => (a.description || '').localeCompare(b.description || ''));
      items.push({ label: '$(file-directory) Browse…' });
      if (!items.some(item => item.uri?.fsPath === source.fileName)) {
        items.push({ label: '$(file-code) Use Current File', description: path.basename(source.fileName), current: true });
      }
      const selected = await vscode.window.showQuickPick(items, { title: 'TeXpresso: Select Main Document',
        placeHolder: reason || 'Choose the document to preview', matchOnDescription: true });
      if (!selected) { return; }
      if (selected.current) { return source; }
      const uri = selected.uri || (await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: directory,
        openLabel: 'Select Main Document', filters: { 'TeX documents': ['tex'] } }))?.[0];
      return uri ? vscode.workspace.openTextDocument(uri) : undefined;
    }
  });
}
