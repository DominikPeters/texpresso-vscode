import type { Readable } from 'stream';
import { validateMessage, type Message } from './protocol';

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export interface PreviewImageHeader {
  requestId: number; revision: number; sequence: number; page: number;
  bounds: [number, number, number, number]; width: number; height: number;
  mime: 'image/png'; byteLength: number;
}
export interface PreviewImage { header: PreviewImageHeader; bytes: Buffer }
export type PreviewMessage =
  | ['preview-state', number, number, number, boolean, number]
  | ['preview-invalidated', number, number]
  | ['preview-forward', number, number, number, number, number]
  | ['preview-retry', number]
  | ['preview-error', number, string];

const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 2147483647;
const previewNotifications = new Set(['preview-state', 'preview-invalidated', 'preview-forward', 'preview-retry', 'preview-error']);
export function isImageHeader(value: unknown): value is PreviewImageHeader {
  if (!value || typeof value !== 'object') { return false; }
  const h = value as PreviewImageHeader;
  return [h.requestId, h.revision, h.sequence, h.page, h.width, h.height, h.byteLength].every(count) &&
    h.width > 0 && h.height > 0 && h.width <= 8192 && h.height <= 8192 &&
    h.width * h.height <= 4000000 && h.byteLength > 0 && h.byteLength <= MAX_IMAGE_BYTES &&
    h.mime === 'image/png' && Array.isArray(h.bounds) && h.bounds.length === 4 &&
    h.bounds.every(n => Number.isFinite(n) && Math.abs(n) < 1e9) &&
    h.bounds[2] > h.bounds[0] && h.bounds[3] > h.bounds[1];
}

export function isPreviewMessage(value: unknown): value is PreviewMessage {
  if (!Array.isArray(value)) { return false; }
  switch (value[0]) {
    case 'preview-state': return value.length === 6 && [value[1], value[2], value[3], value[5]].every(count) && typeof value[4] === 'boolean';
    case 'preview-invalidated': return value.length === 3 && value.slice(1).every(count);
    case 'preview-forward': return value.length === 6 && value.slice(1, 4).every(count) &&
      value.slice(4).every(n => typeof n === 'number' && Number.isFinite(n));
    case 'preview-retry': return value.length === 2 && count(value[1]);
    case 'preview-error': return value.length === 3 && count(value[1]) && typeof value[2] === 'string';
    default: return false;
  }
}

// This reader is used only after explicitly enabling the engine's binary mode.
// Never attach readline, setEncoding, or another stdout consumer alongside it.
export function readPreviewProtocol(input: Readable, message: (value: Message | PreviewMessage) => void,
  image: (value: PreviewImage) => void, failure: (error: Error) => void): { close(): void } {
  let line: Buffer[] = [], lineBytes = 0;
  let header: PreviewImageHeader | undefined;
  let body: Buffer | undefined, offset = 0, closed = false;
  const close = () => {
    closed = true;
    input.off('data', data); input.off('end', end);
    line = []; body = undefined; header = undefined;
  };
  const fail = (error: unknown) => { close(); failure(error instanceof Error ? error : new Error(String(error))); };
  const data = (chunk: Buffer) => {
    try {
      if (!Buffer.isBuffer(chunk)) { throw new Error('Preview stdout must be a byte stream.'); }
      let cursor = 0;
      while (cursor < chunk.length && !closed) {
        if (header && body) {
          const length = Math.min(body.length - offset, chunk.length - cursor);
          chunk.copy(body, offset, cursor, cursor + length);
          cursor += length; offset += length;
          if (offset === body.length) {
            const frame = { header, bytes: body };
            header = undefined; body = undefined; offset = 0;
            image(frame);
          }
        } else {
          const newline = chunk.indexOf(10, cursor);
          const stop = newline === -1 ? chunk.length : newline;
          lineBytes += stop - cursor;
          if (lineBytes > 1024 * 1024) { throw new Error('Preview protocol header exceeds 1 MiB.'); }
          line.push(chunk.subarray(cursor, stop));
          cursor = newline === -1 ? chunk.length : newline + 1;
          if (newline === -1) { continue; }
          const text = Buffer.concat(line, lineBytes).toString('utf8').trim();
          line = []; lineBytes = 0;
          if (!text) { continue; }
          const value: unknown = JSON.parse(text);
          if (Array.isArray(value) && value[0] === 'preview-image') {
            if (value.length !== 2 || !isImageHeader(value[1])) { throw new Error('Invalid preview image header.'); }
            header = value[1]; body = Buffer.allocUnsafe(header.byteLength);
          } else {
            if (!isPreviewMessage(value) && (!validateMessage(value) ||
                (Array.isArray(value) && previewNotifications.has(value[0])))) {
              throw new Error('Invalid preview protocol message: ' + text.slice(0, 200));
            }
            message(value as Message | PreviewMessage);
          }
        }
      }
    } catch (error) { fail(error); }
  };
  const end = () => {
    if (header || lineBytes) { fail(new Error('TeXpresso exited during a preview frame.')); }
    else { close(); }
  };
  input.on('data', data); input.on('end', end);
  return { close };
}
