import * as vscode from 'vscode';
import { ChildProcess, spawn, execSync } from 'child_process';
import * as tmp from 'tmp';
import * as fs from 'fs';
import * as path from 'path';
import { windowsToWslSync, wslToWindowsSync } from 'wsl-path';

import Rope from './rope';
import { PreviewPanel } from './preview';

tmp.setGracefulCleanup();

class WSLPathConverter {
	private enabled: boolean;

	constructor(useWSL: boolean) {
		this.enabled = useWSL;
	}

	toWindows(wslPath: string): string {
		if (!this.enabled) { return wslPath; }
		try { return wslToWindowsSync(wslPath); } catch (_) { return wslPath; }
	}

	toWSL(windowsPath: string): string {
		if (!this.enabled) { return windowsPath; }
		try { return windowsToWslSync(windowsPath); } catch (_) { return windowsPath; }
	}
}

interface TrackedFile {
	index: number;
	relativePath: string;
	absolutePath: string;
	isOpen: boolean;
	document?: vscode.TextDocument;
	rope?: Rope;
}

class FileRegistry {
	private files = new Map<number, TrackedFile>();
	private pathToIndex = new Map<string, number>();
	private pathConverter: WSLPathConverter;

	constructor(private documentDir: string, useWSL: boolean) {
		this.pathConverter = new WSLPathConverter(useWSL);
	}

	addFile(index: number, relativePath: string, sendCommand: (cmd: any[]) => void) {
		const absolutePath = this.resolvePath(relativePath);
		const isOpen = vscode.workspace.textDocuments.some(doc => doc.uri.fsPath === absolutePath);
		const document = isOpen ? vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === absolutePath) : undefined;
		const file: TrackedFile = { index, relativePath, absolutePath, isOpen, document, rope: undefined };
		this.files.set(index, file);
		this.pathToIndex.set(absolutePath, index);
		if (document && isOpen) {
			sendCommand(["open", absolutePath, document.getText()]);
		}
	}

	findByIndex(index: number): TrackedFile | undefined { return this.files.get(index); }

	findByPath(absolutePath: string): TrackedFile | undefined {
		let index = this.pathToIndex.get(absolutePath);
		if (index === undefined) {
			index = this.pathToIndex.get(this.pathConverter.toWindows(absolutePath));
		}
		if (index === undefined) {
			const wslPath = this.pathConverter.toWSL(absolutePath);
			index = this.pathToIndex.get(this.pathConverter.toWindows(wslPath));
		}
		return index !== undefined ? this.files.get(index) : undefined;
	}

	private resolvePath(relativePath: string): string {
		const resolved = relativePath.startsWith('/') ? relativePath : path.resolve(this.documentDir, relativePath);
		return this.pathConverter.toWindows(resolved);
	}

	updateDocument(absolutePath: string, document: vscode.TextDocument | undefined, isOpen: boolean, sendCommand: (cmd: any[]) => void) {
		const file = this.findByPath(absolutePath);
		if (file) {
			const wasOpen = file.isOpen;
			file.isOpen = isOpen;
			file.document = document;
			if (isOpen && !wasOpen && document) {
				sendCommand(["open", file.absolutePath, document.getText()]);
			}
		}
	}

	clear() { this.files.clear(); this.pathToIndex.clear(); }
}

let texpresso: ChildProcess;
let rope: Rope;
let filePath: string;
let documentDir: string;
let registry: FileRegistry;

let previewPanels: Map<string, PreviewPanel> = new Map();
let texpressoProcesses: Map<string, ChildProcess> = new Map();
let subToMainMap: Map<string, string> = new Map();

function updateSubFileContext() {
	const ae = vscode.window.activeTextEditor;
	if (ae) {
		try {
			const ap = fs.realpathSync(ae.document.uri.fsPath);
			const mm = subToMainMap.get(ap);
			const hm = !!(mm && texpressoProcesses.has(mm));
			vscode.commands.executeCommand('setContext', 'texpresso.hasMainFile', hm);
			vscode.commands.executeCommand('setContext', 'texpresso.previewActiveForCurrentFile', !!(mm && (previewPanels.has(mm) || texpressoProcesses.has(mm))));
		} catch (_) {}
	}
}

