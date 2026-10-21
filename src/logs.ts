import type { Message, OutputTarget } from './protocol';

// TeXpresso backtracks its output; offsets in the byte protocol are UTF-8 offsets.
export class OutputBuffer {
  private contents = Buffer.alloc(0);

  append(offset: number, text: string): void {
    this.contents = Buffer.concat([this.contents.subarray(0, offset), Buffer.from(text)]);
  }

  appendLines(lines: string[]): void {
    if (lines.length) {
      this.append(this.contents.length, lines.join('\n') + '\n');
    }
  }

  truncate(bytes: number): void {
    this.contents = this.contents.subarray(0, bytes);
  }

  truncateLines(count: number): void {
    const text = this.contents.toString();
    let end = 0;
    for (let i = 0; i < count; i++) {
      const newline = text.indexOf('\n', end);
      if (newline < 0) {
        end = text.length;
        break;
      }
      end = newline + 1;
    }
    this.contents = Buffer.from(text.slice(0, end));
  }

  toString(): string {
    return this.contents.toString();
  }
}

export class SessionOutput {
  private buffers = { out: new OutputBuffer(), log: new OutputBuffer() };
  private dirty = new Set<OutputTarget>();

  constructor(private publish: (target: OutputTarget, contents: string) => void) {}

  handle(message: Message): boolean {
    switch (message[0]) {
      case 'append':
        this.buffers[message[1]].append(message[2], message[3]);
        this.dirty.add(message[1]);
        return true;
      case 'append-lines':
        this.buffers[message[1]].appendLines(message.slice(2) as string[]);
        this.dirty.add(message[1]);
        return true;
      case 'truncate':
        this.buffers[message[1]].truncate(message[2]);
        this.dirty.add(message[1]);
        return true;
      case 'truncate-lines':
        this.buffers[message[1]].truncateLines(message[2]);
        this.dirty.add(message[1]);
        return true;
      case 'flush':
        this.flush();
        return true;
      default: return false;
    }
  }

  flush(): void {
    for (const target of this.dirty) {
      this.publish(target, this.buffers[target].toString());
    }
    this.dirty.clear();
  }
}
