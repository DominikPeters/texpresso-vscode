import * as vscode from 'vscode';
import { ChildProcess, spawn, execSync } from 'child_process';
import * as tmp from 'tmp';
import * as fs from 'fs';

import Rope from './rope';

tmp.setGracefulCleanup();

let texpresso: ChildProcess;
let rope: Rope;
let filePath: string;

export function activate(context: vscode.ExtensionContext) {

	if (texpresso) {
		texpresso.kill();
	}

	const outputChannel = vscode.window.createOutputChannel('TeXpresso', { log: true });
	const debugChannel = vscode.window.createOutputChannel('TeXpresso Debug', { log: true });
	let providedOutput = "";
	let outputChanged = true;

	const useWSL = vscode.workspace.getConfiguration('texpresso').get('useWSL') as boolean;

	let activeEditor: vscode.TextEditor | undefined;

	function startDocumentFromEditor(editor: vscode.TextEditor | undefined) {
		if (texpresso) {
			texpresso.kill();
		}

		if (editor) {
			activeEditor = editor;
			// vscode.window.showInformationMessage('Starting TeXpresso for this document');
			filePath = activeEditor.document.fileName;
			const text = activeEditor.document.getText();
			rope = new Rope(text);
			if (activeEditor.document.isUntitled) {
				const tmpDir = tmp.dirSync();
				filePath = tmpDir.name + '/untitled.tex';
				fs.writeFileSync(filePath, text);
				// on macOS, the temp file goes into a symlinked directory, so we need to resolve the path
				filePath = fs.realpathSync(filePath);
			}

			vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', true);
			vscode.commands.executeCommand('setContext', 'texpresso.running', true);
			// Start texpresso
			const command = vscode.workspace.getConfiguration('texpresso').get('command') as string;
			// Check if command exists
			try {
				if (!useWSL) {
					fs.accessSync(command, fs.constants.X_OK);
				} else {
					fs.accessSync('wsl', fs.constants.X_OK);
					execSync(`wsl -e test -x ${command}`);
				}
			} catch (error) {
				let message = `TeXpresso command '${command}' does not exist or is not executable. Please check the 'texpresso.command' setting.`;
				if (process.platform === 'win32') {
					message = `TeXpresso command '${command}' does not exist or is not executable. Please check the 'texpresso.command' and 'texpresso.wsl' settings.`;
					if (useWSL) {
						message = `TeXpresso command '${command}' is not executable, or the 'wsl' command is not available. Please check the 'texpresso.command' and 'texpresso.wsl' settings.`;
					}
				}
				vscode.window.showErrorMessage(
					message,
					'Open Settings'
				).then(value => {
					if (value === 'Open Settings') {
						vscode.commands.executeCommand('workbench.action.openSettings', 'texpresso.');
					}
				});
				return;
			}

			// react to messages from texpresso
			if (!useWSL) {
				texpresso = spawn(command, ['-json', filePath]);
			} else {
				filePath = execSync(`wsl wslpath "${filePath}"`).toString().trim();
				texpresso = spawn('wsl', ['-e', command, '-json', filePath]);
			}
			if (texpresso && texpresso.stdout) {
				texpresso.stdout.on('data', data => {
					const message = JSON.parse(data.toString());
					if (message[0] === 'synctex' && message[1] === activeEditor?.document.fileName) {
						const line = message[2];
						activeEditor?.revealRange(new vscode.Range(line - 1, 0, line - 1, 0));
					}
					else if (message[0] === 'append' && message[1] === 'log') {
						providedOutput += message[3];
						outputChanged = true;
					}
					else if (message[0] === 'truncate' && message[1] === 'log') {
						const bytesToKeep = message[2];
						providedOutput = providedOutput.slice(-bytesToKeep);
						outputChanged = true;
					}
					else if (message[0] === 'flush') {
						if (outputChanged) {
							outputChanged = false;
							outputChannel.replace(providedOutput);
						}
					}
					else {
						console.log("Received unhandled message", message);
					}
				});
			}
			if (texpresso && texpresso.stderr) {
				texpresso.stderr.on('data', data => {
					debugChannel.append(data.toString());
				});
			}
			if (texpresso) {
				texpresso.on('close', code => {
					if (code !== 0) {
						vscode.window.showErrorMessage(`TeXpresso exited with code ${code}`);
					}
					activeEditor = undefined;
					vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', false);
					vscode.commands.executeCommand('setContext', 'texpresso.running', false);
					outputChannel.clear();
					debugChannel.clear();
				});
			}
			// Send file content to texpresso
			const message = ["open", filePath, activeEditor.document.getText()];
			if (texpresso && texpresso.stdin) {
				texpresso.stdin.write(JSON.stringify(message) + '\n');
			}
			// Send color theme to texpresso if setting is enabled
			if (vscode.workspace.getConfiguration('texpresso').get('useEditorTheme') as boolean) {
				adoptTheme();
			}
		}
	}

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.startDocument', () => {
		startDocumentFromEditor(vscode.window.activeTextEditor);
	}));

	vscode.workspace.onDidChangeTextDocument(event => {
		if (activeEditor && event.document === activeEditor.document) {
			// send change message to texpresso via stdin
			texpresso?.stdin?.cork();
			for (const change of event.contentChanges) {
				// get byte offsets of change
				const start = rope.byteOffset(change.rangeOffset);
				const end = rope.byteOffset(change.rangeOffset + change.rangeLength);
				// send change message
				const message = ["change", filePath, start, end - start, change.text];
				texpresso?.stdin?.write(JSON.stringify(message) + '\n');
				// implement change in rope
				rope.remove(change.rangeOffset, change.rangeOffset + change.rangeLength);
				rope.insert(change.rangeOffset, change.text);
			}
			texpresso?.stdin?.uncork();
		}
	}, null, context.subscriptions);

	vscode.window.onDidChangeActiveTextEditor(editor => {
		if (activeEditor && editor && editor.document === activeEditor.document) {
			vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', true);
		} else {
			vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', false);
		}
	});

	/***********************************
	 ***********************************
	 ****  SyncTeX and Page Choice  ****
	 ***********************************
	 **********************************/

	let previouslySentLineNumber: number | undefined;
	function doSyncTeXForward(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor) {
		if (!editor || editor.document !== activeEditor?.document) {
			return;
		}
		const lineNumber = editor.selection.active.line;
		if (!previouslySentLineNumber || previouslySentLineNumber !== lineNumber) {
			previouslySentLineNumber = lineNumber;
			if (texpresso && texpresso.stdin) {
				const message = ["synctex-forward", filePath, lineNumber];
				texpresso.stdin.write(JSON.stringify(message) + '\n');
			}
		}
	}

	vscode.window.onDidChangeTextEditorSelection(event => {
		if (activeEditor
			&& event.textEditor.document === activeEditor.document
			&& vscode.workspace.getConfiguration('texpresso').get('syncTeXForwardOnSelection') as boolean) {
			doSyncTeXForward(event.textEditor);
		}
	});

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.syncTeXForward', () => {
		doSyncTeXForward();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.syncTeXForwardShortName', (event) => {
		doSyncTeXForward();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.activateSyncTeXForward', () => {
		vscode.workspace.getConfiguration('texpresso').update('syncTeXForwardOnSelection', true, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.deactivateSyncTeXForward', () => {
		vscode.workspace.getConfiguration('texpresso').update('syncTeXForwardOnSelection', false, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.nextPage', () => {
		if (activeEditor) {
			const message = ["next-page"];
			texpresso?.stdin?.write(JSON.stringify(message) + '\n');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.previousPage', () => {
		if (activeEditor) {
			const message = ["previous-page"];
			texpresso?.stdin?.write(JSON.stringify(message) + '\n');
		}
	}));

	/***********************************
	 ***********************************
	 ****    Theme Color Adaption   ****
	 ***********************************
	 **********************************/

	function adoptTheme() {
		if (!texpresso || !activeEditor) {
			return;
		}
		// to get explicit colors of the theme (which are not available in the API), we need to open a webview
		// see https://github.com/microsoft/vscode/issues/32813#issuecomment-798680103
		const webviewPanel = vscode.window.createWebviewPanel(
			'texpresso.colorTheme',
			'Color Theme',
			{ preserveFocus: true, viewColumn: vscode.ViewColumn.Beside },
			{
				enableScripts: true,
			}
		);
		const webview = webviewPanel.webview;
		webview.html = `<!DOCTYPE html><html><script>
			const vscode = acquireVsCodeApi();
			vscode.postMessage(Object.values(document.getElementsByTagName('html')[0].style).map(
			(rv) => {
				return {
				[rv]: document
					.getElementsByTagName('html')[0]
					.style.getPropertyValue(rv),
				}
			}
			));
		</script></html>`;
		webview.onDidReceiveMessage((cssVars) => {
			webviewPanel.dispose();
			const colors = {} as { [key: string]: number[] };
			for (const cssVar of cssVars) {
				const key = Object.keys(cssVar)[0];
				const value = cssVar[key];
				if (key === '--vscode-editor-background' || key === '--vscode-editor-foreground') {
					// value is for example "#cccccc"
					// convert it to rgb as three floats between 0 and 1
					const rgb = value.match(/#(..)(..)(..)/);
					if (rgb) {
						colors[key] = [
							parseInt(rgb[1], 16) / 255,
							parseInt(rgb[2], 16) / 255,
							parseInt(rgb[3], 16) / 255,
						];
					}
				}
			}
			const message = ["theme", colors['--vscode-editor-background'], colors['--vscode-editor-foreground']];
			texpresso?.stdin?.write(JSON.stringify(message) + '\n');
		});
	}

	vscode.window.onDidChangeActiveColorTheme(() => {
		if (vscode.workspace.getConfiguration('texpresso').get('useEditorTheme') as boolean) {
			adoptTheme();
		}
	});

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.adoptTheme', () => {
		adoptTheme();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.defaultTheme', () => {
		if (texpresso) {
			const message = ["theme", [1, 1, 1], [0, 0, 0]];
			texpresso.stdin?.write(JSON.stringify(message) + '\n');
		}
	}));

	/***********************************
	 ***********************************
	 *****     Refresh and Stop    *****
	 ***********************************
	 **********************************/

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.freshCompile', () => {
		if (activeEditor) {
			const text = activeEditor.document.getText();
			rope = new Rope(text);
			// resend "open" command
			const message = ["open", filePath, text];
			texpresso?.stdin?.write(JSON.stringify(message) + '\n');
			texpresso?.stdin?.write(JSON.stringify(["rescan"]) + '\n');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.stop', () => {
		if (texpresso) {
			texpresso.kill();
		}
		activeEditor = undefined;
		vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', false);
		vscode.commands.executeCommand('setContext', 'texpresso.running', false);
		outputChannel.clear();
		debugChannel.clear();
	}));
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (texpresso) {
		texpresso.kill();
	}
}
