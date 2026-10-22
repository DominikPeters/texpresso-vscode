const vscode = require('vscode');
const path = require('node:path');
exports.activate = async function(context) {
  try {
    const file = process.env.TEXPRESSO_DEMO_FILE || path.resolve(context.extensionPath, '../../artifacts/preview-demo/sample/embedded-preview.tex');
    const extension = vscode.extensions.getExtension('DominikPeters.texpresso-basic');
    if (!extension) throw new Error('TeXpresso is not installed in the demo profile.');
    await extension.activate();
    const document = await vscode.workspace.openTextDocument(path.resolve(file));
    const options = {viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: false};
    const editor = await vscode.window.showTextDocument(document, options);
    const start = Math.max(0, document.getText().split('\n').findIndex(line => line.startsWith('Edit this sentence') || line.startsWith('Edit the source')));
    editor.selection = new vscode.Selection(start, 0, start, 0);
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('texpresso.startDocument');
    await vscode.commands.executeCommand('texpresso.syncTeXForward');
    await vscode.window.showTextDocument(document, options);
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
  } catch (error) {
    vscode.window.showErrorMessage('TeXpresso demo: ' + error.message);
  }
};
