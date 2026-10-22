import { createInterface, Interface } from 'readline';
import type { Readable } from 'stream';

export type OutputTarget = 'out' | 'log';
export type Command =
  | ['open', string, string]
  | ['open-base64', string, string]
  | ['register', string]
  | ['rerun', boolean]
  | ['rerun-once'] | ['pause'] | ['resume']
  | ['close', string]
  | ['change', string, number, number, string]
  | ['change-range', string, number, number, number, number, string]
  | ['synctex-forward', string, number]
  | ['theme', number[], number[]]
  | ['preview-barrier', number]
  | ['preview-destination', number, number, string]
  | ['preview-svg', number, number, number, number, number]
  | ['preview-render', number, number, number, number, number]
  | ['preview-region', number, number, number, number, number, number, number, number, number]
  | ['preview-inverse', number, number, number, number, number]
  | ['next-page'] | ['previous-page'] | ['rescan'];

export type Message =
  | ['input-file', number, string]
  | ['synctex', string, number, number?, string?]
  | ['append-lines', OutputTarget, ...string[]]
  | ['truncate-lines', OutputTarget, number]
  | ['append', OutputTarget, number, string]
  | ['truncate', OutputTarget, number]
  | ['flush'] | ['reset-sync']
  | ['lookup-file', string, string, string];

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validateMessage(value: unknown): value is Message | [string, ...unknown[]] {
  if (!Array.isArray(value) || typeof value[0] !== 'string') {
    return false;
  }
  const [, a, b, c] = value;
  switch (value[0]) {
    case 'input-file': return isCount(a) && typeof b === 'string';
    // Upstream uses -1 when SyncTeX has no column information.
    case 'synctex': return typeof a === 'string' && isCount(b) && (c === undefined || c === -1 || isCount(c)) &&
      (value[4] === undefined || (typeof value[4] === 'string' && value[4].length <= 256));
    case 'append-lines':
      return (a === 'out' || a === 'log') && value.slice(2).every(line => typeof line === 'string');
    case 'append':
      return (a === 'out' || a === 'log') && isCount(b) && typeof c === 'string';
    case 'truncate':
    case 'truncate-lines': return (a === 'out' || a === 'log') && isCount(b);
    case 'lookup-file': return typeof a === 'string' && typeof b === 'string' && typeof c === 'string';
    default: return true; // Future notifications may safely be ignored.
  }
}

export function readProtocol(
  input: Readable,
  onMessage: (message: Message) => void,
  onInvalid: (line: string, error: unknown) => void
): Interface {
  const reader = createInterface({ input, crlfDelay: Infinity });
  reader.on('line', line => {
    if (!line.trim()) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
      if (!validateMessage(message)) {
        throw new Error('Invalid TeXpresso message');
      }
    } catch (error) {
      onInvalid(line, error);
      return;
    }
    // validateMessage checks the payload of every command we interpret.
    // Unknown verbs reach the session's default handler and are ignored.
    onMessage(message as Message);
  });
  return reader;
}
