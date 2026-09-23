import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Terminal, colorEnabled, formatBytes } from '../src/terminal.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'vestry-terminal-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [resolve('bin/vestry.js'), ...args, '--home', join(root, 'home')], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: '0', ...env } });

it('uses explicit color controls, NO_COLOR, and TTY defaults consistently', () => {
  expect(colorEnabled('auto', false, {})).toBe(false);
  expect(colorEnabled('auto', true, {})).toBe(true);
  expect(colorEnabled('auto', true, { NO_COLOR: '' })).toBe(false);
  expect(colorEnabled('always', false, { NO_COLOR: '1' })).toBe(true);
  expect(colorEnabled('never', true, { FORCE_COLOR: '1' })).toBe(false);
  expect(colorEnabled('auto', false, { FORCE_COLOR: '1' })).toBe(true);
  expect(formatBytes('333077678')).toBe('317.6 MiB');
});

it('renders scoped help, a useful empty state, and actionable usage errors', () => {
  const help = cli(['unpack', '--help', '--color', 'never']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('Default: convert the selected copy in place');
  expect(help.stdout).not.toContain('vestry gather');
  const empty = cli(['list', '--no-color']);
  expect(empty.stdout).toContain('Nothing registered yet');
  expect(empty.stderr).toBe('');
  const error = cli(['move', 'example', '--color', 'never']);
  expect(error.status).toBe(2);
  expect(error.stderr).toContain('Check the command');
  expect(error.stderr).toContain('vestry move --help');
});

it('shows actual paths, stage progress and sizes; quiet keeps the result', async () => {
  await mkdir(join(root, 'files')); await writeFile(join(root, 'files/note'), 'Example bytes');
  const created = cli(['create', 'files', '--description', 'Notes', '--as', 'notes', '--color', 'never']);
  expect(created.status, created.stderr).toBe(0);
  expect(created.stdout).toContain('Package created');
  expect(created.stdout).toContain('1 files · 13 B');
  expect(created.stderr).toContain('Staged copy verified');
  for (const args of [['list'], ['show', 'notes']]) {
    const info = cli([...args, '--offline', '--no-color']);
    expect(info.status, info.stderr).toBe(0);
    expect(info.stdout).toMatch(/Files\s+1/);
    expect(info.stdout).toMatch(/Size\s+13 B · original files \(uncompressed\)/);
  }
  const listed = JSON.parse(cli(['list', '--json']).stdout);
  expect(listed.packages[0]).toMatchObject({ payloadFiles: 1, payloadBytes: '13' });
  const packed = cli(['pack', 'notes', '--color', 'never']);
  expect(packed.status, packed.stderr).toBe(0);
  expect(packed.stderr).toContain('Checking checksums');
  expect(packed.stderr).toContain('/files');
  expect(packed.stderr).not.toContain(join(root, 'notes'));
  const quiet = cli(['verify', 'notes', '--quiet', '--no-color']);
  expect(quiet.stdout).toContain('Integrity verified');
  expect(quiet.stderr).toBe('');
});

it('keeps machine output ANSI-free even with forced colors, and escapes terminal control text', async () => {
  const colored = cli(['list', '--color', 'always']);
  expect(colored.stdout).toContain('\x1b[');
  const plain = cli(['list', '--color', 'never'], { FORCE_COLOR: '1' });
  expect(plain.stdout).not.toContain('\x1b[');
  const json = cli(['list', '--json', '--color', 'always'], { FORCE_COLOR: '1' });
  expect(JSON.parse(json.stdout)).toMatchObject({ schemaVersion: 1, command: 'list', packages: [] });
  expect(json.stderr).toBe('');
  const events = cli(['list', '--events', '--color', 'always'], { FORCE_COLOR: '1' });
  expect(events.stdout).not.toContain('\x1b[');
  expect(events.stdout.trim().split('\n').map(line => JSON.parse(line)).at(-1).type).toBe('result');
  await mkdir(join(root, 'files')); await writeFile(join(root, 'files/note'), 'Example');
  const created = cli(['create', 'files', '--description', 'Title\x1b[2J', '--json', '--quiet']);
  expect(created.status, created.stdout).toBe(0);
  const inspected = cli(['inspect', 'files', '--color', 'never', '--quiet']);
  expect(inspected.stdout).toContain('Title\\x1b[2J');
  expect(inspected.stdout).not.toContain('\x1b');
});

it('animates elapsed time and byte progress while IO waits, then stops the timer', () => {
  vi.useFakeTimers();
  const originalTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const terminal = new Terminal('never');
  try {
    terminal.start('create', '/archive');
    expect(output.mock.calls.map(call => call[0]).join('')).toContain('Preparing');
    terminal.activity('Reading: export.zip', '1048576', '4194304');
    vi.advanceTimersByTime(1200);
    const rendered = output.mock.calls.map(call => call[0]).join('');
    expect(rendered).toContain('1 MiB / 4 MiB');
    expect(rendered).toContain('0:01 elapsed');
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

it('lists each copy under its content with main and availability labels', () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    new Terminal().result('list', { packages: [{ contentId: 'vestry-payload-v1:sha256:' + 'a'.repeat(64), aliases: [], mainLocation: '/local/archive', copySummary: '1 available · 1 missing', payloadFiles: 1, payloadBytes: '10', locations: [
      { path: '/local/archive', state: 'known', storage: 'external', representation: 'packed', availability: 'available' },
      { path: '/network/archive', state: 'known', storage: 'external', representation: 'expanded', availability: 'unavailable' },
    ] }] });
    const text = output.mock.calls.flat().join('');
    expect(text).toContain('├─ /local/archive'); expect(text).toContain('└─ /network/archive');
    expect(text).toContain('MAIN'); expect(text).toContain('packed'); expect(text).toContain('expanded');
    expect(text).toContain('1 available · 1 missing');
  } finally { output.mockRestore(); }
});
