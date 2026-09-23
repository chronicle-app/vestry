import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const bin = fileURLToPath(new URL('../bin/vestry.js', import.meta.url));
let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'vestry-cli-')); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [bin, ...args, '--json', '--quiet', '--home', join(cwd, 'home')], { cwd, encoding: 'utf8' }));

it('supports help from an unrelated working directory', () => {
  expect(execFileSync(process.execPath, [bin, '--help'], { cwd, encoding: 'utf8' })).toContain('vestry cp PACKAGE DESTINATION');
});

it('rejects wrong package paths before Finder cleanup or a recovery record', async () => {
  const folder = join(cwd, 'ordinary'); await mkdir(folder);
  await writeFile(join(folder, '.DS_Store'), 'keep');
  const file = join(cwd, 'file'); await writeFile(file, 'keep');
  for (const [path, code, message] of [
    [join(cwd, 'missing'), 4, 'Path not found:'],
    [folder, 2, 'Not a Vestry package:'],
    [file, 2, 'Not a package folder:'],
  ] as const) {
    const result = spawnSync(process.execPath, [bin, 'pack', path, '--json', '--home', join(cwd, 'home')], { cwd, encoding: 'utf8' });
    expect(result.status, result.stdout).toBe(code);
    expect(JSON.parse(result.stdout).error.message).toContain(message);
    expect(result.stdout).not.toContain('Cannot establish which Finder');
  }
  expect(run('recover').operations).toEqual([]);
  expect(await readFile(join(folder, '.DS_Store'), 'utf8')).toBe('keep');
});

it('seals, inspects, packs, unpacks and verifies using relative paths', async () => {
  await writeFile(join(cwd, 'original.txt'), 'keep these bytes');
  run('gather', 'original.txt', '--into', 'draft');
  run('describe', 'draft', '--description', 'Test description');
  const sealed = run('create', 'draft', '--from-draft', '--output', 'bag');
  expect(run('inspect', 'bag').metadata.notes).toContain('Test description');
  expect(run('pack', 'bag', '--output', 'packed', '--compress', '--zip64').packageDigest).toBe(sealed.packageDigest);
  expect(run('unpack', 'packed', '--output', 'restored').packageDigest).toBe(sealed.packageDigest);
  expect(run('verify', 'restored').packageDigest).toBe(sealed.packageDigest);
  expect(await readFile(join(cwd, 'original.txt'), 'utf8')).toBe('keep these bytes');
});

it('returns structured usage errors without progress on stdout', () => {
  const result = spawnSync(process.execPath, [bin, 'seal', 'file', '--json'], { cwd, encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).error.code).toBe('INVALID_ARGUMENT');
  expect(result.stderr).toBe('');
});

it('refuses reversed conversions and preserves existing destinations', async () => {
  await writeFile(join(cwd, 'original'), 'keep');
  run('gather', 'original', '--into', 'draft'); run('describe', 'draft', '--description', 'Notes');
  run('create', 'draft', '--from-draft', '--output', 'bag');
  const wrong = spawnSync(process.execPath, [bin, 'unpack', 'bag', '--output', 'other', '--json', '--home', join(cwd, 'home')], { cwd, encoding: 'utf8' });
  expect(wrong.status).toBe(5);
  expect(JSON.parse(wrong.stdout).error.message).toContain('already expanded');
  const exists = spawnSync(process.execPath, [bin, 'create', 'draft', '--from-draft', '--output', 'bag', '--home', join(cwd, 'home')], { cwd, encoding: 'utf8' });
  expect(exists.status).toBe(5);
  expect(run('inspect', 'bag').metadata.notes).toContain('Notes');
});

it('emits parseable events and rejects incompatible output flags', async () => {
  await writeFile(join(cwd, 'original'), 'keep');
  const events = execFileSync(process.execPath, [bin, 'gather', 'original', '--into', 'draft', '--events', '--home', join(cwd, 'home')], { cwd, encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line));
  expect(events.at(-1).type).toBe('result');
  expect(events.every(event => event.schemaVersion === 1)).toBe(true);
  expect(events.some(event => event.phase === 'verified')).toBe(true);
  const invalid = spawnSync(process.execPath, [bin, '--json', '--events'], { cwd, encoding: 'utf8' });
  expect(invalid.status).toBe(2); expect(JSON.parse(invalid.stdout).error.code).toBe('INVALID_ARGUMENT');
});