function handleWebviewMessage(msg: any) {
	if (!texpresso || !texpresso.stdin) {
		console.warn('TeXpresso: dropping webview message (texpresso process not running):', msg.type);
		return;
	}
	switch (msg.type) {
		case 'preview-ready':
			// Webview initialization complete — handled silently
			break;
		case 'synctex-backward':
			texpresso.stdin.write(JSON.stringify(["synctex-backward", msg.page, msg.x, msg.y]) + '\n');
			break;
		case 'previous-page':
			texpresso.stdin.write(JSON.stringify(["previous-page"]) + '\n');
			break;
		case 'next-page':
			texpresso.stdin.write(JSON.stringify(["next-page"]) + '\n');
			break;
		case 'set-page':
			texpresso.stdin.write(JSON.stringify(["set-page", msg.page]) + '\n');
			break;
		case 'go-home':
			texpresso.stdin.write(JSON.stringify(["go-home"]) + '\n');
			break;
		case 'go-end':
			texpresso.stdin.write(JSON.stringify(["go-end"]) + '\n');
			break;
		case 'set-output-size':
			texpresso.stdin.write(JSON.stringify(["set-output-size", msg.width, msg.height]) + '\n');
			break;
		case 'reset-zoom':
			texpresso.stdin.write(JSON.stringify(["reset-zoom"]) + '\n');
			break;
		case 'set-fit-mode':
			texpresso.stdin.write(JSON.stringify(["set-fit-mode", msg.mode]) + '\n');
			break;
		case 'toggle-invert':
			texpresso.stdin.write(JSON.stringify(["invert"]) + '\n');
			break;
	}
}

