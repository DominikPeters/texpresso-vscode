import type { Command } from './protocol';
import type { PreviewMessage } from './preview-protocol';

export type SourcePosition = { path: string; offset: number };
type Context = { available: boolean; idle: boolean; revision: number; sequence: number };

/** Cursor settling delays speculative work only; edits never wait for this timer. */
export class EditPrewarm {
  private target?: { identity: string; resolve: () => SourcePosition | undefined; resolved?: boolean; position?: SourcePosition };
  private timer?: ReturnType<typeof setTimeout>;
  private timeout?: ReturnType<typeof setTimeout>;
  private active?: { id: number; revision: number; sequence: number; key: string };
  private attempted = new Set<string>();
  private skipped = new Set<string>();
  constructor(private context: () => Context, private send: (command: Command) => void,
    private nextId: () => number, private started: () => void, private settled: () => void) {}

  select(identity?: string, resolve?: () => SourcePosition | undefined): void {
    if (identity === this.target?.identity) { this.refresh(); return; }
    this.interrupt();
    this.target = identity !== undefined && resolve ? { identity, resolve } : undefined;
    this.refresh();
  }
  private candidate(): { position: SourcePosition; key: string; context: Context } | undefined {
    const context = this.context();
    if (!context.available || !this.target) { return; }
    if (!this.target.resolved) { this.target.position = this.target.resolve(); this.target.resolved = true; }
    const position = this.target.position;
    if (!position) { return; }
    const key = `${context.revision}:${context.sequence}:${position.path}:${Math.floor(position.offset / 64)}`;
    return this.attempted.has(key) ? undefined : { position, key, context };
  }
  get pending(): boolean { return !!this.active || !!this.timer; }
  refresh(foregroundReady = false): void {
    // A skipped request may have raced foreground source/page discovery. Retry
    // only after explicit foreground progress, never on its own acknowledgment.
    if (foregroundReady) {
      for (const key of this.skipped) { this.attempted.delete(key); }
      this.skipped.clear();
      if (this.target && !this.target.position) { this.target.resolved = false; }
    }
    const context = this.context();
    if (this.pending || !context.available || !context.idle || !this.target) { return; }
    // UTF-16 to UTF-8 conversion can scan a large prefix. Do it only after the
    // cursor settles, then reuse it while this document version is unchanged.
    if (this.target.resolved && !this.candidate()) { return; }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const current = this.context();
      if (!current.available || !current.idle) { return; }
      const candidate = this.candidate();
      if (!candidate || !candidate.context.idle) { return; }
      const { position, key, context } = candidate;
      this.attempted.add(key);
      while (this.attempted.size > 16) {
        const oldest = this.attempted.values().next().value!;
        this.attempted.delete(oldest); this.skipped.delete(oldest);
      }
      const id = this.nextId();
      this.active = { id, revision: context.revision, sequence: context.sequence, key };
      this.started();
      // Native replay is bounded too. This watchdog also covers an unresponsive process.
      this.timeout = setTimeout(() => { this.interrupt(false); this.settled(); }, 5000);
      this.send(['preview-prepare', id, position.path, position.offset, context.revision, context.sequence]);
    }, 200);
  }
  handle(event: Extract<PreviewMessage, ['preview-prepared', ...unknown[]]>): void {
    if (!this.active || event[1] !== this.active.id || event[2] !== this.active.revision || event[3] !== this.active.sequence) { return; }
    if (event[4] === 'skipped') { this.skipped.add(this.active.key); }
    clearTimeout(this.timeout); this.timeout = undefined; this.active = undefined;
    this.settled();
  }
  interrupt(retry = true): void {
    clearTimeout(this.timer); this.timer = undefined;
    clearTimeout(this.timeout); this.timeout = undefined;
    const active = this.active; this.active = undefined;
    if (active) {
      if (retry) { this.attempted.delete(active.key); }
      this.send(['preview-prepare-cancel', active.id]);
    }
  }
}
