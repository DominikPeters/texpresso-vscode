import * as vscode from 'vscode';
import { ChildProcess, spawn, execSync } from 'child_process';
import * as tmp from 'tmp';
import * as fs from 'fs';
import * as path from 'path';
import { windowsToWslSync, wslToWindowsSync } from 'wsl-path';

import Rope from './rope';

tmp.setGracefulCleanup();

class WSLPathConverter {
	private enabled: boolean;

	constructor(useWSL: boolean) {
		this.enabled = useWSL;
	}

	toWindows(wslPath: string): string {
		if (!this.enabled) {
			return wslPath;
		}
		try {
			return wslToWindowsSync(wslPath);
		} catch (error) {
			return wslPath;
		}
	}

	toWSL(windowsPath: string): string {
		if (!this.enabled) {
			return windowsPath;
		}
		try {
			return windowsToWslSync(windowsPath);
		} catch (error) {
			return windowsPath;
		}
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
		const isOpen = vscode.workspace.textDocuments.some(doc =>
			doc.uri.fsPath === absolutePath);
		const document = isOpen ? vscode.workspace.textDocuments.find(doc =>
			doc.uri.fsPath === absolutePath) : undefined;

		const file: TrackedFile = {
			index, relativePath, absolutePath, isOpen, document,
			rope: undefined
		};

		this.files.set(index, file);
		this.pathToIndex.set(absolutePath, index);

		if (document && isOpen) {
			const message = ["open", absolutePath, document.getText()];
			sendCommand(message);
		}
	}

	findByIndex(index: number): TrackedFile | undefined {
		return this.files.get(index);
	}

	findByPath(absolutePath: string): TrackedFile | undefined {
		// Try direct lookup first
		let index = this.pathToIndex.get(absolutePath);

		// If not found, try with path conversion (handles WSL/Windows path mismatches)
		if (index === undefined) {
			const convertedPath = this.pathConverter.toWindows(absolutePath);
			index = this.pathToIndex.get(convertedPath);

			// Also try the reverse conversion
			if (index === undefined) {
				const wslPath = this.pathConverter.toWSL(absolutePath);
				const reconvertedPath = this.pathConverter.toWindows(wslPath);
				index = this.pathToIndex.get(reconvertedPath);
			}
		}

		return index !== undefined ? this.files.get(index) : undefined;
	}

	private resolvePath(relativePath: string): string {
		const resolved = relativePath.startsWith('/') ?
			relativePath :
			path.resolve(this.documentDir, relativePath);

		// Always return Windows paths for VSCode compatibility
		return this.pathConverter.toWindows(resolved);
	}

	updateDocument(absolutePath: string, document: vscode.TextDocument | undefined, isOpen: boolean, sendCommand: (cmd: any[]) => void) {
		const file = this.findByPath(absolutePath);
		if (file) {
			const wasOpen = file.isOpen;
			file.isOpen = isOpen;
			file.document = document;

			if (isOpen && !wasOpen && document) {
				const message = ["open", file.absolutePath, document.getText()];
				sendCommand(message);
			}
		}
	}

	clear() {
		this.files.clear();
		this.pathToIndex.clear();
	}
}

let texpresso: ChildProcess;
let rope: Rope;
let filePath: string;
let documentDir: string;
let registry: FileRegistry;
let previewPanel: vscode.WebviewPanel | undefined;
let stdoutBuffer: string = '';

function getPreviewHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body {
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	background: var(--vscode-editor-background, #1e1e1e);
	color: var(--vscode-editor-foreground, #d4d4d4);
	font-family: var(--vscode-font-family);
	height: 100vh;
	overflow: auto;
}
#toolbar {
	display: flex;
	gap: 8px;
	padding: 4px 8px;
	width: 100%;
	box-sizing: border-box;
	background: var(--vscode-titleBar-activeBackground, #333);
	font-size: 12px;
	flex-shrink: 0;
}
#toolbar button {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none;
	padding: 2px 8px;
	cursor: pointer;
	font-size: 12px;
}
#toolbar button:hover {
	background: var(--vscode-button-hoverBackground);
}
#container {
	flex: 1;
	display: flex;
	overflow: auto;
	width: 100%;
	height: 100%;
}
canvas#preview {
	display: block;
		margin: auto;
	image-rendering: auto;
}
#status {
	font-size: 11px;
	opacity: 0.7;
}
</style>
</head>
<body>
	<div id="toolbar">
		<button id="prevBtn">前一页</button>
		<span id="status">Page 1 / ?</span>
		<button id="nextBtn">后一页</button>
		<button id="refreshBtn" title="刷新">刷新</button>
		<button id="zoomResetBtn" title="重置缩放">重置缩放</button>
		<button id="darkBtn" title="深色模式">深色</button>
	</div>
