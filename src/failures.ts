import type { SessionConfiguration } from './configuration';

export class EngineFailure extends Error {
  constructor(readonly phase: 'launch' | 'connection' | 'exit' | 'configuration',
    message: string, readonly code?: string, readonly details = '') {
    super(message);
    this.name = 'EngineFailure';
  }
}

export function processFailure(error: Error, phase: 'launch' | 'connection'): EngineFailure {
  return new EngineFailure(phase, error.message, (error as NodeJS.ErrnoException).code);
}

export function describeFailure(error: unknown, configuration?: SessionConfiguration): {
  message: string; setting: string;
} {
  const failure = error instanceof EngineFailure ? error : undefined;
  const detail = error instanceof Error ? error.message : String(error);
  if (failure?.phase === 'configuration') {
    return { message: 'TeXpresso settings are invalid: ' + detail, setting: 'texpresso.arguments' };
  }
  if (failure?.phase === 'launch' && failure.code === 'ENOENT') {
    return configuration?.useWSL
      ? { message: 'Could not start WSL. Check that WSL is installed and available to VS Code.', setting: 'texpresso.useWSL' }
      : { message: 'Could not find TeXpresso at “' + configuration?.command +
          '”. Set its executable path in Settings or add it to PATH.', setting: 'texpresso.command' };
  }
  if (failure?.phase === 'launch' && (failure.code === 'EACCES' || failure.code === 'EPERM')) {
    return { message: 'VS Code cannot execute TeXpresso. Check the executable’s permissions. ' + detail,
      setting: 'texpresso.command' };
  }
  if (failure?.phase === 'exit') {
    if (/unknown (option|argument)|unrecognized option/i.test(failure.details)) {
      return { message: 'TeXpresso rejected a launch argument. Check Setup shows the arguments and engine output; ' +
        'your installed build may not support the selected options.', setting: 'texpresso.arguments' };
    }
    return { message: detail + '. Open the Engine Log for the reason.', setting: 'texpresso' };
  }
  if (failure?.phase === 'connection') {
    return { message: 'The connection to TeXpresso failed: ' + detail + '. Open the Engine Log for details.',
      setting: 'texpresso' };
  }
  return { message: 'Could not start TeXpresso: ' + detail, setting: 'texpresso' };
}
