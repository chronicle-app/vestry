import { afterEach, beforeEach, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture, type Member } from './zip-fixture.js';
import { createPackage } from '../src/locations.js';
import { canonical, exists } from '../src/fs-util.js';
import { verify } from '../src/package.js';
import { checkOutput, convertPackage } from '../src/workflow.js';
import { listOperations, recover, save, type Context } from '../src/operations.js';
import { readRegistry } from '../src/registry.js';

let root: string, source: string, destination: string, context: Context;
const bytes = fixture([
  { name: 'export/', data: Buffer.alloc(0), mode: 0o040755 },
  { name: 'export/posts.json', data: Buffer.from('{"posts":[]}'), deflate: true },
  { name: 'export/photos/café.jpg', data: Buffer.from([1, 2, 3]) },
  { name: '.hidden', data: Buffer.from('preserved') },
]);
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-zip-create-')));
  source = join(root, 'export.zip'); destination = join(root, 'export'); context = { home: join(root, 'home') };
  await writeFile(source, bytes);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('adopts exact ZIP bytes and member paths, registers the alias, and unpacks with identical identity', async () => {
  const original = await lstat(source);
  const result = await createPackage(source, { ...context, description: 'Export', alias: 'example' });
  expect(result).toMatchObject({ path: destination, mainLocation: destination, representation: 'packed', payloadFiles: 3, sourceRetained: false, sourceMoved: true });
  expect(await exists(source)).toBe(false);
  expect((await lstat(join(destination, 'data.zip'))).ino).toBe(original.ino);
  expect(await readFile(join(destination, 'data.zip'))).toEqual(bytes);
  expect(await readdir(destination)).toEqual(expect.not.arrayContaining(['data', 'export']));
  expect(await readFile(join(destination, 'manifest-sha256.txt'), 'utf8')).toContain('data/export/posts.json');
  const state = await readRegistry(context);
  expect(state.aliases.example).toBe(result.packageDigest);
  expect(state.packages[result.packageDigest as string].mainLocation).toBe(destination);
  const expanded = join(root, 'expanded');
  const unpacked = await convertPackage(destination, expanded, 'expanded', context);
  expect(unpacked.packageDigest).toBe(result.packageDigest);
  expect(await readFile(join(expanded, 'data/export/posts.json'), 'utf8')).toBe('{"posts":[]}');
});

it('supports an explicit output and uppercase extension, refusing existing destinations', async () => {
  const uppercase = join(root, 'other.ZIP'); await writeFile(uppercase, bytes);
  const output = join(root, 'chosen');
  await createPackage(uppercase, { ...context, description: 'Chosen', output });
  expect((await verify(output)).representation).toBe('packed');
  await mkdir(destination);
  await expect(createPackage(source, { ...context, description: 'Conflict' })).rejects.toMatchObject({ exitCode: 5 });
  expect(await readdir(destination)).toEqual([]);
  expect(await readFile(source)).toEqual(bytes);
});

it('accepts empty ZIPs as empty payloads', async () => {
  await writeFile(source, fixture([]));
  expect(await createPackage(source, { ...context, description: 'Empty' })).toMatchObject({ payloadFiles: 0, payloadBytes: '0' });
});

const invalid: [string, Member[]][] = [
  ['traversal', [{ name: '../escape' }]],
  ['duplicate paths', [{ name: 'a' }, { name: 'a' }]],
  ['symlink', [{ name: 'link', mode: 0o120777 }]],
  ['encryption', [{ name: 'secret', flags: 0x801 }]],
  ['CRC corruption', [{ name: 'bad', crc: 0 }]],
  ['path conflicts', [{ name: 'a' }, { name: 'a/b' }]],
];
for (const [name, members] of invalid) it(`rejects ${name} without publishing or changing source bytes`, async () => {
  const bad = fixture(members); await writeFile(source, bad);
  await expect(createPackage(source, { ...context, description: 'Unsafe' })).rejects.toMatchObject({ exitCode: 3 });
  expect(await exists(destination)).toBe(false);
  expect(await readFile(source)).toEqual(bad);
  const op = (await listOperations(context))[0];
  await recover(op.id, checkOutput, context, true);
  expect(await readFile(source)).toEqual(bad);
});

for (const phase of ['building', 'verified', 'relocated', 'reserved', 'published']) it(`recovers ZIP creation after SIGKILL at ${phase}`, async () => {
  const child = spawnSync(process.execPath, [resolve('dist/test/helpers/location-worker.js'), 'create', source, destination, context.home!, phase], { encoding: 'utf8', timeout: 15000 });
  expect(child.signal, child.stderr).toBe('SIGKILL');
  const op = (await listOperations(context))[0]; expect(op.kind).toBe('import-zip');
  await recover(op.id, checkOutput, context, phase === 'building');
  expect(await exists(source)).toBe(phase === 'building');
  if (phase !== 'building') {
    const verified = await verify(destination);
    expect((await readRegistry(context)).aliases['crash-fixture']).toBe(verified.packageDigest);
    expect(await readFile(join(destination, 'data.zip'))).toEqual(bytes);
  } else expect(await exists(destination)).toBe(false);
});

