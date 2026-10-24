/** A role's look: text in, the same text styled out. */
export type Style = (text: string) => string;

/**
 * Color roles. Color carries meaning only: status (success, danger,
 * warning), emphasis (strong), de-emphasis (muted), one accent for live
 * elements, and cyan for something to type.
 */
export interface Tokens {
  accent: Style;
  success: Style;
  danger: Style;
  warning: Style;
  muted: Style;
  strong: Style;
  /**
   * A flag or command inside a sentence, written as a `code span`: cyan with
   * color; without, the backticks stay, since they're all that mark it.
   */
  code: Style;
  /** A command on a line of its own, to copy: cyan with color, bare without. */
  command: Style;
}

export type ColorMode = 'auto' | 'always' | 'never';

/** Whether to color a stream: `--color` first, then `NO_COLOR` and `FORCE_COLOR`, then whether it's a terminal. */
export function colorEnabled(mode: ColorMode, tty: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (mode !== 'auto') return mode === 'always';
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  return tty && env.TERM !== 'dumb';
}

const sgr = (open: string, close: string): Style => text => text ? `\x1b[${open}m${text}\x1b[${close}m` : '';
const bare: Style = text => text;

/** Tokens that style nothing: for pipes and files, and under `NO_COLOR`. */
export const plainTokens: Tokens = {
  accent: bare, success: bare, danger: bare, warning: bare, muted: bare, strong: bare,
  code: text => `\`${text}\``,
  command: bare,
};

/** The color roles, or none. The accent is Chronicle's brand red, #DE4F4F, or the nearest of 256 colors. */
export function tokens(color: boolean, env: NodeJS.ProcessEnv = process.env): Tokens {
  if (!color) return plainTokens;
  const truecolor = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '');
  return {
    accent: sgr(truecolor ? '38;2;222;79;79' : '38;5;167', '39'),
    success: sgr('32', '39'),
    danger: sgr('31', '39'),
    warning: sgr('33', '39'),
    muted: sgr('2', '22'),
    strong: sgr('1', '22'),
    code: sgr('36', '39'),
    command: sgr('36', '39'),
  };
}