<div id="container">
	<canvas id="preview"></canvas>
</div>
<script>
const vscode = acquireVsCodeApi();
let currentPage = 0;
let pageCount = 0;
let renderWidth = 0;
let renderHeight = 0;

// QOI decoder: Uint8Array -> RGBA Uint8ClampedArray
function qoiDecode(data, desc) {
	const QOI_OP_INDEX = 0x00, QOI_OP_DIFF = 0x40, QOI_OP_LUMA = 0x80,
	      QOI_OP_RUN = 0xc0, QOI_OP_RGB = 0xfe, QOI_OP_RGBA = 0xff;
	const QOI_MASK_2 = 0xc0;

	let p = 0;
	function read32() {
		const v = new DataView(data.buffer, data.byteOffset + p, 4).getUint32(0, false);
		p += 4; return v;
	}

	const magic = read32();
	if (magic !== 0x716f6966) return null; // 'qoif'
	desc.width = read32();
	desc.height = read32();
	desc.channels = data[p++];
	desc.colorspace = data[p++];

	if (desc.width === 0 || desc.height === 0 || desc.channels < 3 || desc.channels > 4)
		return null;

	const px_len = desc.width * desc.height * 4;
	const pixels = new Uint8ClampedArray(px_len);
	const index = new Array(64);

	let px = { r: 0, g: 0, b: 0, a: 255 };
	const chunks_len = data.length - 8;
	let run = 0;

	function hash(px) { return (px.r * 3 + px.g * 5 + px.b * 7 + px.a * 11) & 63; }
	function setIndex(px) { index[hash(px)] = { r: px.r, g: px.g, b: px.b, a: px.a }; }

	for (let px_pos = 0; px_pos < px_len; px_pos += 4) {
		if (run > 0) {
			run--;
		} else if (p < chunks_len) {
			const b1 = data[p++];

			if (b1 === QOI_OP_RGB) {
				px.r = data[p++]; px.g = data[p++]; px.b = data[p++];
			} else if (b1 === QOI_OP_RGBA) {
				px.r = data[p++]; px.g = data[p++]; px.b = data[p++]; px.a = data[p++];
			} else if ((b1 & QOI_MASK_2) === QOI_OP_INDEX) {
				const idx = index[b1 & 0x3f];
				if (idx) { px.r = idx.r; px.g = idx.g; px.b = idx.b; px.a = idx.a; }
			} else if ((b1 & QOI_MASK_2) === QOI_OP_DIFF) {
				px.r = (px.r + ((b1 >> 4) & 0x03) - 2) & 0xFF;
				px.g = (px.g + ((b1 >> 2) & 0x03) - 2) & 0xFF;
				px.b = (px.b + ( b1       & 0x03) - 2) & 0xFF;
			} else if ((b1 & QOI_MASK_2) === QOI_OP_LUMA) {
				const b2 = data[p++];
				const vg = (b1 & 0x3f) - 32;
				px.r = (px.r + vg - 8 + ((b2 >> 4) & 0x0f)) & 0xFF;
				px.g = (px.g + vg) & 0xFF;
				px.b = (px.b + vg - 8 + ( b2       & 0x0f)) & 0xFF;
			} else if ((b1 & QOI_MASK_2) === QOI_OP_RUN) {
				run = (b1 & 0x3f);
			}
			setIndex(px);
		}

		pixels[px_pos + 0] = px.r;
		pixels[px_pos + 1] = px.g;
		pixels[px_pos + 2] = px.b;
		pixels[px_pos + 3] = px.a;
	}

	return pixels;
}

