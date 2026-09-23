import { emitKeypressEvents, type Key } from 'node:readline';
import { VestryError } from './errors.js';

export interface CopyChoice { path: string; detail?: string }
const safe = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
// Conservative width keeps wide Unicode paths from wrapping over the menu.
function fit(value: string, columns: number): string {
  const chars = [...safe(value)];
  const width = (s: string[]) => s.reduce((n, c) => n + (c.codePointAt(0)! > 255 ? 2 : 1), 0);
  if (width(chars) <= columns) return chars.join('');
  const left: string[] = [], right: string[] = [];
  while (chars.length && width(left) + width(right) + 4 < columns) {
    if (left.length <= right.length) left.push(chars.shift()!); else right.unshift(chars.pop()!);
  }
  return left.join('') + '…' + right.join('');
}

/** TTY-only selector; machine-mode admission remains the caller's responsibility. */
export async function chooseCopy(choices: CopyChoice[], options: {
  signal?: AbortSignal; color?: boolean; input?: NodeJS.ReadStream; output?: NodeJS.WriteStream;
} = {}): Promise<string> {
  const input = options.input ?? process.stdin, output = options.output ?? process.stderr;
  if (!choices.length) throw new Error('No copies available to select.');
  options.signal?.throwIfAborted();
  const wasRaw = !!input.isRaw, wasPaused = input.readableFlowing !== true;
  let selected = 0, lines = 0;
  const erase = () => { if (lines) output.write(`\x1b[${lines}A\r\x1b[0J`); lines = 0; };
  const render = () => {
    erase();
    const width = Math.max(12, (output.columns || 80) - 4);
    const count = Math.max(1, Math.min(6, (output.rows || 24) - 5, choices.length));
    const start = Math.max(0, Math.min(selected - Math.floor(count / 2), choices.length - count));
    const rows = [fit('Choose a copy · ↑/↓ move · Enter select · Esc cancel', width)];
    for (let i = start; i < start + count; i++) {
      const label = fit(`${i === selected ? '›' : ' '} ${choices[i].path}`, width);
      rows.push(options.color && i === selected ? `\x1b[36;1m${label}\x1b[0m` : label);
    }
    rows.push(fit(`${selected + 1}/${choices.length} · ${choices[selected].detail ?? 'Registered copy'}`, width));
    output.write(rows.join('\n') + '\n'); lines = rows.length;
  };
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      input.removeListener('keypress', keypress); input.removeListener('end', cancel); input.removeListener('error', fail);
      output.removeListener('resize', render); options.signal?.removeEventListener('abort', cancel);
      input.setRawMode(wasRaw); if (wasPaused) input.pause();
      erase(); output.write('\x1b[?25h');
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const cancel = () => fail(new VestryError('INTERRUPTED', 'Copy selection cancelled. No operation started.', 130));
    const keypress = (_text: string, key: Key = {}) => {
      if (key.name === 'escape' || key.ctrl && ['c', 'd'].includes(key.name ?? '')) { cancel(); return; }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup(); output.write(`Selected copy: ${safe(choices[selected].path)}\n`); resolve(choices[selected].path); return;
      }
      if (key.name === 'up') selected = (selected + choices.length - 1) % choices.length;
      else if (key.name === 'down') selected = (selected + 1) % choices.length;
      else if (key.name === 'home') selected = 0;
      else if (key.name === 'end') selected = choices.length - 1;
      else return;
      render();
    };
    emitKeypressEvents(input);
    input.on('keypress', keypress); input.once('end', cancel); input.once('error', fail);
    output.on('resize', render); options.signal?.addEventListener('abort', cancel, { once: true });
    input.setRawMode(true); input.resume(); output.write('\x1b[?25l'); render();
  });
}
