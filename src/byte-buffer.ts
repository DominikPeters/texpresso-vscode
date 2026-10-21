// Compatibility with engines predating change-range. Prefer a straightforward
// pre-edit snapshot here: splitting UTF-16 strings into independently encoded
// rope leaves can split surrogate pairs and silently corrupt UTF-8 offsets.
export class ByteBuffer {
  constructor(private contents: string) {}

  byteOffset(offset: number): number {
    return Buffer.byteLength(this.contents.slice(0, offset), 'utf8');
  }

  replace(offset: number, length: number, text: string): void {
    this.contents = this.contents.slice(0, offset) + text + this.contents.slice(offset + length);
  }
}