// Toolbar buttons
document.getElementById('prevBtn').addEventListener('click', () => {
	vscode.postMessage({ command: 'previous-page' });
});
document.getElementById('nextBtn').addEventListener('click', () => {
	vscode.postMessage({ command: 'next-page' });
});

		// Zoom reset button
		document.getElementById('zoomResetBtn').addEventListener('click', () => {
			zoomLevel = 1.0;
			fitCanvas();
				var rw = Math.round(baseWidth * Math.pow(zoomLevel, 0.5));
				if (rw !== lastSentWidth) { lastSentWidth = rw; vscode.postMessage({ command: "render-size", width: rw }); }
		});

		// Refresh button
		document.getElementById('refreshBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'refresh' });
		});

		// Dark mode toggle
		let darkMode = false;
		document.getElementById('darkBtn').addEventListener('click', () => {
			darkMode = !darkMode;
			var c = document.getElementById('preview');
			c.style.filter = darkMode ? 'invert(1) hue-rotate(180deg)' : '';
			document.getElementById('darkBtn').textContent = darkMode ? '浅色' : '深色';
		});

		// Keyboard: ← → for page navigation
		window.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowLeft') { e.preventDefault(); vscode.postMessage({ command: 'previous-page' }); }
			else if (e.key === 'ArrowRight') { e.preventDefault(); vscode.postMessage({ command: 'next-page' }); }
		});

		// Ctrl+wheel: zoom (finer steps)
		window.addEventListener('wheel', (e) => {
			if (e.ctrlKey) {
				e.preventDefault();
				zoomLevel *= e.deltaY < 0 ? 1.025 : 1 / 1.025;
				zoomLevel = Math.max(0.2, Math.min(5.0, zoomLevel));
				var rw = Math.round(baseWidth * Math.pow(zoomLevel, 0.5));
				if (rw !== lastSentWidth) { lastSentWidth = rw; vscode.postMessage({ command: "render-size", width: rw }); }
				fitCanvas();
			}
		}, { passive: false });

		// Ctrl+left-drag: pan page
		let panning = false, panX = 0, panY = 0;
		document.addEventListener('mousedown', (e) => {
			if (e.ctrlKey && e.button === 0) {
				e.preventDefault();
				panning = true; panX = e.clientX; panY = e.clientY;
			}
		});
		document.addEventListener('mousemove', (e) => {
			if (panning) {
				var ct = document.getElementById('container');
				ct.scrollLeft += panX - e.clientX;
				ct.scrollTop  += panY - e.clientY;
				panX = e.clientX; panY = e.clientY;
			}
		});
		document.addEventListener('mouseup', () => { panning = false; });

// SyncTeX backward: click on canvas to jump to source
	document.getElementById('preview').addEventListener('click', (e) => {
		const canvas = e.target;
		const rect = canvas.getBoundingClientRect();
		if (!canvas.width || !rect.width) return;
		const scaleX = canvas.width / rect.width;
		const scaleY = canvas.height / rect.height;
		const x = (e.clientX - rect.left) * scaleX;
		const y = (e.clientY - rect.top) * scaleY;
		console.log("synctex-backward page=" + currentPage + " x=" + Math.round(x) + " y=" + Math.round(y) + " canvasW=" + canvas.width + " canvasH=" + canvas.height + " rectW=" + Math.round(rect.width) + " rectH=" + Math.round(rect.height));
			vscode.postMessage({ command: "synctex-backward", page: currentPage, x: Math.round(x), y: Math.round(y) });
	});

		// Report viewport size (only sends if width changed to avoid flooding)
		let baseWidth = 0;
		let lastSentWidth = 0;
		let zoomLevel = 1.0;
		function reportSize() {
			const dpr = window.devicePixelRatio || 1;
			const container = document.getElementById("container");
			const w = (container && container.clientWidth > 0) ? container.clientWidth : document.body.clientWidth;
			if (w > 0) {
				baseWidth = Math.round(w * dpr * 2.5);
				const rw = Math.round(baseWidth * Math.pow(zoomLevel, 0.5));
				if (rw !== lastSentWidth) {
					lastSentWidth = rw;
					vscode.postMessage({ command: "render-size", width: rw });
				}
			}
		}
		reportSize();
		window.addEventListener("resize", () => { setTimeout(reportSize, 50); fitCanvas(); });
		setTimeout(reportSize, 200);
		setTimeout(reportSize, 500);
