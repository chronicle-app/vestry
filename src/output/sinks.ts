import { TextSink, allows, formatFields, timeOfDay, type LogLevel, type OutputEvent, type Sink } from '@chronicle.app/logging';
import { hint, line, wrap, type Segment } from './blocks.js';
import { bytes, clock, count } from './format.js';
import { glyphs } from './glyphs.js';
import { LiveView, type ProgressFields } from './live.js';
import type { Tokens } from './tokens.js';

/** Scopes that are vestry itself, and don't need naming. */
const HOST = new Set(['cli']);

/** Space between a line and the time at its right edge. */
const TIME_GAP = 2;

/** How often a log without a live view hears that a long command is still going. */
const HEARTBEAT = 10_000;

/** A roll-up's fields: how many it held back, and how often each value came up. */
type Rollup = {
  suppressed: number;
  values?: Record<string, Record<string, number>>;
  personal?: Record<string, Record<string, number>>;
};

const isRollup = (fields: unknown): fields is Rollup => typeof (fields as Rollup | undefined)?.suppressed === 'number';

/** `kind: verify 300 · copy 112 · +3 more`, per field, most common first. */
function tally({ values, personal }: Rollup): string {
  return Object.entries({ ...values, ...personal })
    .map(([field, counts]) => {
      const ranked = Object.entries(counts).sort(([, a], [, b]) => b - a);
      const top = ranked.slice(0, 3).map(([value, n]) => `${value} ${count(n)}`);
      if (ranked.length > 3) top.push(`+${ranked.length - 3} more`);
      return `${field}: ${top.join(` ${glyphs.bullet} `)}`;
    })
    .join('  ');
}

/**
 * An event as lines for a person, the pretty and plain sinks' shared look,
 * as Chronicle's: a glyph for what kind of event, the message, its fields
 * muted, and what to do about it as a hint beneath. With `time`, notices and
 * errors end with the time of day, right-aligned and muted, when the width
 * is known and the line has room. Unlike Chronicle's, a long message wraps
 * under itself rather than being cut: what it names, often a path, is for
 * copying. Progress is left to the live view.
 */
export function render(event: OutputEvent, t: Tokens, width: number, { time = false }: { time?: boolean } = {}): string | undefined {
  if (event.kind === 'progress') return undefined;
  if (event.kind === 'hint') return hint([event.message, event.hint?.action].filter(Boolean).join('\n'), t, width).join('\n');
  const [glyph, glyphStyle, textStyle] = event.level === 'error' ? [glyphs.failure, t.danger, undefined]
    : event.level === 'warn' ? [glyphs.warning, t.warning, undefined]
    : event.level === 'debug' ? [glyphs.bullet, t.muted, t.muted]
    : event.kind === 'summary' ? [glyphs.success, t.success, undefined]
    : [glyphs.bullet, t.muted, undefined];
  const scope = HOST.has(event.scope) || !event.scope ? '' : `${event.scope}  `;
  const label = event.level === 'error' ? 'Error: ' : '';
  const fields = event.key && isRollup(event.fields) ? tally(event.fields) : formatFields(event.fields);
  const lead = glyph.length + 1 + scope.length + label.length;
  const [first = '', ...rest] = event.message.split('\n').flatMap((part, i) => wrap(part, width - (i === 0 ? lead : 2), { cut: false }));
  const segments: Segment[] = [
    [glyph, glyphStyle], [' '], [scope, t.muted],
    // The label carries the status, in its color; the message stays readable.
    [label, glyphStyle], [first, textStyle], [fields ? `  ${fields}` : '', t.muted],
  ];
  const length = segments.reduce((sum, [text]) => sum + text.length, 0);
  const stamp = timeOfDay(event.time);
  // The message comes first: the time is dropped, never the text cut for it.
  const stamped = time && Number.isFinite(width) && length + TIME_GAP + stamp.length <= width;
  return [
    stamped ? line(segments, width) + ' '.repeat(width - length - stamp.length) + t.muted(stamp) : line(segments, Number.POSITIVE_INFINITY),
    ...rest.map(text => line([[`  ${text}`, textStyle]], Number.POSITIVE_INFINITY)),
    ...(event.hint ? hint(event.hint.action, t, width) : []),
  ].join('\n');
}

export interface SinkOptions {
  /** The quietest level shown. */
  level: LogLevel;
  t: Tokens;
  /** Columns to fit; default the terminal's, or unbounded when stderr isn't one. */
  width?: number;
  write?: (text: string) => void;
}

const terminalWidth = () => process.stderr.isTTY ? (process.stderr.columns || 80) - 1 : Number.POSITIVE_INFINITY;

/**
 * For a person at a terminal: color, the time of day at the right edge of
 * notices and errors, and a live progress line redrawn in place while a
 * command runs.
 */
export class PrettySink extends TextSink {
  private readonly view: LiveView;

  constructor(options: SinkOptions) {
    super({ level: options.level, write: options.write, format: event => render(event, options.t, options.width ?? terminalWidth(), { time: true }) });
    this.view = new LiveView(options.t);
  }

  override emit(event: OutputEvent): void {
    if (event.kind === 'progress') {
      if (allows(this.level, 'info')) this.view.update(event.fields as unknown as ProgressFields);
      return;
    }
    super.emit(event);
  }

  override flush(): void {
    this.view.stop();
    super.flush();
  }
}

/**
 * For a file or pipe: no frames, each line stamped with the time. A long
 * command logs what it's doing every 10 seconds, so a log shows it's alive.
 */
export class PlainSink extends TextSink {
  private lastBeat?: number;
  private beats = 0;

  constructor(options: SinkOptions) {
    const width = options.width ?? terminalWidth();
    super({
      level: options.level,
      write: options.write,
      format(event) {
        const stamp = `${timeOfDay(event.time)} `;
        return render(event, options.t, width - stamp.length)?.split('\n').map(part => stamp + part).join('\n');
      },
    });
  }

  override emit(event: OutputEvent): void {
    if (event.kind !== 'progress') return super.emit(event);
    const now = event.time.getTime(), fields = event.fields as unknown as ProgressFields;
    if (!allows(this.level, 'info') || now - (this.lastBeat ??= now) < HEARTBEAT) return;
    this.lastBeat = now;
    const amounts = fields.done === undefined ? '' : fields.total ? `  ${bytes(fields.done)}/${bytes(fields.total)}` : `  ${bytes(fields.done)}`;
    // Its own key, so heartbeats never roll up into a count.
    super.emit({ ...event, kind: 'notice', level: 'info', key: `heartbeat-${this.beats++}`, fields: undefined,
      message: `${fields.activity ?? fields.title}${amounts}  ${clock(fields.elapsedMs)}` });
  }
}

/** Pretty at a terminal, plain lines for a file or pipe. */
export const createSink = ({ pretty, ...options }: SinkOptions & { pretty: boolean }): Sink => pretty ? new PrettySink(options) : new PlainSink(options);
