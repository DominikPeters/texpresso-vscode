import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as assert from 'node:assert/strict';
import { PreviewController } from '../../preview-controller';
import type { TexpressoSession } from '../../session';
import type { Command } from '../../protocol';

// Exercise the production page with controlled, delayed browser image decodes.
// No native process: this isolates startup/invalidation from compiler timing.
export async function checkPreviewStartup(extensionUri: vscode.Uri): Promise<void> {
  const mainSource = (await fs.readFile(vscode.Uri.joinPath(extensionUri, 'media/preview.js').fsPath, 'utf8'))
    .replaceAll('acquireVsCodeApi', 'startupApi');
  const reports: any[] = [], commands: Command[] = [];
  let panel: vscode.WebviewPanel | undefined;
  const session = { embedded: true, state: 'running', paused: false, previewSequence: 0,
    document: { fileName: '/fixture/startup.tex' }, send: (command: Command) => commands.push(command) };
  const createPanel = (...args: Parameters<typeof vscode.window.createWebviewPanel>) => {
    const real = vscode.window.createWebviewPanel(...args); panel = real;
    return { get visible() { return real.visible; },
      onDidChangeViewState: real.onDidChangeViewState.bind(real), onDidDispose: real.onDidDispose.bind(real), dispose: () => real.dispose(),
      webview: { cspSource: real.webview.cspSource, asWebviewUri: real.webview.asWebviewUri.bind(real.webview),
        postMessage: real.webview.postMessage.bind(real.webview),
        onDidReceiveMessage: (callback: (message: unknown) => void) => real.webview.onDidReceiveMessage(m => {
          if (m.startupCheck) { reports.push(m); } else { callback(m); }
        }),
        set html(value: string) {
          const nonce = value.match(/data-instance="([^"]+)"/)![1];
          const bootstrap = `
            const api = acquireVsCodeApi(), identities = new WeakMap();
            let nextIdentity = 0, releaseDecode, prepared;
            const identity = image => { if (!identities.has(image)) identities.set(image, ++nextIdentity); return identities.get(image); };
            const snapshot = () => { const image = document.getElementById('image'), sheet = document.getElementById('sheet');
              return {identity:identity(image), prepared, hidden:image.hidden, complete:image.complete,
                naturalWidth:image.naturalWidth, sheetHeight:sheet.getBoundingClientRect().height, src:image.getAttribute('src')}; };
            const report = (startupCheck, id) => api.postMessage({startupCheck, id, ...snapshot()});
            const paint = callback => requestAnimationFrame(() => requestAnimationFrame(callback));
            window.startupApi = () => ({getState:()=>({format:'png',zoom:'page'}), setState:()=>{}, postMessage:m=>{
              api.postMessage(m);
              if (m.type === 'ready' || m.type === 'decoded') paint(()=>report(m.type,m.id));
            }});
            const decode = HTMLImageElement.prototype.decode;
            HTMLImageElement.prototype.decode = async function() {
              await new Promise(resolve => {releaseDecode=resolve; report('pending');});
              await decode.call(this); prepared=identity(this);
            };
            window.addEventListener('message', event=>{
              if(event.data.startupRelease) { const release=releaseDecode; releaseDecode=undefined; release?.(); }
              if(event.data.type==='error') paint(()=>report('error'));
            });`;
          value = value.replace(/<script nonce=/, () => `<script nonce="${nonce}">${bootstrap}</script><script nonce=`);
          value = value.replace(/<script nonce="[^"]+" src="[^"]*\/preview\.js"><\/script>/,
            () => `<script nonce="${nonce}">${mainSource}</script>`);
          real.webview.html = value;
        }
      }
    };
  };
  const api = { Uri: vscode.Uri, ViewColumn: vscode.ViewColumn, env: vscode.env, window: { createWebviewPanel: createPanel } } as unknown as typeof vscode;
  const controller = new PreviewController(api, extensionUri, session as unknown as TexpressoSession, () => {}, () => {});
  const until = async (condition: () => boolean, description: string) => {
    const deadline = Date.now() + 30000;
    while (!condition()) {
      if (Date.now() > deadline) { throw new Error(description + ': ' + JSON.stringify({ reports, commands })); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=', 'base64');
  const red = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  const frame = (command: Command, bytes: Buffer, width = 2) => controller.handle({ header: {
    requestId: command[1] as number, page: 0, revision: command[4] as number, sequence: command[5] as number,
    bounds: [0, 0, 600, 800], width, height: width, mime: 'image/png', byteLength: bytes.length }, bytes });
  const advance = () => { session.previewSequence++; controller.handle({ sourceSequence: session.previewSequence });
    controller.handle(['preview-state', session.previewSequence + 1, session.previewSequence, 1, true, 0]); };
  const release = () => panel!.webview.postMessage({ startupRelease: true });
  try {
    controller.handle(['preview-state', 1, 0, 1, true, 0]);
    await until(() => reports.some(r => r.startupCheck === 'ready') && commands.length > 0, 'startup ready');
    const initial = reports.find(r => r.startupCheck === 'ready');
    assert.equal(initial.hidden, true, 'source-less image is hidden');
    assert.equal(initial.sheetHeight, 0, 'measurement sheet does not expose a blank page');
    frame(commands[0], png);
    await until(() => reports.filter(r => r.startupCheck === 'pending').length === 1, 'first delayed decode');
    advance(); await release();
    await until(() => reports.some(r => r.startupCheck === 'decoded' && r.id === commands[0][1]) && commands.length === 2, 'obsolete startup decode released');
    const obsolete = reports.find(r => r.startupCheck === 'decoded' && r.id === commands[0][1]);
    assert.equal(obsolete.hidden, true); assert.equal(obsolete.sheetHeight, 0, 'stale decode cannot reveal an empty image');
    frame(commands[1], png);
    await until(() => reports.filter(r => r.startupCheck === 'pending').length === 2, 'current startup decode');
    await release();
    await until(() => reports.some(r => r.startupCheck === 'decoded' && r.id === commands[1][1]), 'first displayed frame');
    const first = reports.find(r => r.startupCheck === 'decoded' && r.id === commands[1][1]);
    assert.equal(first.identity, first.prepared, 'display the decoded element itself');
    assert.equal(first.hidden, false); assert.equal(first.complete, true); assert.equal(first.naturalWidth, 2);
    advance(); frame(commands[2], red, 1);
    await until(() => reports.filter(r => r.startupCheck === 'pending').length === 3, 'replacement decode');
    const pending = reports.filter(r => r.startupCheck === 'pending').at(-1);
    assert.equal(pending.identity, first.identity, 'keep the previous good frame while decoding');
    assert.equal(pending.naturalWidth, 2); assert.equal(pending.hidden, false);
    await release();
    await until(() => reports.some(r => r.startupCheck === 'decoded' && r.id === commands[2][1]), 'replacement displayed');
    const replaced = reports.find(r => r.startupCheck === 'decoded' && r.id === commands[2][1]);
    assert.equal(replaced.identity, replaced.prepared); assert.equal(replaced.naturalWidth, 1);
    advance(); frame(commands[3], Buffer.from('invalid PNG'));
    await until(() => reports.filter(r => r.startupCheck === 'pending').length === 4, 'invalid image decode');
    await release(); await until(() => reports.some(r => r.startupCheck === 'error'), 'decode failure');
    const failed = reports.find(r => r.startupCheck === 'error');
    assert.equal(failed.identity, replaced.identity, 'failed replacement retains the last good image');
    assert.equal(failed.complete, true); assert.equal(failed.naturalWidth, 1); assert.equal(failed.hidden, false);
    console.log('PASS: startup hides empty images; canceled/failed decodes preserve surfaces and fallback mounts the decoded element');
  } finally { controller.dispose(); }
}