window.addEventListener('message', event => {
	const msg = event.data;
	if (msg.type === 'page-rendered') {
		const canvas = document.getElementById('preview');
		const qoiData = msg.data; // Uint8Array
		if (!qoiData || qoiData.length === 0) return;

		const desc = {};
		const pixels = qoiDecode(qoiData, desc);
		if (!pixels) return;

			canvas.width = 0;
			canvas.height = 0;
			canvas.width = desc.width;
			canvas.height = desc.height;
			const ctx = canvas.getContext('2d');
			ctx.globalCompositeOperation = 'copy';
			const imageData = ctx.createImageData(desc.width, desc.height);
			imageData.data.set(pixels);
			ctx.putImageData(imageData, 0, 0);
			ctx.globalCompositeOperation = 'source-over';

		currentPage = msg.page;
		renderWidth = desc.width;
		renderHeight = desc.height;
			fitCanvas();
		updateStatus();
	} else if (msg.type === 'page-count') {
		pageCount = msg.count;
		updateStatus();
	}
});

		function fitCanvas() {
			var c = document.getElementById("preview");
			if (!c.width || !c.height) return;
			var r = document.getElementById("container").getBoundingClientRect();
			var cw = r.width, ch = r.height;
			if (cw <= 0 || ch <= 0) { cw = window.innerWidth; ch = window.innerHeight - 30; }
			if (cw <= 0 || ch <= 0) return;
			var s = Math.min(cw / c.width, ch / c.height) * zoomLevel;
			c.style.width = Math.round(c.width * s) + "px";
			c.style.height = Math.round(c.height * s) + "px";
		}

