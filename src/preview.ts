import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class PreviewPanel {
    private panel: vscode.WebviewPanel | null = null;
    private documentName: string;
    private extensionUri: vscode.Uri;
    private onMessageCallback: ((msg: any) => void) | null = null;
    private onDisposeCallback: (() => void) | null = null;

    constructor(extensionUri: vscode.Uri, documentName: string) {
        this.extensionUri = extensionUri;
        this.documentName = documentName;
    }

    create(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'texpresso.preview',
            this.documentName,
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true,
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        this.panel.webview.html = this.getHtmlContent();

        this.panel.webview.onDidReceiveMessage(
            (message) => {
                if (this.onMessageCallback) {
                    this.onMessageCallback(message);
                }
            },
            undefined
        );

        this.panel.onDidDispose(() => {
            this.panel = null;
            if (this.onDisposeCallback) {
                this.onDisposeCallback();
            }
        });
    }

    onMessage(callback: (msg: any) => void): void {
        this.onMessageCallback = callback;
    }

    onDispose(callback: () => void): void {
        this.onDisposeCallback = callback;
    }

    updatePage(
        page: number,
        totalPages: number,
        qoiFilePath: string,
        width: number,
        height: number
    ): void {
        if (!this.panel) return;
        try {
            const qoiData = fs.readFileSync(qoiFilePath);
            const base64Data = qoiData.toString('base64');
            this.panel.webview.postMessage({
                type: 'page-update',
                page,
                totalPages,
                qoiBase64: base64Data,
                renderWidth: width,
                renderHeight: height,
            });
        } catch (e) {
            console.error('Failed to read QOI file:', e);
        }
    }

    postMessage(msg: any): void {
        this.panel?.webview.postMessage(msg);
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = null;
    }

    get isActive(): boolean {
        return this.panel !== null;
    }

    get panel_(): vscode.WebviewPanel | null {
        return this.panel;
    }

    private getHtmlContent(): string {
        const webviewJsUri = vscode.Uri.joinPath(
            this.extensionUri, 'dist', 'webview', 'preview.js'
        );
        const webviewUri = this.panel!.webview.asWebviewUri(webviewJsUri);

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            font-family: var(--vscode-font-family, sans-serif);
            overflow: hidden;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        #navbar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            background: var(--vscode-editor-background, #1e1e1e);
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
            flex-shrink: 0;
            user-select: none;
        }
        #navbar button {
            min-width: 36px;
            min-height: 36px;
            padding: 4px 8px;
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            background: var(--vscode-button-secondaryBackground, #3c3c3c);
            color: var(--vscode-button-secondaryForeground, #ccc);
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #navbar button:hover {
            background: var(--vscode-button-secondaryHoverBackground, #4c4c4c);
        }
        #navbar button:active {
            background: var(--vscode-button-background, #0078d4);
        }
        #page-input {
            width: 50px;
            min-height: 36px;
            text-align: center;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #ccc);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            font-size: 14px;
        }
        #total-pages {
            font-size: 14px;
            padding: 0 4px;
        }
        #canvas-container {
            flex: 1;
            overflow: hidden;
            position: relative;
            cursor: grab;
        }
        #canvas-container.panning {
            cursor: grabbing;
        }
        #preview-canvas {
            position: absolute;
            top: 0;
            left: 0;
        }
        #options-dropdown {
            position: relative;
            display: inline-block;
        }
        #options-menu {
            display: none;
            position: absolute;
            top: 100%;
            right: 0;
            min-width: 160px;
            background: var(--vscode-dropdown-background, #252526);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            z-index: 1000;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        }
        #options-menu.show { display: block; }
        #options-menu button {
            display: block;
            width: 100%;
            text-align: left;
            border: none;
            border-radius: 0;
            padding: 8px 12px;
            min-height: 32px;
        }
    </style>
</head>
<body>
    <div id="navbar">
        <button id="btn-home" title="首页">&#x23EE;</button>
        <button id="btn-prev" title="前一页">&#x25C0;</button>
        <input id="page-input" type="number" min="1" value="1">
        <span id="total-pages">/ 1</span>
        <button id="btn-next" title="后一页">&#x25B6;</button>
        <button id="btn-end" title="末页">&#x23ED;</button>
        <button id="btn-zoom-reset" title="重置缩放">&#x21BA;</button>
        <div id="options-dropdown">
            <button id="btn-options">选项 &#x25BE;</button>
            <div id="options-menu">
                <button id="btn-fit-width">适应宽度</button>
                <button id="btn-fit-height">适应高度</button>
                <button id="btn-dark-mode">深色模式</button>
                <button id="btn-language">English</button>
            </div>
        </div>
    </div>
    <div id="canvas-container">
        <canvas id="preview-canvas"></canvas>
    </div>
    <script src="${webviewUri}"></script>
</body>
</html>`;
    }
}
