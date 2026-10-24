import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonical } from '../src/fs-util.js';
import { Terminal, colorEnabled } from '../src/terminal.js';

// Tests read what a command did from --json and --events, never from the
// text it prints: wording and layout change freely. What is checked of
// printed output is only what keeps a terminal safe and color where asked.
let root: string;
beforeEach(async () => { root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-terminal-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [resolve('bin/vestry.js'), ...args, '--home', join(root, 'home')], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: '0', ...env } });
const json = (args: string[]) => { const child = cli([...args, '--json']); return { ...child, result: JSON.parse(child.stdout) }; };
const events = (args: string[]) => cli([...args, '--events']).stdout.trim().split('\n').map(line => JSON.parse(line));

it('uses explicit color controls, NO_COLOR, and TTY defaults consistently', () => {
  expect(colorEnabled('auto', false, {})).toBe(false);
  expect(colorEnabled('auto', true, {})).toBe(true);
  expect(colorEnabled('auto', true, { NO_COLOR: '' })).toBe(false);
  expect(colorEnabled('always', false, { NO_COLOR: '1' })).toBe(true);
  expect(colorEnabled('never', true, { FORCE_COLOR: '1' })).toBe(false);
  expect(colorEnabled('auto', false, { FORCE_COLOR: '1' })).toBe(true);
});

it('answers help, an empty catalog, and mistakes with results a script can read', () => {
  expect(cli(['unpack', '--help']).status).toBe(0);
  expect(json(['list'])).toMatchObject({ status: 0, result: { command: 'list', packages: [] } });
  const error = json(['move', 'example']);
  expect(error.status).toBe(2);
  expect(error.result.error.code).toBe('INVALID_ARGUMENT');
  const typo = json(['lst']);
  expect(typo.status).toBe(2);
  expect(typo.result.error.hint).toContain('`vestry list`');
});

it('reports each stage of making a package, its contents, and the copy each command read', async () => {
  await mkdir(join(root, 'files')); await writeFile(join(root, 'files/note'), 'Example bytes');
  const made = events(['create', 'files', '--description', 'Notes', '--as', 'notes']);
  expect(made.filter(e => e.type === 'progress').map(e => e.phase)).toEqual(expect.arrayContaining(['planned', 'building', 'verified', 'published']));
  expect(made.at(-1)).toMatchObject({ type: 'result', result: { payloadFiles: 1, payloadBytes: '13' } });
  expect(json(['list']).result.packages[0]).toMatchObject({ payloadFiles: 1, payloadBytes: '13', aliases: ['notes'] });
  expect(json(['show', 'notes', '--offline']).result).toMatchObject({ payloadFiles: 1, payloadBytes: '13' });
  // An alias resolves to the copy's path, and the result names the path.
  const packed = json(['pack', 'notes']);
  expect(packed.status, packed.stdout).toBe(0);
  expect(packed.result).toMatchObject({ path: join(root, 'files'), representation: 'packed' });
  const quiet = cli(['verify', 'notes', '--quiet']);
  expect(quiet.status).toBe(0);
  expect(quiet.stderr).toBe('');
});

it('keeps raw escape codes off the terminal, and color only where asked', async () => {
  expect(cli(['list', '--color', 'always']).stdout).toContain('\x1b[');
  expect(cli(['list', '--color', 'never'], { FORCE_COLOR: '1' }).stdout).not.toContain('\x1b[');
  const forced = cli(['list', '--json', '--color', 'always'], { FORCE_COLOR: '1' });
  expect(JSON.parse(forced.stdout)).toMatchObject({ schemaVersion: 1, command: 'list', packages: [] });
  expect(forced.stderr).toBe('');
  expect(cli(['list', '--events', '--color', 'always'], { FORCE_COLOR: '1' }).stdout).not.toContain('\x1b[');
  // Text from a package or a path, printed or in a hint, can't drive the terminal.
  await mkdir(join(root, 'files')); await writeFile(join(root, 'files/note'), 'Example');
  expect(cli(['create', 'files', '--description', 'Title\x1b[2J', '--json', '--quiet']).status).toBe(0);
  const inspected = cli(['inspect', 'files', '--color', 'never', '--quiet']);
  expect(inspected.status).toBe(0);
  expect(inspected.stdout).not.toContain('\x1b');
  await mkdir(join(root, 'odd\x1b[2J')); await writeFile(join(root, 'odd\x1b[2J/note'), 'Example');
  expect(cli(['create', 'odd\x1b[2J', '--quiet']).status).toBe(0);
  const again = cli(['create', 'odd\x1b[2J', '--color', 'never']);
  expect(again.status).not.toBe(0);
  expect(again.stderr).not.toContain('\x1b');
});

it('stops the progress timer when a command ends', () => {
  vi.useFakeTimers();
  const originalTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const terminal = new Terminal('never');
  try {
    terminal.start('create /archive');
    terminal.activity('Reading: export.zip', '1048576', '4194304');
    vi.advanceTimersByTime(1200);
    expect(output).toHaveBeenCalled();
    terminal.stopActivity();
    const calls = output.mock.calls.length;
    vi.advanceTimersByTime(10000);
    expect(output.mock.calls.length).toBe(calls);
  } finally {
    terminal.stopActivity(); output.mockRestore(); vi.useRealTimers();
    if (originalTTY) Object.defineProperty(process.stderr, 'isTTY', originalTTY);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  }
});
