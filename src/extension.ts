// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
// Import child_process
import { ChildProcess, spawn, execSync } from 'child_process';
// import tmp
import * as tmp from 'tmp';
// import fs
import * as fs from 'fs';

import Rope from './rope';

const textEncoder = new TextEncoder();
function byteLength(str : string) : number {
  return textEncoder.encode(str).length;
}

tmp.setGracefulCleanup();

let texpresso: ChildProcess;
let rope: Rope;
let filePath: string;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	if (texpresso) {
		texpresso.kill();
	}

	const outputChannel = vscode.window.createOutputChannel('Texpresso', {log: true});
	const debugChannel = vscode.window.createOutputChannel('Texpresso Debug', {log: true});
	let providedOutput = "";
	let outputChanged = true;

	let activeEditor: vscode.TextEditor | undefined;

	// The command has been defined in the package.json file
	let disposable = vscode.commands.registerCommand('texpresso.startDocument', () => {
		activeEditor = vscode.window.activeTextEditor;
		if (activeEditor) {
			// vscode.window.showInformationMessage('Starting Texpreso for this document');
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
			console.log('Starting Texpresso for', filePath);
			// Start texpresso
			const command = vscode.workspace.getConfiguration('texpresso').get('command') as string;
			// Check if command exists
			try {
				fs.accessSync(command, fs.constants.X_OK);
			} catch (error) {
				vscode.window.showErrorMessage(
					`Texpresso command '${command}' does not exist or is not executable. Please check the 'texpresso.command' setting.`,
					'Open Settings'
				).then(value => {
					if (value === 'Open Settings') {
						vscode.commands.executeCommand('workbench.action.openSettings', 'texpresso.command');
					}
				});
				return;
			}
			texpresso = spawn(command, ['-json', filePath]);
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
						console.log("Received", message);
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
			// Send file content to texpresso
			const message = ["open", filePath, activeEditor.document.getText()];
			if (texpresso && texpresso.stdin) {
				texpresso.stdin.write(JSON.stringify(message) + '\n');
			}
		}
	});

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
				// const happy = rope.toString() === activeEditor.document.getText() && start == byteLength(activeEditor.document.getText().slice(0, change.rangeOffset));
				// console.log('change-message', [change.rangeOffset, change.rangeLength], message.slice(2, 5), happy, change.range.start.character, change.range.end.character);
			}
			texpresso?.stdin?.uncork();
		}
	}, null, context.subscriptions);

	let previouslySentLineNumber: number | undefined;
	vscode.window.onDidChangeTextEditorSelection(event => {
		if (activeEditor && event.textEditor.document === activeEditor.document) {
			const lineNumber = activeEditor.selection.active.line;
			if (!previouslySentLineNumber || previouslySentLineNumber !== lineNumber) {
				previouslySentLineNumber = lineNumber;
				if (texpresso && texpresso.stdin) {
					const message = ["synctex-forward", filePath, lineNumber];
					texpresso.stdin.write(JSON.stringify(message) + '\n');
				}
			}
		}
	});

	context.subscriptions.push(disposable);

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

		}
	}));
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (texpresso) {
		texpresso.kill();
	}
}
