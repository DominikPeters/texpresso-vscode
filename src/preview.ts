import * as vscode from 'vscode';
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

    private pageWidth: number = 0;
    private pageHeight: number = 0;

    setPageDimensions(pw: number, ph: number) {
        this.pageWidth = pw;
        this.pageHeight = ph;
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
                pageWidth: this.pageWidth,
                pageHeight: this.pageHeight,
            });
        } catch (e) {
            console.error('Failed to read QOI file:', e);
        }
    }

    updatePageDiff(
        page: number,
        totalPages: number,
        rects: any[],
        width: number,
        height: number,
        pageWidth: number,
        pageHeight: number,
    ): void {
        if (!this.panel) return;
        try {
            const rectsWithData = rects.map((r: any[]) => {
                const [x, y, w, h, filePath] = r;
                const qoiData = fs.readFileSync(filePath);
                const base64Data = qoiData.toString('base64');
                return { x, y, w, h, qoiBase64: base64Data };
            });
            this.panel.webview.postMessage({
                type: 'page-diff',
                page,
                totalPages,
                rects: rectsWithData,
                renderWidth: width,
                renderHeight: height,
                pageWidth: pageWidth,
                pageHeight: pageHeight,
            });
        } catch (e) {
            console.error('Failed to process page-diff:', e);
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
            min-width: 28px;
            min-height: 28px;
            padding: 2px 6px;
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            background: var(--vscode-button-secondaryBackground, #3c3c3c);
            color: var(--vscode-button-secondaryForeground, #ccc);
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
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
        #page-input, #res-input, #trim-input {
            min-height: 28px;
            text-align: center;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #ccc);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            font-size: 13px;
        }
        #page-input {
            width: 48px;
        }
        #res-input {
            width: 52px;
        }
        #trim-input {
            width: 48px;
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
        #loading {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 16px;
            opacity: 0.6;
            pointer-events: none;
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
        <input id="res-input" type="number" min="1" max="10" step="0.01" value="3.0" title="分辨率倍率">
        <input id="trim-input" type="number" min="0" max="0.49" step="0.01" value="0" title="裁剪比例">
        <div id="options-dropdown">
            <button id="btn-options">选项 &#x25BE;</button>
            <div id="options-menu">
                <button id="btn-fit-width">适应宽度</button>
                <button id="btn-fit-height">适应高度</button>
                <button id="btn-disable-synctex">关闭 SyncTeX</button>
                <button id="btn-dark-mode">深色模式</button>
                <button id="btn-language">English</button>
            </div>
        </div>
    </div>
    <div id="canvas-container">
        <canvas id="preview-canvas"></canvas>
        <div id="loading">渲染中…</div>
    </div>
    <script src="${webviewUri}"></script>
</body>
</html>`;
    }
}
