import { line, type Segment } from './blocks.js';
import { bytes, clock } from './format.js';
import { glyphs } from './glyphs.js';
import type { Tokens } from './tokens.js';

const BAR = 24;
const TICK = 80;

/** Where a command is: what it's doing, and how far through the bytes it has to read. */
export interface ProgressFields {
  title: string;
  /** What it's doing now, beneath the title. */
  activity?: string;
  done?: number;
  total?: number;
  elapsedMs: number;
}

/** A bar filled in proportion to the total; nothing when there's no total to measure against. */
function bar({ done = 0, total = 0 }: ProgressFields, t: Tokens): Segment[] {
  if (total <= 0) return [];
  const filled = Math.round(Math.min(1, done / total) * BAR);
  return [[glyphs.bar.repeat(filled), t.accent], [glyphs.bar.repeat(BAR - filled), t.muted], ['  ']];
}

/**
 * The live view of a command: spinner, title, bar, bytes, and clock, and
 * what it's doing beneath. Without a known total there's no bar: the spinner
 * alone says it's alive, so nothing looks like progress it isn't.
 */
export function progress(fields: ProgressFields, t: Tokens, width: number, frame = 0): string[] {
  const { done, total, elapsedMs } = fields;
  const amounts: Segment[] = done === undefined ? [] : total ? [[bytes(done)], ['/', t.muted], [bytes(total)]] : [[bytes(done)]];
  const lines = [
    line([
      [glyphs.spinner[frame % glyphs.spinner.length], t.accent],
      [' '],
      [fields.title, t.strong],
      ['  '],
      ...bar(fields, t),
      ...amounts,
      [`  ${clock(elapsedMs)}`, t.muted],
    ], width),
  ];
  if (fields.activity) lines.push(line([[`  ${glyphs.child} `, t.muted], [fields.activity, t.muted]], width));
  return lines;
}

/**
 * Lines on stderr, redrawn in place as a spinner ticks. Anything else written
 * to stderr meanwhile prints above them, and they redraw beneath. `render`
 * draws them for a width and a spinner frame, each line within the width.
 */
export class LiveRegion {
  private frame = 0;
  private drawn = 0;
  private timer?: NodeJS.Timeout;
  private readonly write = process.stderr.write.bind(process.stderr);

  constructor(private readonly render: (width: number, frame: number) => string[]) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer) return;
    this.write('\u001B[?25l');
    process.once('exit', this.restoreCursor);
    process.stderr.write = ((chunk: any, ...rest: any[]) => {
      this.erase();
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      const written = this.write(text.endsWith('\n') ? text : `${text}\n`, ...rest);
      this.draw();
      return written;
    }) as typeof process.stderr.write;
    this.timer = setInterval(() => {
      this.frame++;
      this.redraw();
    }, TICK);
    this.timer.unref();
    this.draw();
  }

  /** Draw what changed now, not on the next tick. */
  redraw(): void {
    if (!this.timer) return;
    this.erase();
    this.draw();
  }

  /** Take the lines off the screen, leaving stderr as it was. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.erase();
    process.stderr.write = this.write as typeof process.stderr.write;
    this.restoreCursor();
    process.removeListener('exit', this.restoreCursor);
  }

  private restoreCursor = () => {
    this.write('\u001B[?25h');
  };

  private draw(): void {
    const lines = this.render((process.stderr.columns || 80) - 1, this.frame);
    this.write(lines.join('\n'));
    this.drawn = lines.length;
  }

  private erase(): void {
    if (this.drawn === 0) return;
    this.write(`\r\u001B[2K${'\u001B[1A\u001B[2K'.repeat(this.drawn - 1)}`);
    this.drawn = 0;
  }
}

/** Draws {@link progress} on stderr, redrawn in place. */
export class LiveView {
  private fields?: ProgressFields;
  private startedAt = 0;
  private readonly region = new LiveRegion(this.lines.bind(this));

  constructor(private readonly t: Tokens) {}

  get running(): boolean {
    return this.region.running;
  }

  update(fields: ProgressFields): void {
    this.fields = fields;
    this.startedAt = Date.now() - fields.elapsedMs;
    if (!this.region.running) this.region.start();
  }

  /** Take the view off the screen, leaving stderr as it was. */
  stop(): void {
    this.region.stop();
  }

  private lines(width: number, frame: number): string[] {
    if (!this.fields) return [];
    return progress({ ...this.fields, elapsedMs: Date.now() - this.startedAt }, this.t, width, frame);
  }
}
