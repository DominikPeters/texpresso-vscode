import { EngineFailure } from './failures';

/** Shared rolling attempt limit. Success never resets a crash loop's history. */
export class RecoveryBudget {
  private attempts: number[] = [];
  constructor(private limit = 2, private windowMs = 60000, private now: () => number = () => performance.now()) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 || !Number.isFinite(windowMs) || windowMs <= 0) { throw Error('Invalid recovery budget'); }
  }
  take(): boolean {
    const now = this.now();
    this.attempts = this.attempts.filter(time => time <= now && now - time < this.windowMs);
    if (this.attempts.length >= this.limit) { return false; }
    this.attempts.push(now); return true;
  }
  reset(): void { this.attempts = []; }
}

/** Launch/configuration and compiler errors need correction, not a restart loop. */
export function isRecoverableEngineFailure(error: unknown, hadRun: boolean, diagnostics = ''): boolean {
  if (!hadRun || !(error instanceof EngineFailure) || !['exit', 'connection'].includes(error.phase)) { return false; }
  const details = error.message + '\n' + error.details + '\n' + diagnostics;
  return !/(?:unknown (?:option|argument)|unrecognized option|^!\s|emergency stop|fatal error occurred|TeX capacity exceeded|undefined control sequence|runaway argument|LaTeX Error|Package [^\n]+ Error)/im.test(details);
}
