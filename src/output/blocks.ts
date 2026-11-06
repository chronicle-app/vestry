import { duration, truncate, truncatePath } from './format.js';
import { glyphs } from './glyphs.js';
import type { Style, Tokens } from './tokens.js';

/** A run of text and the style it prints in. */
export type Segment = [text: string, style?: Style];

const measure = (segments: Segment[]) => segments.reduce((n, [text]) => n + text.length, 0);

/** Segments as one line of at most `width` visible characters, styled after cutting. */
export function line(segments: Segment[], width: number): string {
  let left = width;
  let out = '';
  for (const [text, style] of segments) {
    if (left <= 0) break;
    const cut = text.length > left ? truncate(text, left) : text;
    left -= cut.length;
    out += style ? style(cut) : cut;
  }
  return out;
}

/** How a command ended: done, failed, or done with something to look at. */
export type Status = 'success' | 'failure' | 'warning';

/**
 * The first line of a command's result: its status, what happened, how long
 * it took, and where it went.
 *
 *   ✓ Package created  in 212ms  → ~/Archive/photos-2019
 */
export function summary(
  { status, title, durationMs, output }: { status?: Status; title: string; durationMs?: number; output?: string },
  t: Tokens,
  width: number,
): string {
  const glyph: Segment[] = status === 'failure' ? [[glyphs.failure, t.danger], [' ']]
    : status === 'warning' ? [[glyphs.warning, t.warning], [' ']]
    : status === 'success' ? [[glyphs.success, t.success], [' ']] : [];
  return line([
    ...glyph,
    [title, t.strong],
    [durationMs === undefined ? '' : `  in ${duration(durationMs)}`, t.muted],
    ...(output ? [[`  ${glyphs.arrow} `, t.muted], [output]] as Segment[] : []),
  ], width);
}

const HELD_SPACE = '\u0000';

/** Text with each `code span` in the code style, the rest muted (or plain). */
export function codeSpans(text: string, t: Tokens, muted = true): string {
  return text
    .split(/(`[^`]*`)/)
    .map(piece =>
      piece.startsWith('`') && piece.endsWith('`') && piece.length > 1
        ? t.code(piece.slice(1, -1))
        : piece && (muted ? t.muted(piece) : piece))
    .join('');
}

/**
 * Text in lines of at most `width`, broken at spaces. A `code span` is never
 * broken or cut, since a command split across lines can't be copied: it gets
 * a line of its own, even one wider than `width`. Any other word longer than
 * the width is cut, unless `cut` is false.
 */
export function wrap(text: string, width: number, { cut = true }: { cut?: boolean } = {}): string[] {
  if (!Number.isFinite(width) || text.length <= width) return [text];
  const words = text.match(/`[^`]*`\S*|\S+/g) ?? [];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = '';
    }
    const whole = word.startsWith('`') || !cut ? word : truncate(word, Math.max(1, width));
    current = current ? `${current} ${word}` : whole;
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * What to do next, under the line it follows: a `↳` line per line of the
 * text, in plain sentences with commands inline. Wrapping never splits a
 * command, or cuts a path. A line that ends in a command (`To free the space:
 * \`vestry cleanup …\``) puts it on a line of its own, and a line that is
 * only a command, after one ending in a colon, lines up under it.
 *
 *   ↳ Run `vestry recover` to see what's unfinished.
 */
export function hint(text: string, t: Tokens, width: number): string[] {
  const steps = text.split('\n').filter(step => step.trim() !== '');
  const lines: string[] = [];
  let listing = false;
  for (const step of steps) {
    const ending = step.match(/^(.*?):?\s*`([^`]+)`$/s);
    const [prose, command] = ending ? [ending[1].trim(), ending[2]] : [step, undefined];
    if (prose) {
      // Wrapped at spaces, continued under its text rather than its arrow.
      // Spaces inside code spans held, so wrapping keeps each command whole.
      const held = (command ? `${prose}:` : prose).replaceAll(/`[^`]*`/g, span => span.replaceAll(' ', HELD_SPACE));
      for (const [i, part] of wrap(held, width - 4, { cut: false }).entries()) {
        lines.push(t.muted(i === 0 ? `  ${glyphs.child} ` : '    ') + codeSpans(part.replaceAll(HELD_SPACE, ' '), t));
      }
    }
    // Never cut: a command prints whole, and the terminal wraps it.
    if (command) lines.push(prose || listing ? `      ${t.command(command)}` : `${t.muted(`  ${glyphs.child} `)}${t.command(command)}`);
    listing = command ? listing || !!prose : step.trimEnd().endsWith(':');
  }
  return lines;
}

/** A section title. Emphasis only: no rules, no boxes. */
export const heading = (text: string, t: Tokens, width: number) => line([[text, t.strong]], width);

/**
 * Plain sentences wrapped to the width under an indent, read in full: not
 * muted, commands whole and in the code style. With `cut` false, as for
 * someone's own notes, no word is cut either.
 */
export function paragraph(text: string, t: Tokens, width: number, indent = 0, { cut = true }: { cut?: boolean } = {}): string[] {
  const pad = ' '.repeat(indent);
  return wrap(text, width - indent, { cut }).map(part => pad + codeSpans(part, t, false));
}

/** A term and what it means, for `definitions`. */
export interface Definition {
  /** What to type or look for, styled by the caller. */
  term: Segment[];
  /** Plain sentences; a line break starts a new line. */
  text?: string;
}

