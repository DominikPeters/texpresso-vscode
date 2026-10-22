// Rendering work only; request latency includes compiler rollback and must never
// teach the codec chooser. Full mounts and incremental updates are separate.
export interface RenderWork { native: number; host: number; webview: number }
type Codec = 'png' | 'svg';
type Samples = { time: number; total: number }[];
interface Costs { png: Samples; svg: Samples; pngPreferred: boolean }
export class AutoRenderCosts {
  private contexts = new Map<string, Costs>();
  constructor(private now: () => number = () => performance.now()) {}
  record(context: string, codec: Codec, patch: boolean, work: RenderWork): void {
    if (!Object.values(work).every(n => Number.isFinite(n) && n >= 0 && n < 1e9)) { return; }
    const key = context + (patch ? ':patch' : ':full');
    const entry = this.contexts.get(key) || { png: [], svg: [], pngPreferred: false };
    this.contexts.delete(key); this.contexts.set(key, entry);
    entry[codec].push({ time: this.now(), total: work.native + work.host + work.webview });
    if (entry[codec].length > 8) { entry[codec].shift(); }
    while (this.contexts.size > 64) { this.contexts.delete(this.contexts.keys().next().value as string); }
  }
  preferPng(context: string, patch: boolean): boolean {
    const entry = this.contexts.get(context + (patch ? ':patch' : ':full'));
    if (!entry) { return false; }
    // Natural/manual observations only: never run speculative foreground renders
    // merely to collect a comparison. Missing/old evidence keeps the SVG policy.
    const recent = (samples: Samples) => samples.filter(s => this.now() - s.time <= 30000).map(s => s.total).sort((a, b) => a - b);
    const png = recent(entry.png), svg = recent(entry.svg);
    if (png.length < 5 || svg.length < 5) { entry.pngPreferred = false; return false; }
    const quartile = (values: number[], q: number) => values[Math.floor((values.length - 1) * q)];
    // Demand sustained distribution separation and leave a margin for scheduler
    // noise. Reverse only on equally strong evidence in the other direction.
    const separated = (fast: number[], slow: number[]) => {
      const upper = quartile(fast, .75), lower = quartile(slow, .25);
      return lower > upper + Math.max(3, upper * .25);
    };
    if (separated(png, svg)) { entry.pngPreferred = true; }
    else if (separated(svg, png)) { entry.pngPreferred = false; }
    return entry.pngPreferred;
  }
}
