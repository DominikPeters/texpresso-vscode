/** Keep resource-budget decisions across source barriers without keeping images. */
export interface FallbackContext {
  width: number;
  bounds?: readonly number[];
  allocation?: string;
  complexity?: number;
}
export interface RenderBudget { available: number; required: number; pixels: number }
export type FallbackCause = 'budget' | 'decode';
interface Rejection { context: FallbackContext; cause: FallbackCause; budget?: RenderBudget }
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1e12;
function valid(context: FallbackContext): boolean {
  return Number.isSafeInteger(context.width) && context.width > 0 && context.width <= 8192 &&
    (context.allocation === undefined || (typeof context.allocation === 'string' && context.allocation.length <= 256)) &&
    (context.complexity === undefined || finite(context.complexity)) &&
    (context.bounds === undefined || (context.bounds.length === 4 && context.bounds.every(n => Number.isFinite(n) && Math.abs(n) < 1e9) &&
      context.bounds[2] > context.bounds[0] && context.bounds[3] > context.bounds[1]));
}
function validBudget(budget: RenderBudget): boolean {
  return finite(budget.available) && budget.available > 0 && finite(budget.required) &&
    finite(budget.pixels) && budget.required >= budget.pixels;
}
export class RenderFallbacks {
  private entries = new Map<number, Rejection>();
  constructor(private maxEntries = 64) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) { throw Error('Invalid fallback cache size'); }
  }
  reject(page: number, context: FallbackContext, cause: FallbackCause, budget?: RenderBudget): void {
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000 || !valid(context) || !['budget', 'decode'].includes(cause)) { return; }
    const copy = { ...context, bounds: context.bounds && [...context.bounds] };
    this.entries.delete(page);
    this.entries.set(page, { context: copy, cause, budget: budget && validBudget(budget) ? { ...budget } : undefined });
    while (this.entries.size > this.maxEntries) { this.entries.delete(this.entries.keys().next().value as number); }
  }
  has(page: number): boolean { return this.entries.has(page); }
  cause(page: number): FallbackCause | undefined { return this.entries.get(page)?.cause; }
  usePng(page: number, context: FallbackContext): boolean {
    const entry = this.entries.get(page);
    if (!entry || !valid(context)) { return false; }
    const old = entry.context;
    // SVG allocation describes its actual DPR-aware surface and quota. The
    // requested width is a separately capped PNG base: active/neighbor priority
    // can change it without changing whether an SVG fits at all. Retrying on
    // that raster-only change creates a PNG/SVG feedback loop at page edges.
    const allocated = old.allocation !== undefined && context.allocation !== undefined;
    const changed = (!allocated && old.width !== context.width) ||
      (allocated && old.allocation !== context.allocation) ||
      (old.bounds && context.bounds && old.bounds.some((n, i) => n !== context.bounds![i]));
    // The pixel surface does not shrink when content is simplified. Predict only
    // the content-dependent allocation using fresh, cheap native vector metadata.
    // Retry when that estimate fits the original quota, never on every keystroke.
    const b = entry.budget;
    const simpler = entry.cause === 'budget' && b && old.complexity !== undefined && old.complexity > 0 &&
      context.complexity !== undefined && context.complexity < old.complexity && b.required > b.available &&
      b.pixels + (b.required - b.pixels) * context.complexity / old.complexity <= b.available;
    if (changed || simpler) { this.entries.delete(page); return false; }
    this.entries.delete(page); this.entries.set(page, entry);
    return true;
  }
  /** Decoder/content failures may recover on edits; allocation failures persist. */
  sourceChanged(): void {
    for (const [page, entry] of this.entries) { if (entry.cause === 'decode') { this.entries.delete(page); } }
  }
  clear(page?: number): void { if (page === undefined) { this.entries.clear(); } else { this.entries.delete(page); } }
}