function updateStatus() {
	document.getElementById('status').textContent =
		'Page ' + (currentPage + 1) + ' / ' + pageCount +
		' | ' + renderWidth + '×' + renderHeight;
}
</script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext) {

	if (texpresso) {
		texpresso.kill();
	}

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

	async function startDocumentFromEditor(editor: vscode.TextEditor | undefined, useInline: boolean) {
		if (texpresso) {
			texpresso.kill();
		}

		if (editor) {
			activeEditor = editor;
			filePath = activeEditor.document.fileName;
			documentDir = path.dirname(filePath);
			registry = new FileRegistry(documentDir, useWSL);
			const text = activeEditor.document.getText();

			// Check if document contains \begin{document} to determine if it's likely a main document
			if (!text.includes('\\begin{document}')) {
				const result = await vscode.window.showWarningMessage(
					'The current document doesn\'t appear to be a main LaTeX document as it doesn\'t contain \\begin{document}. TeXpresso should typically be started from the main document. Do you want to continue anyway?',
					{ modal: true },
					'Continue',
					'Cancel'
				);

				if (result !== 'Continue') {
					return; // Exit without starting TeXpresso
				}
			}
			if (!useChangeRangeMode) {
				rope = new Rope(text);
			}
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
			const args = ['-json'];
			if (useChangeRangeMode) {
				args.push('-lines');
			}
			if (useInline) {
				args.push('-headless');
					args.push('-stream');
			}
			args.push(filePath);

			if (!useWSL) {
				texpresso = spawn(command, args);
			} else {
				const pathConverter = new WSLPathConverter(true);
				filePath = pathConverter.toWSL(filePath);
				const wslArgs = ['-e', command, ...args.slice(0, -1), filePath]; // replace original filePath with WSL path
				texpresso = spawn('wsl', wslArgs);
			}
			if (texpresso && texpresso.stdout) {
				outputChannel.append(`Starting TeXpresso with command: ${command} ${args.join(' ')}\n`);
				outputChannel.append(`Options: ${useChangeRangeMode ? 'Using change-range mode' : 'Using byte-based changes'}${useInline ? ', inline preview' : ''}\n`);
				outputChannel.append(`File: ${filePath}\n`);

				// Create inline preview panel if enabled
				if (useInline && !previewPanel) {
					previewPanel = vscode.window.createWebviewPanel(
						'texpressoPreview',
						path.basename(filePath),
						vscode.ViewColumn.Beside,
						{ enableScripts: true, retainContextWhenHidden: true }
					);
					previewPanel.webview.html = getPreviewHtml();
						previewPanel.onDidDispose(() => {
							previewPanel = undefined;
							if (texpresso) {
								texpresso.kill();
							}
							activeEditor = undefined;
							registry?.clear();
							vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', false);
							vscode.commands.executeCommand('setContext', 'texpresso.running', false);
						});
					// Handle messages from WebView (page navigation + synctex backward)
					previewPanel.webview.onDidReceiveMessage(msg => {
						if (msg.command === 'previous-page') {
							sendCommand(['previous-page']);
						} else if (msg.command === 'next-page') {
							sendCommand(['next-page']);
						} else if (msg.command === 'synctex-backward') {
							sendCommand(['synctex-backward', msg.page, msg.x, msg.y]);
						} else if (msg.command === 'render-size') {
							sendCommand(['render-size', msg.width]);
						} else if (msg.command === 'refresh') {
							if (activeEditor) {
								const text = activeEditor.document.getText();
								sendCommand(['open', filePath, text]);
								sendCommand(['rescan']);
							}
						}
					});
				}

				stdoutBuffer = '';
				texpresso.stdout.on('data', data => {
					// Robust line-delimited JSON parsing
					stdoutBuffer += data.toString();
					let newlineIdx: number;
					while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
						const line = stdoutBuffer.substring(0, newlineIdx).trim();
						stdoutBuffer = stdoutBuffer.substring(newlineIdx + 1);
						if (!line) { continue; }
						let message: any[];
						try {
							message = JSON.parse(line);
						} catch (e) {
							debugChannel.appendLine(`Failed to parse JSON: ${line}`);
							continue;
						}
						if (message[0] === 'page-rendered' && previewPanel) {
							const [, pageNum, width, height, b64data] = message;
							const qoiData = Buffer.from(b64data, 'base64');
							previewPanel.webview.postMessage({
								type: 'page-rendered',
								page: pageNum,
								width: width,
								height: height,
								data: new Uint8Array(qoiData)
							} as any);
						}
						else if (message[0] === 'page-count' && previewPanel) {
							const [, count] = message;
							previewPanel.webview.postMessage({
								type: 'page-count',
								count: count
							});
						}
						else if (message[0] === 'input-file') {
							const [, index, relativePath] = message;
							registry.addFile(index, relativePath, sendCommand);
							debugChannel.appendLine(`Tracked file ${index}: ${relativePath}`);
						}
						else if (message[0] === 'synctex') {
							const [, filePath, line, column] = message;
							const pathConverter = new WSLPathConverter(useWSL);
							let absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(documentDir, filePath);
							absolutePath = pathConverter.toWindows(absolutePath);

							const uri = vscode.Uri.file(absolutePath);
							const pos = new vscode.Position(line - 1, Math.max(0, (column || 1) - 1));
							// Try to find an existing visible editor for this file first
							const existing = vscode.window.visibleTextEditors.find(
								e => e.document.uri.fsPath === uri.fsPath
							);
							if (existing) {
								existing.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
								existing.selection = new vscode.Selection(pos, pos);
							} else {
								vscode.workspace.openTextDocument(uri).then(doc => {
									vscode.window.showTextDocument(doc, {
										viewColumn: vscode.ViewColumn.One,
										preserveFocus: false
									}).then(editor => {
										editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
										editor.selection = new vscode.Selection(pos, pos);
									});
								}, () => {
									if (activeEditor && absolutePath === activeEditor.document.uri.fsPath) {
										activeEditor.revealRange(new vscode.Range(pos, pos));
										activeEditor.selection = new vscode.Selection(pos, pos);
									}
								});
							}
						}
						else if (message[0] === 'append-lines') {
							const channel = message[1];
							const lines = message.slice(2); // All remaining elements are lines
							const newContent = lines.join('\n') + '\n';

							if (channel === 'out') {
								providedOutput += newContent;
								outputChanged = true;
							} else if (channel === 'log') {
								debugChannel.append(newContent);
							}
						}
						else if (message[0] === 'truncate-lines') {
							const channel = message[1];
							const linesToKeep = message[2];

							if (channel === 'out') {
								const lines = providedOutput.split('\n');
								providedOutput = lines.slice(-linesToKeep).join('\n') + (linesToKeep > 0 ? '\n' : '');
								outputChanged = true;
							} else if (channel === 'log') {
								// For debug channel, we'll just clear it on truncate-lines
								// since VS Code doesn't have easy line-based truncation
								debugChannel.clear();
							}
						}
						// Legacy support for old byte-based commands
						else if (message[0] === 'append') {
							const channel = message[1];
							const content = message[3];

							if (channel === 'out') {
								providedOutput += content;
								outputChanged = true;
							} else if (channel === 'log') {
								debugChannel.append(content);
							}
						}
						else if (message[0] === 'truncate') {
							const channel = message[1];
							const bytesToKeep = message[2];

							if (channel === 'out') {
								providedOutput = providedOutput.slice(-bytesToKeep);
								outputChanged = true;
							} else if (channel === 'log') {
								// For debug channel, we'll just clear it on truncate
								// since VS Code doesn't have easy byte-based truncation
								debugChannel.clear();
							}
						}
						else if (message[0] === 'flush') {
							if (outputChanged) {
								outputChanged = false;
								outputChannel.replace(providedOutput);
							}
						}
						else {
							debugChannel.append(`Received unhandled message: ${JSON.stringify(message)}`);
						}
					} // end while (line parsing loop)
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
					if (previewPanel) {
						previewPanel.dispose();
						previewPanel = undefined;
					}
				});
			}
			// Send file content to texpresso
			const message = ["open", filePath, activeEditor.document.getText()];
			sendCommand(message);
			// Send color theme to texpresso if setting is enabled
			if (vscode.workspace.getConfiguration('texpresso').get('useEditorTheme') as boolean) {
				adoptTheme();
			}
		}
	}

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.startDocument', async () => {
		await startDocumentFromEditor(vscode.window.activeTextEditor, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.startDocumentExternal', async () => {
		await startDocumentFromEditor(vscode.window.activeTextEditor, false);
	}));

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => {
			if (registry) {
				registry.updateDocument(doc.uri.fsPath, doc, true, sendCommand);
			}
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => {
			if (registry) {
				registry.updateDocument(doc.uri.fsPath, undefined, false, sendCommand);
			}
		})
	);

	vscode.workspace.onDidChangeTextDocument(event => {
		const trackedFile = registry?.findByPath(event.document.uri.fsPath);

		if (activeEditor && event.document === activeEditor.document) {
			texpresso?.stdin?.cork();
			for (const change of event.contentChanges) {
				if (useChangeRangeMode) {
					const startLine = change.range.start.line;
					const startChar = change.range.start.character;
					const endLine = change.range.end.line;
					const endChar = change.range.end.character;
					const message = ["change-range", filePath, startLine, startChar, endLine, endChar, change.text];
					sendCommand(message);
				} else {
					const start = rope.byteOffset(change.rangeOffset);
					const end = rope.byteOffset(change.rangeOffset + change.rangeLength);
					const message = ["change", filePath, start, end - start, change.text];
					sendCommand(message);
					rope.remove(change.rangeOffset, change.rangeOffset + change.rangeLength);
					rope.insert(change.rangeOffset, change.text);
				}
			}
			texpresso?.stdin?.uncork();
		}
		else if (trackedFile && trackedFile.isOpen) {
			texpresso?.stdin?.cork();
			for (const change of event.contentChanges) {
				if (useChangeRangeMode) {
					const startLine = change.range.start.line;
					const startChar = change.range.start.character;
					const endLine = change.range.end.line;
					const endChar = change.range.end.character;
					const message = ["change-range", trackedFile.absolutePath, startLine, startChar, endLine, endChar, change.text];
					sendCommand(message);
				} else {
					if (!trackedFile.rope) {
						trackedFile.rope = new Rope(event.document.getText());
					}
					const start = trackedFile.rope.byteOffset(change.rangeOffset);
					const end = trackedFile.rope.byteOffset(change.rangeOffset + change.rangeLength);
					const message = ["change", trackedFile.absolutePath, start, end - start, change.text];
					sendCommand(message);
					trackedFile.rope.remove(change.rangeOffset, change.rangeOffset + change.rangeLength);
					trackedFile.rope.insert(change.rangeOffset, change.text);
				}
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
		if (!editor) return;

		const trackedFile = registry?.findByPath(editor.document.uri.fsPath);
		const lineNumber = editor.selection.active.line;

		if (editor.document === activeEditor?.document) {
			if (!previouslySentLineNumber || previouslySentLineNumber !== lineNumber) {
				previouslySentLineNumber = lineNumber;
				const message = ["synctex-forward", filePath, lineNumber];
				sendCommand(message);
			}
		} else if (trackedFile) {
			const message = ["synctex-forward", trackedFile.absolutePath, lineNumber];
			sendCommand(message);
		}
	}

	vscode.window.onDidChangeTextEditorSelection(event => {
		if (vscode.workspace.getConfiguration('texpresso').get('syncTeXForwardOnSelection') as boolean) {
			const isMainDoc = activeEditor && event.textEditor.document === activeEditor.document;
			const isTrackedFile = registry?.findByPath(event.textEditor.document.uri.fsPath);

			if (isMainDoc || isTrackedFile) {
				doSyncTeXForward(event.textEditor);
			}
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
			sendCommand(message);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.previousPage', () => {
		if (activeEditor) {
			const message = ["previous-page"];
			sendCommand(message);
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
			sendCommand(message);
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
		const message = ["theme", [1, 1, 1], [0, 0, 0]];
		sendCommand(message);
	}));

	/***********************************
	 ***********************************
	 *****     Refresh and Stop    *****
	 ***********************************
	 **********************************/

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.refresh', () => {
		if (activeEditor) {
			const text = activeEditor.document.getText();
			if (!useChangeRangeMode) {
				rope = new Rope(text);
			}
			// resend "open" command
			const message = ["open", filePath, text];
			sendCommand(message);
			sendCommand(["rescan"]);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.externalCompileAndRefresh', async () => {
		if (!activeEditor) {
			vscode.window.showErrorMessage('TeXpresso: No active editor');
			return;
		}

		// Save the document first if it has unsaved changes
		if (activeEditor.document.isDirty) {
			await activeEditor.document.save();
		}

		// Get the configured compile command
		const externalCommand = vscode.workspace.getConfiguration('texpresso').get('externalCompileCommand') as string;

		// Show a status bar message
		const statusBar = vscode.window.setStatusBarMessage(`TeXpresso: Running ${externalCommand}...`);

		try {
			// Execute the command
			const { exec } = require('child_process');
			const path = require('path');
			const pathConverter = new WSLPathConverter(useWSL);
			const workDir = path.dirname(filePath);

			outputChannel.appendLine(`\n--- External Compilation ---`);
			outputChannel.appendLine(`Working directory: ${workDir}`);

			// Prepare the command
			let cmd: string;
			let opts: any = {};

			if (!useWSL) {
				cmd = `${externalCommand} "${filePath}"`;
				opts.cwd = workDir;
				outputChannel.appendLine(`Command: ${cmd}`);
			} else {
				const wslWorkDir = pathConverter.toWSL(workDir);
				const wslFilePath = pathConverter.toWSL(filePath);
				cmd = `cd "${wslWorkDir}" && ${externalCommand} "${wslFilePath}"`;
				outputChannel.appendLine(`WSL Command: ${cmd}`);
				cmd = `wsl -e sh -c "${cmd.replace(/"/g, '\\"')}"`;
			}

			outputChannel.show(true);

			// Execute the command
			const childProcess = exec(cmd, opts);

			await new Promise<void>((resolve, reject) => {
				childProcess.stdout.on('data', (data: Buffer) => {
					outputChannel.append(data.toString());
				});

				childProcess.stderr.on('data', (data: Buffer) => {
					outputChannel.append(data.toString());
				});

				childProcess.on('close', (code: number) => {
					if (code === 0) {
						resolve();
					} else {
						const errorMsg = `Exit code ${code}`;
						outputChannel.appendLine(`\nExternal compilation failed: ${errorMsg}`);
						reject(new Error(errorMsg));
					}
				});

				childProcess.on('error', (error: Error) => {
					outputChannel.appendLine(`\nError: ${error.message}`);
					reject(error);
				});
			});

			// Refresh TeXpresso's internal state
			vscode.commands.executeCommand('texpresso.refresh');
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`\nError: ${errorMessage}`);
			vscode.window.showErrorMessage(`TeXpresso: External compilation failed: ${errorMessage}`);
		} finally {
			statusBar.dispose();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.stop', () => {
		if (texpresso) {
			texpresso.kill();
		}
		activeEditor = undefined;
		registry?.clear();
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