it('uses exit codes 3 and 4 for corruption and unavailable input', async () => {
  await writeFile(join(cwd, 'original'), 'keep');
  run('gather', 'original', '--into', 'draft'); run('describe', 'draft', '--description', 'Notes'); run('create', 'draft', '--from-draft', '--output', 'bag', '--packed');
  await writeFile(join(cwd, 'bag/README.txt'), 'tampered');
  const check = (path: string) => spawnSync(process.execPath, [bin, 'verify', path, '--json', '--home', join(cwd, 'home')], { cwd, encoding: 'utf8' });
  expect(check('bag').status).toBe(3); expect(check('missing').status).toBe(4);
});

it('plans without creating output or a workspace', async () => {
  const plan = run('gather', 'some-source', '--into', 'draft', '--plan');
  expect(plan.status).toBe('planned');
  await expect(access(join(cwd, 'home'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('supports editor commands while keeping machine stdout clean', async () => {
  await writeFile(join(cwd, 'original'), 'keep'); run('gather', 'original', '--into', 'draft');
  const editor = join(cwd, 'editor.cjs');
  await writeFile(editor, "require('fs').writeFileSync(process.argv[2], 'Edited title\\nUnknown dates\\n'); console.log('editor output');");
  const edited = spawnSync(process.execPath, [bin, 'describe', 'draft', '--edit', '--json'], { cwd, encoding: 'utf8', env: { ...process.env, VISUAL: `${process.execPath} ${editor}` } });
  expect(edited.status, edited.stderr).toBe(0);
  expect(JSON.parse(edited.stdout).readme).toContain('Edited title');
  expect(edited.stderr).toContain('editor output');
  run('create', 'draft', '--from-draft', '--output', 'bag');
  expect(run('show', 'bag').metadata.notes).toContain('Edited title');
  expect(await readFile(join(cwd, 'bag/bag-info.txt'), 'utf8')).not.toContain('External-Description');
});

it('handles SIGINT with exit 130 and a recoverable operation record', async () => {
  await writeFile(join(cwd, 'original'), Buffer.alloc(16 * 1024 * 1024));
  run('gather', 'original', '--into', 'draft'); run('describe', 'draft', '--description', 'Notes');
  const child = spawn(process.execPath, [bin, 'create', 'draft', '--from-draft', '--output', 'bag', '--events', '--home', join(cwd, 'home')], { cwd });
  let stdout = '', sent = false;
  child.stdout.on('data', chunk => { stdout += chunk; if (!sent && stdout.includes('"phase":"building"')) { sent = true; child.kill('SIGINT'); } });
  const status = await new Promise<number | null>(resolve => child.on('close', resolve));
  expect(sent).toBe(true); expect(status).toBe(130);
  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(events.at(-1).error.code).toBe('INTERRUPTED');
  expect(run('recover').operations.some((op: { status: string }) => op.status === 'interrupted')).toBe(true);
});

it('registers aliases and manages pinned offline copies through the CLI', async () => {
  await writeFile(join(cwd, 'original'), 'keep');
  run('gather', 'original', '--into', 'draft'); run('describe', 'draft', '--description', 'Notes');
  const sealed = run('create', 'draft', '--from-draft', '--output', 'bag');
  expect(run('register', 'bag', '--as', 'example').aliases).toEqual(['example']);
  expect(run('verify', sealed.packageDigest.slice(0, -48)).packageDigest).toBe(sealed.packageDigest);
  const pinned = run('cache', 'add', 'example', '--pin'); expect(pinned.pinned).toBe(true);
  await rename(join(cwd, 'bag'), join(cwd, 'disconnected'));
  expect(run('verify', 'example', '--offline').packageDigest).toBe(sealed.packageDigest);
  expect(run('locate', 'example', '--offline').locations.some((l: { availability: string }) => l.availability === 'not-checked-offline')).toBe(true);
  expect(run('cache', 'list').copies[0].pinned).toBe(true);
  expect(run('history', 'example').operations.length).toBeGreaterThan(1);
  run('cache', 'unpin', 'example', '--offline'); run('cache', 'evict', 'example');
  expect(run('cache', 'list').copies).toEqual([]);
});

it('prioritizes an existing path over an alias and supports explicit location selection', async () => {
  await writeFile(join(cwd, 'original'), 'keep'); run('gather', 'original', '--into', 'draft'); run('describe', 'draft', '--description', 'First');
  const first = run('create', 'draft', '--from-draft', '--output', 'bag'); run('register', 'bag', '--as', 'example');
  run('describe', 'draft', '--description', 'Second'); await writeFile(join(cwd, 'draft/data/extra'), 'Another revision'); const second = run('create', 'draft', '--from-draft', '--output', 'example');
  expect(run('verify', 'example').packageDigest).toBe(second.packageDigest);
  const packed = run('pack', first.packageDigest, '--location', join(cwd, 'bag'), '--output', 'packed');
  expect(packed.packageDigest).toBe(first.packageDigest);
  expect(run('verify', 'bag').representation).toBe('expanded');
});