export function activate(context: vscode.ExtensionContext) {
	if (texpresso) { texpresso.kill(); }

	const outputChannel = vscode.window.createOutputChannel('TeXpresso', { log: true });
	const debugChannel = vscode.window.createOutputChannel('TeXpresso Debug', { log: true });
	let providedOutput = "";
	let outputChanged = true;

	function sendCommand(command: any[]) {
		if (texpresso && texpresso.stdin) {
			const commandJson = JSON.stringify(command);
			texpresso.stdin.write(commandJson + '\n');
			debugChannel.appendLine(`Sent command: ${commandJson}`);
		}
	}

	const useWSL = vscode.workspace.getConfiguration('texpresso').get('useWSL') as boolean;
	const useChangeRangeMode = vscode.workspace.getConfiguration('texpresso').get('useChangeRangeMode') as boolean;
	let activeEditor: vscode.TextEditor | undefined;

	async function startDocumentFromEditor(
		editor: vscode.TextEditor | undefined,
		mode: 'builtin' | 'external' = 'external'
	) {
		if (texpresso) { texpresso.kill(); }
		if (!editor) return;

		activeEditor = editor;
		filePath = activeEditor.document.fileName;
		documentDir = path.dirname(filePath);
		registry = new FileRegistry(documentDir, useWSL);
		const text = activeEditor.document.getText();

		if (!text.includes('\\begin{document}')) {
			const result = await vscode.window.showWarningMessage(
				'The current document doesn\'t appear to be a main LaTeX document as it doesn\'t contain \\begin{document}. TeXpresso should typically be started from the main document. Do you want to continue anyway?',
				{ modal: true }, 'Continue', 'Cancel');
			if (result !== 'Continue') return;
		}
		if (!useChangeRangeMode) { rope = new Rope(text); }
		if (activeEditor.document.isUntitled) {
			const tmpDir = tmp.dirSync();
			filePath = tmpDir.name + '/untitled.tex';
			fs.writeFileSync(filePath, text);
			filePath = fs.realpathSync(filePath);
		}

		vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', true);
		vscode.commands.executeCommand('setContext', 'texpresso.running', true);
		const command = vscode.workspace.getConfiguration('texpresso').get('command') as string;
		try {
			if (!useWSL) { fs.accessSync(command, fs.constants.X_OK); }
			else { execSync(`wsl -e test -x ${command}`); }
		} catch (_) {
			vscode.window.showErrorMessage(
				`TeXpresso command '${command}' does not exist or is not executable.`, 'Open Settings'
			).then(v => { if (v === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'texpresso.'); });
			return;
		}

		const args = ['-json'];
		if (useChangeRangeMode) { args.push('-lines'); }
		if (mode === 'builtin') {
				args.push('-webview'); args.push('-tmpdir'); args.push('/dev/shm');
				const defRes = vscode.workspace.getConfiguration('texpresso').get('defaultResolution') as number || 2.5;
				args.push('-resolution'); args.push(String(defRes));
			}
		args.push(filePath);

		if (!useWSL) {
				const spawnEnv = { ...process.env };
			if (mode === 'external') {
				spawnEnv.SDL_VIDEODRIVER = 'wayland';
				delete spawnEnv.DISPLAY;
			}
			texpresso = spawn(command, args, { env: spawnEnv });
		} else {
			const pc = new WSLPathConverter(true);
			filePath = pc.toWSL(filePath);
			const wslArgs = ['-e', command, ...args.slice(0, -1), filePath];
			texpresso = spawn('wsl', wslArgs);
		}
		texpressoProcesses.set(filePath, texpresso);
		if (mode === 'external') {
			vscode.commands.executeCommand('setContext', 'texpresso.externalActive', true);
		}
		vscode.commands.executeCommand('setContext', 'texpresso.previewActiveForCurrentFile', true);

		if (mode === 'builtin') {
			const docName = path.basename(filePath);
			const panel = new PreviewPanel(context.extensionUri, docName);
			panel.create();
			// Send config to webview
			const texConfig = vscode.workspace.getConfiguration('texpresso');
			const maxResCap = texConfig.get('maxResCap') as number || 10;
			const defaultResolution = texConfig.get('defaultResolution') as number || 2.5;
			const scrollSpeed = texConfig.get('scrollSpeed') as number ?? 0.3;
			const defaultTrimFactor = texConfig.get('defaultTrimFactor') as number || 0;

			// Scan .tex file for % texpresso-trim: X comment
			let trimFactor = defaultTrimFactor;
			const fileText = activeEditor.document.getText();
			const trimMatch = fileText.match(/%\s*texpresso-trim:\s*([\d.]+)/);
			if (trimMatch) {
				const commentVal = parseFloat(trimMatch[1]);
				if (!isNaN(commentVal) && commentVal >= 0 && commentVal < 0.5) {
					trimFactor = commentVal;
				}
			}

			panel.postMessage({ type: 'config', maxResCap, defaultResolution, scrollSpeed, trimFactor });
			panel.onMessage(handleWebviewMessage);
			panel.onDispose(() => {
				previewPanels.delete(filePath);
				vscode.commands.executeCommand('setContext', 'texpresso.previewActiveForCurrentFile', false);
				if (texpresso) { texpresso.kill(); texpressoProcesses.delete(filePath); }
			});
			previewPanels.set(filePath, panel);
		}

		if (texpresso && texpresso.stdout) {
			outputChannel.append(`Starting TeXpresso with command: ${command} ${args.join(' ')}\n`);
			outputChannel.append(`File: ${filePath}\n`);

			let stdoutBuffer = '';
			texpresso.stdout.on('data', data => {
				stdoutBuffer += data.toString();
				const lines = stdoutBuffer.split('\n');
				stdoutBuffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.trim()) continue;
					let message: any[];
					try { message = JSON.parse(line); }
					catch (_) { debugChannel.appendLine('Failed to parse: ' + line); continue; }
				if (message[0] === 'dark-mode') {
					const panel = previewPanels.get(filePath);
					if (panel) panel.postMessage({ type: 'dark-mode', dark: message[1] });
				}
				else if (message[0] === 'page-diff') {
					const [, page, totalPages, width, height, pw, ph, nRects] = message;
					const rects = message[8]; // array of [x, y, w, h, path]
					const panel = previewPanels.get(filePath);
					if (panel) {
						if (pw > 0 && ph > 0) panel.setPageDimensions(pw, ph);
						panel.updatePageDiff(page, totalPages, rects, width, height, pw, ph);
					}
				}
				else if (message[0] === 'page-error') {
					const totalPages = message[1];
					const panel = previewPanels.get(filePath);
					if (panel) panel.postMessage({ type: 'page-error', totalPages: totalPages });
				}
				else if (message[0] === 'page') {
					const [, page, totalPages, qoiPath, width, height] = message;
					const pw = message.length > 6 ? message[6] : 0;
					const ph = message.length > 7 ? message[7] : 0;
					const panel = previewPanels.get(filePath);
					if (panel) {
						if (pw > 0 && ph > 0) panel.setPageDimensions(pw, ph);
						panel.updatePage(page, totalPages, qoiPath, width, height);
					}
				}
				else if (message[0] === 'zoom-reset') {
					const panel = previewPanels.get(filePath);
					if (panel) panel.postMessage({ type: 'zoom-reset' });
				}
				else if (message[0] === 'fit-mode-changed') {
					const panel = previewPanels.get(filePath);
					if (panel) panel.postMessage({ type: 'fit-mode-changed', mode: message[1] });
				}
				else if (message[0] === 'input-file') {
					const [, i, rp] = message;
					registry.addFile(i, rp, sendCommand);
					const sa = path.resolve(documentDir, rp);
					try { subToMainMap.set(fs.realpathSync(sa), filePath); } catch (_) {}
					updateSubFileContext();
					debugChannel.appendLine(`Tracked file ${i}: ${rp}`);
				}
				else if (message[0] === 'synctex-scroll') {
						const panel = previewPanels.get(filePath);
						if (panel) {
							const payload: any = { type: 'synctex-scroll', x: message[1], y: message[2] };
							if (message.length > 3) payload.page = message[3];
							if (message.length > 7) {
								payload.bbox = {
									x0: message[4], y0: message[5],
									x1: message[6], y1: message[7],
								};
							}
							panel.postMessage(payload);
						}
					}
					else if (message[0] === 'word-bbox') {
						const panel = previewPanels.get(filePath);
						if (panel) {
							panel.postMessage({
								type: 'word-bbox',
								page: message[1],
								x0: message[2], y0: message[3],
								x1: message[4], y1: message[5],
							});
						}
					}
					else if (message[0] === 'synctex') {
					const [, fp, line, column] = message;
					const pc = new WSLPathConverter(useWSL);
					let ap = path.isAbsolute(fp) ? fp : path.resolve(documentDir, fp);
					ap = pc.toWindows(ap);
					vscode.workspace.openTextDocument(vscode.Uri.file(ap)).then(doc => {
						return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true }).then(editor => {
							const pos = new vscode.Position(line - 1, Math.max(0, (column || 1) - 1));
							editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
							editor.selection = new vscode.Selection(pos, pos);
						});
					}, () => {
						if (activeEditor && fp === activeEditor.document.fileName) {
							const pos = new vscode.Position(line - 1, 0);
							activeEditor.revealRange(new vscode.Range(pos, pos));
						}
					});
				}
				else if (message[0] === 'append-lines') {
					const ch = message[1]; const lines = message.slice(2);
					const nc = lines.join('\n') + '\n';
					if (ch === 'out') { providedOutput += nc; outputChanged = true; }
					else if (ch === 'log') { debugChannel.append(nc); }
				}
				else if (message[0] === 'truncate-lines') {
					const ch = message[1]; const ltk = message[2];
					if (ch === 'out') {
						const ls = providedOutput.split('\n');
						providedOutput = ls.slice(-ltk).join('\n') + (ltk > 0 ? '\n' : '');
						outputChanged = true;
					} else if (ch === 'log') { debugChannel.clear(); }
				}
				else if (message[0] === 'append') {
					const ch = message[1]; const content = message[3];
					if (ch === 'out') { providedOutput += content; outputChanged = true; }
					else if (ch === 'log') { debugChannel.append(content); }
				}
				else if (message[0] === 'truncate') {
					const ch = message[1]; const btk = message[2];
					if (ch === 'out') { providedOutput = providedOutput.slice(-btk); outputChanged = true; }
					else if (ch === 'log') { debugChannel.clear(); }
				}
				else if (message[0] === 'flush') {
					if (outputChanged) { outputChanged = false; outputChannel.replace(providedOutput); }
				}
				else {
					debugChannel.append(`Received unhandled message: ${JSON.stringify(message)}`);
				}
				}
			});
		}
		if (texpresso && texpresso.stderr) {
			texpresso.stderr.on('data', data => { debugChannel.append(data.toString()); });
		}
		if (texpresso) {
			texpresso.on('close', code => {
				if (code !== 0 && code !== null) {
					vscode.window.showErrorMessage(`TeXpresso exited with code ${code}`);
				}
				previewPanels.delete(filePath);
				vscode.commands.executeCommand('setContext', 'texpresso.externalActive', false);
				texpressoProcesses.delete(filePath);
				activeEditor = undefined;
				vscode.commands.executeCommand('setContext', 'texpresso.running', false);
				vscode.commands.executeCommand('setContext', 'texpresso.previewActiveForCurrentFile', false);
				outputChannel.clear(); debugChannel.clear();
			});
		}
		sendCommand(["open", filePath, activeEditor.document.getText()]);
		if (vscode.workspace.getConfiguration('texpresso').get('useEditorTheme') as boolean) {
			adoptTheme();
		}
	}

	// --- Command registrations ---
	context.subscriptions.push(vscode.commands.registerCommand('texpresso.startDocument', async () => {
		await startDocumentFromEditor(vscode.window.activeTextEditor, 'external');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.startBuiltinPreview', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const curPath = fs.realpathSync(editor.document.uri.fsPath);
			if (editor.document.getText().includes('\\begin{document}')) {
				await startDocumentFromEditor(editor, 'builtin');
			} else {
				const mainPath = subToMainMap.get(curPath);
				if (!mainPath) {
					vscode.window.showErrorMessage('No main LaTeX file found. Open the main .tex file directly.');
					return;
				}
				const mainDoc = await vscode.workspace.openTextDocument(mainPath);
				const mainEditor = await vscode.window.showTextDocument(mainDoc, vscode.ViewColumn.One);
				await startDocumentFromEditor(mainEditor, 'builtin');
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand('texpresso.startExternalPreview', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			await startDocumentFromEditor(editor, 'external');
		}));

		context.subscriptions.push(vscode.commands.registerCommand('texpresso.stopExternalPreview', () => {
			if (texpresso) { texpresso.kill(); }
			vscode.commands.executeCommand('setContext', 'texpresso.externalActive', false);
			vscode.commands.executeCommand('setContext', 'texpresso.previewActiveForCurrentFile', false);
		}));

		context.subscriptions.push(vscode.commands.registerCommand('texpresso.stopPreview', () => {
		if (filePath) {
			const panel = previewPanels.get(filePath);
			if (panel) { panel.dispose(); previewPanels.delete(filePath); }
			vscode.commands.executeCommand('setContext', 'texpresso.previewActiveForCurrentFile', false);
		}
	}));

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => {
			if (registry) registry.updateDocument(doc.uri.fsPath, doc, true, sendCommand);
		}));

	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => {
			if (registry) registry.updateDocument(doc.uri.fsPath, undefined, false, sendCommand);
			// Close preview if all related tex files are closed
			try {
				const closedPath = fs.realpathSync(doc.uri.fsPath);
				for (const [mainPath, panel] of previewPanels) {
					if (mainPath === closedPath || subToMainMap.get(closedPath) === mainPath) {
						const anyOpen = vscode.workspace.textDocuments.some(d => {
							try {
								const fp = fs.realpathSync(d.uri.fsPath);
								return fp === mainPath || subToMainMap.get(fp) === mainPath;
							} catch (_) { return false; }
						});
						if (!anyOpen) {
							panel.dispose();
							previewPanels.delete(mainPath);
							const proc = texpressoProcesses.get(mainPath);
							if (proc) { proc.kill(); texpressoProcesses.delete(mainPath); }
							vscode.commands.executeCommand('setContext', 'texpresso.previewActiveForCurrentFile', false);
							vscode.commands.executeCommand('setContext', 'texpresso.externalActive', false);
						}
					}
				}
			} catch (_) {}
		}));

	vscode.workspace.onDidChangeTextDocument(event => {
		const trackedFile = registry?.findByPath(event.document.uri.fsPath);
		if (activeEditor && event.document === activeEditor.document) {
			texpresso?.stdin?.cork();
			for (const change of event.contentChanges) {
				if (useChangeRangeMode) {
					const message = ["change-range", filePath, change.range.start.line, change.range.start.character, change.range.end.line, change.range.end.character, change.text];
					sendCommand(message);
				} else {
					const start = rope.byteOffset(change.rangeOffset);
					const end = rope.byteOffset(change.rangeOffset + change.rangeLength);
					sendCommand(["change", filePath, start, end - start, change.text]);
					rope.remove(change.rangeOffset, change.rangeOffset + change.rangeLength);
					rope.insert(change.rangeOffset, change.text);
				}
			}
			texpresso?.stdin?.uncork();
		} else if (trackedFile && trackedFile.isOpen) {
			texpresso?.stdin?.cork();
			for (const change of event.contentChanges) {
				if (useChangeRangeMode) {
					sendCommand(["change-range", trackedFile.absolutePath, change.range.start.line, change.range.start.character, change.range.end.line, change.range.end.character, change.text]);
				} else {
					if (!trackedFile.rope) trackedFile.rope = new Rope(event.document.getText());
					const start = trackedFile.rope.byteOffset(change.rangeOffset);
					const end = trackedFile.rope.byteOffset(change.rangeOffset + change.rangeLength);
					sendCommand(["change", trackedFile.absolutePath, start, end - start, change.text]);
					trackedFile.rope.remove(change.rangeOffset, change.rangeOffset + change.rangeLength);
					trackedFile.rope.insert(change.rangeOffset, change.text);
				}
			}
			texpresso?.stdin?.uncork();
		}
	}, null, context.subscriptions);

	function updateInActiveEditorContext(editor: vscode.TextEditor | undefined) {
		const isTexFile = !!(editor && editor.document.fileName.endsWith('.tex'));
		vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', isTexFile);
	}
	updateInActiveEditorContext(vscode.window.activeTextEditor);
	vscode.window.onDidChangeActiveTextEditor(editor => {
		updateInActiveEditorContext(editor);
		updateSubFileContext();
	});

	// --- SyncTeX ---
	let previouslySentLineNumber: number | undefined;
	function doSyncTeXForward(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor) {
		if (!editor) return;
		const trackedFile = registry?.findByPath(editor.document.uri.fsPath);
		// VSCode uses 0-based line numbers; synctex expects 1-based
		const lineNumber = editor.selection.active.line + 1;
		if (editor.document === activeEditor?.document) {
			if (!previouslySentLineNumber || previouslySentLineNumber !== lineNumber) {
				previouslySentLineNumber = lineNumber;
				sendCommand(["synctex-forward", filePath, lineNumber]);
			}
		} else if (trackedFile) {
			sendCommand(["open", trackedFile.absolutePath, editor.document.getText()]);
			sendCommand(["synctex-forward", trackedFile.absolutePath, lineNumber]);
		}
	}

	vscode.window.onDidChangeTextEditorSelection(event => {
		if (vscode.workspace.getConfiguration('texpresso').get('syncTeXForwardOnSelection') as boolean) {
			const isMain = activeEditor && event.textEditor.document === activeEditor.document;
			const isTracked = registry?.findByPath(event.textEditor.document.uri.fsPath);
			if (isMain || isTracked) doSyncTeXForward(event.textEditor);
		}
	});

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.syncTeXForward', () => doSyncTeXForward()));
	context.subscriptions.push(vscode.commands.registerCommand('texpresso.syncTeXForwardShortName', () => doSyncTeXForward()));
	context.subscriptions.push(vscode.commands.registerCommand('texpresso.activateSyncTeXForward', () => {
		vscode.workspace.getConfiguration('texpresso').update('syncTeXForwardOnSelection', true, true);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('texpresso.deactivateSyncTeXForward', () => {
		vscode.workspace.getConfiguration('texpresso').update('syncTeXForwardOnSelection', false, true);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('texpresso.nextPage', () => { sendCommand(["next-page"]); }));
	context.subscriptions.push(vscode.commands.registerCommand('texpresso.previousPage', () => { sendCommand(["previous-page"]); }));

	// --- Theme ---
	function adoptTheme() {
		if (!texpresso || !activeEditor) return;
		const wp = vscode.window.createWebviewPanel('texpresso.colorTheme', 'Color Theme',
			{ preserveFocus: true, viewColumn: vscode.ViewColumn.Beside }, { enableScripts: true });
		wp.webview.html = `<!DOCTYPE html><html><script>
			const vscode = acquireVsCodeApi();
			vscode.postMessage(Object.values(document.getElementsByTagName('html')[0].style).map(
			(rv) => { return { [rv]: document.getElementsByTagName('html')[0].style.getPropertyValue(rv) }; }));
		</script></html>`;
		wp.webview.onDidReceiveMessage((cssVars) => {
			wp.dispose();
			const colors = {} as { [key: string]: number[] };
			for (const cv of cssVars) {
				const key = Object.keys(cv)[0]; const value = cv[key];
				if (key === '--vscode-editor-background' || key === '--vscode-editor-foreground') {
					const rgb = value.match(/#(..)(..)(..)/);
					if (rgb) colors[key] = [parseInt(rgb[1], 16) / 255, parseInt(rgb[2], 16) / 255, parseInt(rgb[3], 16) / 255];
				}
			}
			sendCommand(["theme", colors['--vscode-editor-background'], colors['--vscode-editor-foreground']]);
		});
	}

	vscode.window.onDidChangeActiveColorTheme(() => {
		if (vscode.workspace.getConfiguration('texpresso').get('useEditorTheme') as boolean) adoptTheme();
	});
	context.subscriptions.push(vscode.commands.registerCommand('texpresso.adoptTheme', () => adoptTheme()));
	context.subscriptions.push(vscode.commands.registerCommand('texpresso.defaultTheme', () => {
		sendCommand(["theme", [1, 1, 1], [0, 0, 0]]);
	}));

	// --- Refresh, Compile, Stop ---
	context.subscriptions.push(vscode.commands.registerCommand('texpresso.refresh', () => {
		if (activeEditor) {
			const text = activeEditor.document.getText();
			if (!useChangeRangeMode) rope = new Rope(text);
			sendCommand(["open", filePath, text]);
			sendCommand(["rescan"]);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.externalCompileAndRefresh', async () => {
		if (!activeEditor) { vscode.window.showErrorMessage('TeXpresso: No active editor'); return; }
		if (activeEditor.document.isDirty) await activeEditor.document.save();
		const ec = vscode.workspace.getConfiguration('texpresso').get('externalCompileCommand') as string;
		const sb = vscode.window.setStatusBarMessage(`TeXpresso: Running ${ec}...`);
		try {
			const { exec } = require('child_process');
			const pc = new WSLPathConverter(useWSL);
			const wd = path.dirname(filePath);
			outputChannel.appendLine(`\n--- External Compilation ---`);
			let cmd: string; let opts: any = {};
			if (!useWSL) {
				cmd = `${ec} "${filePath}"`; opts.cwd = wd;
			} else {
				const wslWd = pc.toWSL(wd); const wslFp = pc.toWSL(filePath);
				cmd = `wsl -e sh -c "cd \\"${wslWd}\\" && ${ec} \\"${wslFp}\\""`;
			}
			outputChannel.show(true);
			await new Promise<void>((resolve, reject) => {
				const cp = exec(cmd, opts);
				cp.stdout.on('data', (d: Buffer) => outputChannel.append(d.toString()));
				cp.stderr.on('data', (d: Buffer) => outputChannel.append(d.toString()));
				cp.on('close', (code: number) => { if (code === 0) resolve(); else reject(new Error(`Exit code ${code}`)); });
				cp.on('error', (e: Error) => reject(e));
			});
			vscode.commands.executeCommand('texpresso.refresh');
		} catch (e) { vscode.window.showErrorMessage(`TeXpresso: External compilation failed: ${e}`); }
		finally { sb.dispose(); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.stop', () => {
		if (texpresso) texpresso.kill();
		for (const [_k, proc] of texpressoProcesses) proc.kill();
		texpressoProcesses.clear(); previewPanels.clear();
		activeEditor = undefined; registry?.clear();
		vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', false);
		vscode.commands.executeCommand('setContext', 'texpresso.running', false);
		vscode.commands.executeCommand('setContext', 'texpresso.hasMainFile', false);
		vscode.commands.executeCommand('setContext', 'texpresso.previewActiveForCurrentFile', false);
		outputChannel.clear(); debugChannel.clear();
	}));
}

export function deactivate() {
	if (texpresso) texpresso.kill();
	for (const [_k, proc] of texpressoProcesses) proc.kill();
	texpressoProcesses.clear(); previewPanels.clear();
}