it('plans the actual ZIP destination without writes, then creates through the CLI', () => {
  const args = ['bin/vestry.js', 'create', source, '--description', 'CLI ZIP', '--home', context.home!, '--json', '--quiet'];
  const plan = spawnSync(process.execPath, [...args, '--plan'], { encoding: 'utf8' });
  expect(plan.status, plan.stdout).toBe(0);
  expect(JSON.parse(plan.stdout)).toMatchObject({ writes: [destination, context.home], moves: [{ from: source, to: join(destination, 'data.zip') }], deletes: [] });
  const created = spawnSync(process.execPath, args, { encoding: 'utf8' });
  expect(created.status, created.stdout).toBe(0);
  expect(JSON.parse(created.stdout)).toMatchObject({ representation: 'packed', path: destination });
});

it('can read a ZIP inside an existing package using a separate output, leaving that package unchanged', async () => {
  const folder = join(root, 'outer'); await mkdir(folder); await writeFile(join(folder, 'export.zip'), bytes);
  const outer = await createPackage(folder, { ...context, description: 'Outer', keepZip: true });
  const nested = join(folder, 'data/export.zip');
  await expect(createPackage(nested, { ...context, description: 'Inner' })).rejects.toMatchObject({ exitCode: 5 });
  await createPackage(nested, { ...context, description: 'Inner', output: destination });
  expect((await verify(folder)).packageDigest).toBe(outer.packageDigest);
  expect((await verify(destination)).payloadFiles).toBe(3);
});

it('detects ZIP plus Finder metadata, preserving Finder bytes separately from packed contents', async () => {
  const folder = join(root, 'wrapper'); await mkdir(folder); await writeFile(join(folder, 'export.zip'), bytes);
  await writeFile(join(folder, '.DS_Store'), 'Finder folder metadata');
  context.quarantined = [];
  await expect(createPackage(folder, context)).rejects.toMatchObject({ code: 'ZIP_PAYLOAD_CHOICE' });
  expect(await readFile(join(folder, 'export.zip'))).toEqual(bytes);
  const result = await createPackage(folder, { ...context, zipContents: true });
  expect(result).toMatchObject({ path: folder, representation: 'packed', payloadFiles: 3 });
  expect(await readFile(join(folder, 'data.zip'))).toEqual(bytes);
  expect(await exists(join(folder, 'data'))).toBe(false);
  expect((await verify(folder)).packageDigest).toBe(result.packageDigest);
  expect(context.quarantined).toHaveLength(1);
  expect(await readFile(join(context.quarantined![0].directory, 'files/.DS_Store'), 'utf8')).toBe('Finder folder metadata');
});
it('keeps ZIP as one file when requested and refuses to omit sibling files', async () => {
  const folder = join(root, 'wrapper'); await mkdir(folder); await writeFile(join(folder, 'export.zip'), bytes);
  await writeFile(join(folder, 'notes.txt'), 'Keep this too');
  await expect(createPackage(folder, { ...context, zipContents: true })).rejects.toMatchObject({ exitCode: 2 });
  expect(await readFile(join(folder, 'notes.txt'), 'utf8')).toBe('Keep this too');
  await rm(join(folder, 'notes.txt'));
  expect(await createPackage(folder, { ...context, keepZip: true })).toMatchObject({ payloadFiles: 1, representation: 'expanded' });
  expect(await readFile(join(folder, 'data/export.zip'))).toEqual(bytes);
});
it('resumes ZIP folder staging by matching the unchanged container to the original', async () => {
  const folder = join(root, 'wrapper'); await mkdir(folder); await writeFile(join(folder, 'export.zip'), bytes);
  await writeFile(join(folder, '.DS_Store'), 'Finder metadata during retry');
  context.quarantined = [];
  await expect(createPackage(folder, { ...context, zipContents: true, onPhase: phase => { if (phase === 'verified') throw new Error('Stop'); } })).rejects.toThrow();
  const op = (await listOperations(context)).find(op => op.kind === 'create')!;
  op.phase = 'building'; delete op.expected; delete op.result; await save(context.home!, op);
  expect(await createPackage(folder, context)).toMatchObject({ resumed: true, representation: 'packed', payloadFiles: 3 });
  expect(await readFile(join(folder, 'data.zip'))).toEqual(bytes);
});
it('exposes the choice and a read-only plan to scripts', async () => {
  const folder = join(root, 'wrapper'); await mkdir(folder); await writeFile(join(folder, 'export.zip'), bytes);
  const cli = (...args: string[]) => spawnSync(process.execPath, ['bin/vestry.js', 'create', folder, ...args, '--json', '--home', context.home!], { encoding: 'utf8' });
  expect(JSON.parse(cli().stdout).error.code).toBe('ZIP_PAYLOAD_CHOICE');
  expect(cli('--zip-contents', '--plan').status).toBe(0);
  expect(await readFile(join(folder, 'export.zip'))).toEqual(bytes);
  const created = cli('--zip-contents'); expect(created.status, created.stdout).toBe(0);
  expect(JSON.parse(created.stdout)).toMatchObject({ representation: 'packed', payloadFiles: 3 });
});

