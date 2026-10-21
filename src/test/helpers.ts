import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type * as vscode from 'vscode';
import type { SessionConfiguration } from '../configuration';
import type { Command } from '../protocol';
import * as path from 'node:path';

export const config: SessionConfiguration = {
  command: 'texpresso', useWSL: false, useChangeRangeMode: true,
  packageProvider: 'auto', includeDirectories: [], arguments: [],
  autoRerun: false, watchDependencies: true, streamFiles: false
};

export function document(fileName: string, text = 'abc'): vscode.TextDocument {
  fileName = /^[a-z]:\\/i.test(fileName) ? fileName : path.resolve(fileName);
  return {
    fileName, uri: { fsPath: fileName }, getText: () => text,
    isClosed: false, isUntitled: false, isDirty: false
  } as unknown as vscode.TextDocument;
}

export class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  writes: string[] = [];
  killed = false;
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.writes.push(chunk.toString()));
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  get commands(): Command[] {
    return this.writes.map(line => JSON.parse(line) as Command);
  }
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}
