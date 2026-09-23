import { expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { chooseCopy } from '../src/copy-picker.js';
function terminal() {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(value: boolean) { this.isRaw = value; return this; } });
  const output = Object.assign(new PassThrough(), { columns: 120, rows: 24 });
  let text = ''; output.on('data', chunk => { text += chunk; });
  return { input, output, options: { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream }, text: () => text };
}
it('selects with arrow keys and Enter, restoring the terminal', async () => {
  const t = terminal();
  const selected = chooseCopy([{ path: '/local/archive', detail: 'Main copy · packed' }, { path: '/network/archive', detail: 'Additional copy · expanded' }], t.options);
  expect(t.input.isRaw).toBe(true);
  t.input.write('\x1b[B'); t.input.write('\r');
  expect(await selected).toBe('/network/archive');
  expect(t.input.isRaw).toBe(false);
  expect(t.input.isPaused()).toBe(true);
  expect(t.input.listenerCount('keypress')).toBe(0);
  expect(t.text()).toContain('Additional copy · expanded');
  expect(t.text()).toContain('Selected copy: /network/archive');
  expect(t.text()).toContain('\x1b[?25h');
});
it('cancels on Ctrl-C and restores raw mode and cursor', async () => {
  const t = terminal(); const selected = chooseCopy([{ path: '/local' }], t.options);
  const rejected = expect(selected).rejects.toMatchObject({ code: 'INTERRUPTED', exitCode: 130 });
  t.input.write('\x03'); await rejected;
  expect(t.input.isRaw).toBe(false); expect(t.input.listenerCount('keypress')).toBe(0);
  expect(t.text()).not.toContain('Selected copy:'); expect(t.text()).toContain('\x1b[?25h');
});
it('handles external cancellation and escapes control characters in paths', async () => {
  const t = terminal(), controller = new AbortController();
  const selected = chooseCopy([{ path: '/bad\n\x1b[31m' }], { ...t.options, signal: controller.signal });
  const rejected = expect(selected).rejects.toMatchObject({ exitCode: 130 });
  expect(t.text()).toContain('/bad\\x0a\\x1b[31m');
  controller.abort(); await rejected;
  expect(t.input.isRaw).toBe(false);
});