it('retains files added after the single-ZIP choice but before the source snapshot', async () => {
  const folder = join(root, 'wrapper'); await mkdir(folder); await writeFile(join(folder, 'export.zip'), bytes);
  await expect(createPackage(folder, { ...context, zipContents: true, onActivity: message => {
    if (message === 'Reading original files before copying') writeFileSync(join(folder, 'new-note.txt'), 'Never omit me');
  } })).rejects.toThrow('contents changed');
  expect(await readFile(join(folder, 'new-note.txt'), 'utf8')).toBe('Never omit me');
  expect(await readFile(join(folder, 'export.zip'))).toEqual(bytes);
});

it('does not ignore a symlink or directory named .DS_Store', async () => {
  const folder = join(root, 'wrapper'); await mkdir(folder); await writeFile(join(folder, 'export.zip'), bytes);
  await symlink(source, join(folder, '.DS_Store'));
  await expect(createPackage(folder, { ...context, zipContents: true })).rejects.toMatchObject({ exitCode: 2 });
  await rm(join(folder, '.DS_Store')); await mkdir(join(folder, '.DS_Store'));
  await expect(createPackage(folder, { ...context, zipContents: true })).rejects.toMatchObject({ exitCode: 2 });
  expect(await readFile(join(folder, 'export.zip'))).toEqual(bytes);
});

it('hashes ZIP bytes during copy, keeping only one separate source checksum pass', async () => {
  const activity: { message: string; bytes?: string }[] = [];
  const result = await createPackage(source, { ...context, output: destination, onActivity: (message, bytes) => activity.push({ message, bytes }) });
  expect(activity.filter(event => event.message === `Reading ZIP: ${source}` && event.bytes === '0')).toHaveLength(1);
  expect(activity.some(event => event.message === 'Copying and checksumming ZIP' && event.bytes === String(bytes.length))).toBe(true);
  expect(result.timings).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'Verify staged package', seconds: expect.any(Number) })]));
  expect(await readFile(join(destination, 'data.zip'))).toEqual(bytes);
});
it('refuses publication when the source changes during the streaming copy', async () => {
  let changed = false;
  await expect(createPackage(source, { ...context, output: destination, onActivity: (message, copied) => {
    if (!changed && message === 'Copying and checksumming ZIP' && copied !== '0') {
      changed = true; writeFileSync(source, 'Changed source');
    }
  } })).rejects.toThrow('changed while copying');
  expect(await readFile(source, 'utf8')).toBe('Changed source');
  expect(await exists(destination)).toBe(false);
});
it('cancels the streaming copy without publishing or changing the original', async () => {
  const controller = new AbortController();
  await expect(createPackage(source, { ...context, output: destination, signal: controller.signal, onActivity: (message, copied) => {
    if (message === 'Copying and checksumming ZIP' && copied !== '0') controller.abort();
  } })).rejects.toThrow();
  expect(await readFile(source)).toEqual(bytes);
  expect(await exists(destination)).toBe(false);
});

it('refuses discard after ZIP relocation and resumes without losing the sole archive', async () => {
  await expect(createPackage(source, { ...context, onPhase: phase => { if (phase === 'relocated') throw new Error('Stop after rename'); } })).rejects.toThrow();
  const op = (await listOperations(context))[0];
  // Simulate rename succeeding before its relocated checkpoint was persisted.
  op.phase = 'verified'; await save(context.home!, op);
  expect(await exists(source)).toBe(false);
  await expect(recover(op.id, checkOutput, context, true)).rejects.toThrow('discard cannot remove');
  expect(await readFile(join(op.staging!, 'data.zip'))).toEqual(bytes);
  expect(await createPackage(source, context)).toMatchObject({ resumed: true, sourceMoved: true });
  expect(await readFile(join(destination, 'data.zip'))).toEqual(bytes);
});
it('retains a source changed after manifest preparation', async () => {
  await expect(createPackage(source, { ...context, onPhase: async phase => {
    if (phase === 'verified') await writeFile(source, 'Changed after preparation');
  } })).rejects.toThrow('changed or was replaced');
  expect(await readFile(source, 'utf8')).toBe('Changed after preparation');
  expect(await exists(destination)).toBe(false);
});
it('can discard prepared metadata before the archive moves', async () => {
  await expect(createPackage(source, { ...context, onPhase: phase => { if (phase === 'verified') throw new Error('Stop'); } })).rejects.toThrow();
  const op = (await listOperations(context))[0];
  await recover(op.id, checkOutput, context, true);
  expect(await readFile(source)).toEqual(bytes);
  expect(await exists(op.staging!)).toBe(false);
});