const GAP = 2;
/** The widest a term column gets before a long term takes a line of its own. */
const TERM_MAX = 32;
/** The narrowest text column; any narrower and the text goes under its term. */
const TEXT_MIN = 24;

/**
 * Terms in a column and their text beside them, wrapped under one another:
 * commands, flags. A term too wide for the column takes a line of its own
 * with its text below; when the width leaves no room for a column, every
 * text goes under its term.
 *
 *   --plan       Show what would be read and written, and change nothing
 */
export function definitions(items: Definition[], t: Tokens, width: number, indent = 2): string[] {
  const pad = ' '.repeat(indent);
  // As wide as the widest term that fits, so one long term doesn't push every text over.
  const column = Math.max(0, ...items.map(({ term }) => measure(term)).filter(w => w <= TERM_MAX));
  const stacked = column === 0 || width - indent - column - GAP < TEXT_MIN;
  const at = stacked ? indent + 4 : indent + column + GAP;
  const lines: string[] = [];
  for (const { term, text = '' } of items) {
    const body = (text ? text.split('\n').flatMap(part => wrap(part, width - at)) : []).map(part => codeSpans(part, t, false));
    const termWidth = measure(term);
    if (!stacked && termWidth <= column && body.length > 0) {
      lines.push(`${pad}${line(term, width - indent)}${' '.repeat(column - termWidth + GAP)}${body[0]}`, ...body.slice(1).map(part => ' '.repeat(at) + part));
    } else {
      lines.push(pad + line(term, width - indent), ...body.map(part => ' '.repeat(at) + part));
    }
  }
  return lines;
}

/**
 * Keys, muted, and their values, under an indent. A value is never cut:
 * paths and IDs are for copying, so a long one continues on lines under
 * itself, broken at spaces, and the terminal wraps one too long for the
 * column. A line break in a value starts a new line.
 *
 *   Location    ~/Archive/photos-2019
 *   Content ID  vestry-payload-v1:sha256:9a8a…
 */
export function card(entries: [key: string, value: string][], t: Tokens, width: number, indent = 4): string[] {
  const pad = ' '.repeat(indent);
  const keyWidth = Math.max(0, ...entries.map(([key]) => key.length));
  const valueWidth = Math.max(TEXT_MIN, width - indent - keyWidth - GAP);
  return entries.flatMap(([key, value]) => {
    const [first = '', ...rest] = value.split('\n').flatMap(part => wrap(part, valueWidth, { cut: false }));
    return [`${pad}${t.muted(key.padEnd(keyWidth))}${' '.repeat(GAP)}${first}`.trimEnd(), ...rest.map(part => `${pad}${' '.repeat(keyWidth + GAP)}${part}`)];
  });
}

/** The widest a column gets at a terminal, so one long column doesn't crowd the rest. */
const MAX_WIDTH = 60;

const join = (parts: string[]) => parts.join(' '.repeat(GAP)).trimEnd();

/**
 * Column widths that fit `width`: the widest column gives way first, down to
 * its heading; columns that still don't fit are dropped from the right. With
 * no width to fit (output to a pipe or file), every column is as wide as its
 * widest cell, so nothing is cut.
 */
function fit(headings: string[], cells: string[][], width: number) {
  const floors = headings.map(h => Math.max(h.length, 6));
  const most = Number.isFinite(width) ? MAX_WIDTH : Number.POSITIVE_INFINITY;
  const widths = headings.map((h, i) => Math.min(most, Math.max(h.length, ...cells.map(row => row[i].length))));
  const total = () => widths.reduce((sum, w) => sum + w, 0) + GAP * (widths.length - 1);
  while (total() > width) {
    let widest = -1;
    for (const [i, w] of widths.entries()) {
      if (w > floors[i] && (widest < 0 || w > widths[widest])) widest = i;
    }
    if (widest < 0) {
      if (widths.length === 1) {
        widths[0] = Math.max(1, width);
        break;
      }
      widths.pop();
    } else {
      widths[widest] -= 1;
    }
  }
  return widths;
}

export interface TableInput {
  headings: string[];
  /** Cell text, one array per row, one entry per heading. */
  cells: string[][];
  /** Columns aligned right. */
  numeric?: boolean[];
  /** Columns printed muted, such as dates. */
  muted?: boolean[];
  /** Columns of paths, cut in the middle so each keeps the folder it names. */
  paths?: boolean[];
}

/**
 * Rows under muted headings and a rule, fitted to `width`: the widest column
 * gives way first, and columns that still don't fit are dropped from the
 * right; `hidden` names them.
 */
export function table({ headings, cells, numeric = [], muted = [], paths = [] }: TableInput, t: Tokens, width: number) {
  const widths = fit(headings, cells, width);
  const cell = (text: string, i: number) => {
    const cut = paths[i] ? truncatePath(text, widths[i]) : truncate(text, widths[i]);
    return numeric[i] ? cut.padStart(widths[i]) : cut.padEnd(widths[i]);
  };
  const lines = [
    t.muted(join(widths.map((_, i) => cell(headings[i], i)))),
    t.muted(join(widths.map(w => glyphs.rule.repeat(w)))),
    ...cells.map(row => join(widths.map((_, i) => muted[i] ? t.muted(cell(row[i], i)) : cell(row[i], i)))),
  ];
  return { lines, hidden: headings.slice(widths.length) };
}
