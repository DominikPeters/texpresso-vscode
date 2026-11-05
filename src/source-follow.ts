export interface SourceFollowIntent {
  session: object;
  document: string;
  version: number;
  line: number;
  column?: number;
  precise?: boolean;
  sequence: number;
  revision: number;
}

type Selection = Omit<SourceFollowIntent, 'session'>;

/** A compiler flush can acknowledge a source search; it is not a new selection. */
export class SourceFollow {
  private selections = new WeakMap<object, Selection>();
  private suspended = new WeakMap<object, Selection | undefined>();

  request(intent: SourceFollowIntent, explicit = false): boolean {
    const previous = this.selections.get(intent.session);
    let resumed = false;
    if (!explicit && this.suspended.has(intent.session)) {
      const held = this.suspended.get(intent.session);
      if (!held) {
        // Preview navigation can precede the first compiler flush. Remember
        // that first source identity without letting the flush steal the view.
        this.suspended.set(intent.session, {
          document: intent.document, version: intent.version, line: intent.line, column: intent.column,
          sequence: intent.sequence, revision: intent.revision
        });
        return false;
      }
      if (held.document === intent.document && held.version === intent.version && held.line === intent.line &&
          (held.column ?? 0) === (intent.column ?? 0)) { return false; }
      resumed = true;
    }
    this.suspended.delete(intent.session);
    if (!explicit && !resumed && previous && previous.document === intent.document && previous.version === intent.version &&
        previous.line === intent.line && previous.sequence === intent.sequence && previous.revision === intent.revision &&
        (!intent.precise || previous.column === intent.column)) {
      // Horizontal caret motion does not need another line-based SyncTeX
      // request, but a later preview hold must remember the latest selection.
      previous.column = intent.column;
      return false;
    }
    // Record before the caller sends: even a synchronous completion/flush must
    // not recursively issue another request for the same source and pass.
    this.selections.set(intent.session, {
      document: intent.document, version: intent.version, line: intent.line, column: intent.column,
      sequence: intent.sequence, revision: intent.revision
    });
    return true;
  }

  suspend(session: object): void { this.suspended.set(session, this.selections.get(session)); }

  invalidate(session: object): void { this.selections.delete(session); }
}
